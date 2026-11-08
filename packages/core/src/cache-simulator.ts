import { estimateTokenCost, type TokenPrice } from "./cost.js";
import type { BillableEvent } from "./savings-ledger.js";
import { approximateTokenCount, type TokenCounter } from "./token-reduction.js";

/**
 * Provider prompt-cache simulator.
 *
 * Prefix caching is the largest lever MESH has, and on a fixture it was worth 29
 * of 32 points. A claim that large cannot rest on a stub that simply says "the
 * prefix was cached". This models the published rules, including the ones that
 * make caching fail:
 *
 *   - a minimum cacheable prefix (1,024 tokens on both providers; 2,048 on
 *     Claude Haiku), below which nothing caches at all
 *   - longest EXACT prefix matching, so one changed character early in the
 *     prompt discards everything after it
 *   - hit granularity (OpenAI grants hits in 128-token increments)
 *   - a time to live measured from last use, so traffic spread thinly over time
 *     never accumulates a hit rate
 *   - a write premium where the provider charges one (Anthropic bills a cache
 *     write at 1.25x base for the 5-minute TTL, 2x for the hour)
 *
 * The TTL is the honest part. A simulation that assumes every repeat hits will
 * overstate caching badly for low-traffic workloads: with a 5-minute TTL and
 * requests ten minutes apart, the cache never pays for itself and the write
 * premium makes it worse than doing nothing. That outcome is reachable here.
 *
 * Sources: OpenAI's prompt-caching guide (automatic above 1,024 tokens, 128-token
 * increments, longest exact prefix, 5-10 minutes of inactivity up to an hour) and
 * Anthropic's (explicit breakpoints, 5-minute default TTL or 1 hour, writes at
 * 1.25x or 2x base, reads at 0.1x).
 */

export type CachePolicy = {
  name: string;
  /** Nothing below this caches at all. */
  minimumCacheableTokens: number;
  /** Hits are granted in whole multiples of this many tokens. */
  incrementTokens: number;
  /** Entry is dropped after this long without being used. */
  ttlSeconds: number;
  /** Charge for writing a prefix, as a multiple of the base input rate. */
  writeMultiplier: number;
  /** Charge for reading a cached prefix, as a multiple of the base input rate. */
  readMultiplier: number;
  /**
   * Seconds between a request that WRITES a prefix being sent and that
   * entry becoming visible to any other request. The documented provider
   * rule is that a cache entry exists only once the write's own response
   * has started (its headers have arrived) — not at the moment the write
   * was sent — so a request dispatched before that moment cannot see it and
   * must write the same prefix again, at the write rate, not read it.
   *
   * Omitted (the default on every policy below) means the old, instant-
   * availability assumption: every published figure measured before
   * tonight used that assumption, and every revisit gap in the catalogue
   * (>= 20s) is far above any realistic value this function would return,
   * so leaving it unset reproduces them exactly. Set it only to model a
   * workload where requests can genuinely race — concurrent sub-agent
   * fan-out dispatched within the same event-loop tick is the case that
   * matters; nothing else in the catalogue is fast enough to trigger it.
   */
  writeAvailabilityLatencySeconds?: (writtenPrefixTokens: number) => number;
};

/** Automatic, no write premium, hits in 128-token steps. */
export const OPENAI_CACHE: CachePolicy = {
  name: "openai-automatic",
  minimumCacheableTokens: 1_024,
  incrementTokens: 128,
  // 5-10 minutes of inactivity is documented; the shorter end is the honest one.
  ttlSeconds: 300,
  writeMultiplier: 1,
  readMultiplier: 0.1,
};

/** Explicit breakpoints, 5-minute TTL, writes at 1.25x base. */
export const ANTHROPIC_CACHE_5M: CachePolicy = {
  name: "anthropic-ephemeral-5m",
  minimumCacheableTokens: 1_024,
  incrementTokens: 1,
  ttlSeconds: 300,
  writeMultiplier: 1.25,
  readMultiplier: 0.1,
};

/**
 * Anthropic with NO cache_control placed: the cache is opt-in, so nothing
 * caches and every token bills at the full input rate. This is the measured
 * reality of unstamped Claude traffic (the first live export recorded a
 * five-turn agent with zero cache reads and zero writes), and therefore the
 * honest baseline for valuing a MESH-placed stamp.
 */
export const ANTHROPIC_NO_CACHE: CachePolicy = {
  name: "anthropic-uncached",
  minimumCacheableTokens: Number.MAX_SAFE_INTEGER,
  incrementTokens: 1,
  ttlSeconds: 0,
  writeMultiplier: 1,
  readMultiplier: 1,
};

/** The hour-long TTL, which doubles the write charge. */
export const ANTHROPIC_CACHE_1H: CachePolicy = {
  name: "anthropic-ephemeral-1h",
  minimumCacheableTokens: 1_024,
  incrementTokens: 1,
  ttlSeconds: 3_600,
  writeMultiplier: 2,
  readMultiplier: 0.1,
};

export type SimulatedRequest = {
  /** Seconds since the run began. Drives TTL expiry. */
  atSeconds: number;
  /** The exact prompt text the provider would see, in order. */
  prompt: string;
  /** Output tokens the model produced, for costing. */
  outputTokens: number;
};

export type SimulatedCall = {
  atSeconds: number;
  totalInputTokens: number;
  cachedInputTokens: number;
  writtenInputTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Why nothing was cached, when nothing was. */
  missReason?: "below-minimum" | "no-matching-prefix" | "expired" | "first-request" | "racing-write";
};

export type SimulationResult = {
  policy: string;
  calls: SimulatedCall[];
  totalCostUsd: number;
  /** What the same traffic would cost with caching unavailable. */
  uncachedCostUsd: number;
  savingUsd: number;
  savingPercent: number;
  totalInputTokens: number;
  cachedInputTokens: number;
  /** Share of input tokens served from cache. */
  hitRate: number;
  expiries: number;
  missReasons: Record<string, number>;
};

type Entry = { prompt: string; lastUsedAt: number; availableAt: number };

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

/**
 * Run a request stream against a cache policy and price it.
 *
 * Deliberately pessimistic where the published behaviour is a range: the
 * shorter documented TTL is used, and a prefix must clear the minimum AFTER
 * being rounded down to the policy's increment.
 */
export function simulateCache(
  requests: SimulatedRequest[],
  policy: CachePolicy,
  price: TokenPrice,
  options: { countTokens?: TokenCounter } = {},
): SimulationResult {
  if (requests.length === 0) throw new Error("A cache simulation needs at least one request.");
  if (policy.minimumCacheableTokens < 1 || policy.incrementTokens < 1) {
    throw new Error("Cache policy minimums and increments must be at least 1 token.");
  }
  const countTokens = options.countTokens ?? approximateTokenCount;

  // The policy's read and write rates are derived from the base input rate, so
  // a catalogue that already carries cached rates stays consistent with it.
  const cachedRate = price.cachedInputPerMillion ?? price.inputPerMillion * policy.readMultiplier;
  const writeRate = price.cacheWriteInputPerMillion ?? price.inputPerMillion * policy.writeMultiplier;

  const entries: Entry[] = [];
  const calls: SimulatedCall[] = [];
  const missReasons: Record<string, number> = {};
  let expiries = 0;

  const ordered = [...requests].sort((left, right) => left.atSeconds - right.atSeconds);

  for (const request of ordered) {
    // Drop anything not used within the TTL before looking for a match.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (request.atSeconds - entries[index]!.lastUsedAt > policy.ttlSeconds) {
        entries.splice(index, 1);
        expiries += 1;
      }
    }

    const totalInputTokens = countTokens(request.prompt);
    let cachedInputTokens = 0;
    let missReason: SimulatedCall["missReason"] | undefined;

    // Only entries already VISIBLE at this request's send time are usable —
    // an entry whose write has not yet reached first-response-start cannot
    // be read by a concurrent racer, however identical its prefix.
    const visibleEntries = entries.filter((entry) => entry.availableAt <= request.atSeconds);

    if (visibleEntries.length === 0) {
      missReason = entries.length === 0
        ? (calls.length === 0 ? "first-request" : "expired")
        // Entries exist (so this is not a cold start) but none has reached
        // first-response-start yet: a genuine racer, distinct from "expired".
        : "racing-write";
    } else {
      // Longest exact prefix across live, visible entries, as the providers describe.
      let bestChars = 0;
      let bestEntry: Entry | undefined;
      for (const entry of visibleEntries) {
        const shared = commonPrefixLength(entry.prompt, request.prompt);
        if (shared > bestChars) {
          bestChars = shared;
          bestEntry = entry;
        }
      }
      const sharedTokens = bestChars === 0 ? 0 : countTokens(request.prompt.slice(0, bestChars));
      // Rounded down to the policy's granularity before the minimum is applied.
      const granted = Math.floor(sharedTokens / policy.incrementTokens) * policy.incrementTokens;
      if (granted >= policy.minimumCacheableTokens) {
        cachedInputTokens = Math.min(granted, totalInputTokens);
        bestEntry!.lastUsedAt = request.atSeconds;
      } else {
        missReason = granted === 0 ? "no-matching-prefix" : "below-minimum";
      }
    }

    // A prefix long enough to cache is written when it was not already served.
    const writtenInputTokens = cachedInputTokens === 0 &&
      Math.floor(totalInputTokens / policy.incrementTokens) * policy.incrementTokens >=
        policy.minimumCacheableTokens
      ? Math.floor(totalInputTokens / policy.incrementTokens) * policy.incrementTokens
      : 0;

    const freshInputTokens = totalInputTokens - cachedInputTokens - writtenInputTokens;
    const costUsd =
      (freshInputTokens / 1_000_000) * price.inputPerMillion +
      (cachedInputTokens / 1_000_000) * cachedRate +
      (writtenInputTokens / 1_000_000) * writeRate +
      (request.outputTokens / 1_000_000) * price.outputPerMillion;

    if (missReason) missReasons[missReason] = (missReasons[missReason] ?? 0) + 1;
    calls.push({
      atSeconds: request.atSeconds,
      totalInputTokens,
      cachedInputTokens,
      writtenInputTokens,
      freshInputTokens,
      outputTokens: request.outputTokens,
      costUsd,
      ...(missReason === undefined ? {} : { missReason }),
    });

    // A written entry becomes visible to other requests only after its own
    // write latency; an entry nothing was written for (e.g. a pure read, or
    // a below-minimum prompt that can never cache) is available at once —
    // there is no write in flight for anyone else to race against.
    const availableAt = writtenInputTokens > 0
      ? request.atSeconds + (policy.writeAvailabilityLatencySeconds?.(writtenInputTokens) ?? 0)
      : request.atSeconds;
    entries.push({ prompt: request.prompt, lastUsedAt: request.atSeconds, availableAt });
    // Providers keep a bounded cache; holding every prompt forever would
    // overstate hit rates on long runs.
    if (entries.length > 64) entries.shift();
  }

  const totalCostUsd = calls.reduce((sum, call) => sum + call.costUsd, 0);
  const totalInputTokens = calls.reduce((sum, call) => sum + call.totalInputTokens, 0);
  const cachedInputTokens = calls.reduce((sum, call) => sum + call.cachedInputTokens, 0);
  const uncachedCostUsd = calls.reduce((sum, call) =>
    sum + estimateTokenCost(call.totalInputTokens, call.outputTokens, price), 0);

  return {
    policy: policy.name,
    calls,
    totalCostUsd,
    uncachedCostUsd,
    savingUsd: uncachedCostUsd - totalCostUsd,
    savingPercent: uncachedCostUsd === 0 ? 0 : ((uncachedCostUsd - totalCostUsd) / uncachedCostUsd) * 100,
    totalInputTokens,
    cachedInputTokens,
    hitRate: totalInputTokens === 0 ? 0 : cachedInputTokens / totalInputTokens,
    expiries,
    missReasons,
  };
}

/**
 * Context compaction, priced.
 *
 * An agent loop re-sends its whole transcript every turn, so the API bill grows
 * with the square of the session. Harnesses fight that by COMPACTING: at some
 * turn they throw the transcript away and replace it with a short summary, so
 * the prefix shrinks and growth restarts from a smaller base.
 *
 * The move is not free, and the cost that hides from a naive token count is the
 * one caching imposes. Prefix caching already defeats most of the quadratic tax
 * on its own: once a transcript is cached, every later turn READS it at 0.1x and
 * writes only the new tail. Compaction discards that cached prefix — the summary
 * does not match the bytes it replaced, so the longest-exact-prefix match
 * collapses to the stable system block, and everything after it is re-written at
 * the full (or write-premium) rate. That rewrite, plus the one-off summarisation
 * call that reads the transcript to produce the summary, is the price of
 * compaction. It only pays back if the session runs long enough afterwards for
 * the smaller prefix to save more than the rewrite cost.
 *
 * The counter-intuitive, and therefore worth-proving, result this models: under
 * a WARM cache and fast turns, compaction can be a net LOSS, because the thing
 * it shrinks was already being read at a tenth of its price. It wins when the
 * cache is cold — slow human-in-the-loop turns that expire the TTL, or traffic
 * with no cache_control placed at all — where the transcript really is re-sent
 * at full price every turn. Both regimes are reachable here by choice of policy
 * and turn spacing.
 */

export type AgentSessionSpec = {
  /** The stable system + tool block that leads every turn. Cached, never rewritten. */
  systemPromptTokens: number;
  /** How many model calls the session makes. */
  turns: number;
  /** New transcript appended before each turn (user message + tool results). */
  userTurnTokens: number;
  /** Model output each turn, which becomes input on the next turn. */
  assistantTurnTokens: number;
  /** Seconds between turns. Long gaps expire the cache TTL and change the verdict. */
  secondsPerTurn: number;
};

export type CompactionSpec = {
  /** The turn (1-based) whose prompt is the first to carry the summary. */
  atTurn: number;
  /** Size of the summary that replaces the discarded transcript. */
  summaryTokens: number;
  /**
   * Charge the one-off call that reads the transcript to write the summary.
   * Defaults to true; set false to isolate the cache-invalidation cost alone.
   */
  chargeSummarizationCall?: boolean;
};

export type CompactionEconomics = {
  compactionTurn: number;
  summaryTokens: number;
  /** The session run straight through, no compaction. */
  baseline: SimulationResult;
  /** The same session with the transcript compacted at `compactionTurn`. */
  withCompaction: SimulationResult;
  /**
   * The cache penalty of the compaction event, isolated from its size effect:
   * the compaction turn's actual cost minus what that same prompt would have
   * cost if every token had been served from cache. Always >= 0 — it is the
   * price of the prefix collapsing to the system block on that one turn.
   */
  cacheInvalidationCostUsd: number;
  /** Cost of the one-off call that reads the transcript to write the summary (0 if not charged). */
  summarizationCostUsd: number;
  /** baseline total minus compacted total. Positive means compaction paid off. */
  netSavingUsd: number;
  savingPercent: number;
  worthwhile: boolean;
  /**
   * Turns after the compaction point before compaction turns net-positive, or
   * null if it never does within the session's length.
   */
  breakEvenTurns: number | null;
};

/**
 * Deterministic text of approximately `targetTokens`, seeded so distinct
 * segments differ. Linear: it measures a sample once to get tokens-per-word
 * rather than re-counting a growing string on every append.
 */
function synthesize(targetTokens: number, seed: string, countTokens: TokenCounter): string {
  if (targetTokens <= 0) return "";
  const sampleCount = 50;
  const sample = Array.from({ length: sampleCount }, (_, i) => `${seed}${i.toString(36)}`).join(" ");
  const perWord = Math.max(countTokens(sample) / sampleCount, 0.5);
  const needed = Math.max(1, Math.ceil(targetTokens / perWord));
  const words = [`${seed}:`];
  for (let i = 0; i < needed; i += 1) words.push(`${seed}${i.toString(36)}`);
  return words.join(" ");
}

/** The stable, reusable pieces of a session, synthesised once and sliced per length. */
type SessionParts = { system: string; segments: string[]; summary: string };

function synthesizeParts(
  spec: AgentSessionSpec,
  summaryTokens: number,
  countTokens: TokenCounter,
): SessionParts {
  const perTurn = spec.userTurnTokens + spec.assistantTurnTokens;
  return {
    // Generated once and reused verbatim, so it stays an exact cacheable prefix.
    system: synthesize(spec.systemPromptTokens, "sys", countTokens),
    // Each turn appends a unique segment (user step + the model's own prior reply).
    segments: Array.from({ length: spec.turns }, (_, index) =>
      synthesize(perTurn, `seg${index}`, countTokens)),
    summary: summaryTokens > 0 ? synthesize(summaryTokens, "summary", countTokens) : "",
  };
}

type SessionBuild = {
  requests: SimulatedRequest[];
  /** Index into `requests` of the summarisation call, when one was added. */
  summarizationIndex: number | null;
};

function assembleSession(
  parts: SessionParts,
  spec: AgentSessionSpec,
  turns: number,
  compaction: CompactionSpec | undefined,
): SessionBuild {
  const requests: SimulatedRequest[] = [];
  let summarizationIndex: number | null = null;
  const chargeSummary = compaction ? compaction.chargeSummarizationCall !== false : false;

  for (let turn = 1; turn <= turns; turn += 1) {
    const atSeconds = (turn - 1) * spec.secondsPerTurn;

    // The summarisation call reads the transcript as it stands and emits the
    // summary. It runs just before the compacted turn and hits the warm prefix.
    if (compaction && chargeSummary && turn === compaction.atTurn) {
      summarizationIndex = requests.length;
      requests.push({
        atSeconds: atSeconds - spec.secondsPerTurn / 2,
        prompt: [parts.system, ...parts.segments.slice(0, turn - 1)].join("\n"),
        outputTokens: compaction.summaryTokens,
      });
    }

    let body: string[];
    if (compaction && turn >= compaction.atTurn) {
      // Summary stands in for turns before the compaction point; the transcript
      // regrows from there. The divergence right after `system` is what drops
      // the cached prefix down to the system block.
      body = [parts.system, parts.summary, ...parts.segments.slice(compaction.atTurn - 1, turn)];
    } else {
      body = [parts.system, ...parts.segments.slice(0, turn)];
    }
    requests.push({ atSeconds, prompt: body.join("\n"), outputTokens: spec.assistantTurnTokens });
  }

  return { requests, summarizationIndex };
}

function validateSpec(spec: AgentSessionSpec, compaction?: CompactionSpec): void {
  if (spec.turns < 1) throw new Error("An agent session needs at least one turn.");
  if (compaction && compaction.atTurn < 2) {
    throw new Error("Compaction must happen after the first turn.");
  }
  if (compaction && compaction.atTurn > spec.turns) {
    throw new Error("Compaction must happen within the session.");
  }
}

/**
 * Build a turn-by-turn agent session as a request stream, with the transcript
 * growing by one segment each turn. With a `compaction`, turns from `atTurn`
 * on lead with a summary in place of the discarded transcript, and (unless
 * disabled) a summarisation call is inserted just before that turn.
 */
export function buildAgentSession(
  spec: AgentSessionSpec,
  compaction?: CompactionSpec,
  options: { countTokens?: TokenCounter } = {},
): SimulatedRequest[] {
  validateSpec(spec, compaction);
  const countTokens = options.countTokens ?? approximateTokenCount;
  const parts = synthesizeParts(spec, compaction?.summaryTokens ?? 0, countTokens);
  return assembleSession(parts, spec, spec.turns, compaction).requests;
}

/**
 * Price a compaction decision: run the session with and without it under the
 * same cache policy, and decompose the difference into the cache-invalidation
 * cost, the summarisation cost, the net saving and the break-even horizon.
 */
export function estimateCompactionEconomics(
  spec: AgentSessionSpec,
  compaction: CompactionSpec,
  policy: CachePolicy,
  price: TokenPrice,
  options: { countTokens?: TokenCounter } = {},
): CompactionEconomics {
  validateSpec(spec, compaction);
  const countTokens = options.countTokens ?? approximateTokenCount;
  // Synthesise the parts once; every length below just slices and joins them.
  const parts = synthesizeParts(spec, compaction.summaryTokens, countTokens);

  const baselineBuild = assembleSession(parts, spec, spec.turns, undefined);
  const compactedBuild = assembleSession(parts, spec, spec.turns, compaction);
  const baseline = simulateCache(baselineBuild.requests, policy, price, options);
  const withCompaction = simulateCache(compactedBuild.requests, policy, price, options);

  // Isolate the cache penalty on the compaction turn: price that turn's prompt
  // as billed (prefix collapsed) against the same prompt wholly cache-read.
  const compactedTurnIndex =
    compactedBuild.summarizationIndex === null ? compaction.atTurn - 1 : compaction.atTurn;
  const compactionCall = withCompaction.calls[compactedTurnIndex];
  const cachedRate = price.cachedInputPerMillion ?? price.inputPerMillion * policy.readMultiplier;
  const cacheInvalidationCostUsd = compactionCall
    ? compactionCall.costUsd -
      ((compactionCall.totalInputTokens / 1_000_000) * cachedRate +
        (compactionCall.outputTokens / 1_000_000) * price.outputPerMillion)
    : 0;

  const summarizationCostUsd =
    compactedBuild.summarizationIndex === null
      ? 0
      : withCompaction.calls[compactedBuild.summarizationIndex]?.costUsd ?? 0;

  const netSavingUsd = baseline.totalCostUsd - withCompaction.totalCostUsd;
  const savingPercent =
    baseline.totalCostUsd === 0 ? 0 : (netSavingUsd / baseline.totalCostUsd) * 100;

  // Break-even: the shortest session length at which compaction comes out ahead.
  // Reuses the already-synthesised parts, so this stays linear per length.
  let breakEvenTurns: number | null = null;
  for (let length = compaction.atTurn; length <= spec.turns; length += 1) {
    const b = simulateCache(
      assembleSession(parts, spec, length, undefined).requests, policy, price, options);
    const c = simulateCache(
      assembleSession(parts, spec, length, compaction).requests, policy, price, options);
    if (c.totalCostUsd < b.totalCostUsd) {
      breakEvenTurns = length - compaction.atTurn;
      break;
    }
  }

  return {
    compactionTurn: compaction.atTurn,
    summaryTokens: compaction.summaryTokens,
    baseline,
    withCompaction,
    cacheInvalidationCostUsd,
    summarizationCostUsd,
    netSavingUsd,
    savingPercent,
    worthwhile: netSavingUsd > 0,
    breakEvenTurns,
  };
}

// ---------------------------------------------------------------------------
// Compaction priced from REAL recorded traffic
// ---------------------------------------------------------------------------

/**
 * Compaction economics computed from the ledger instead of a synthetic session.
 *
 * The ledger keeps no prompt text — only provider-verbatim token counts — so
 * the string prefix model above cannot run on it. It does not need to: the
 * ledger already records what the cache DID (cachedInputTokens per turn), so the
 * realized per-turn input rate is known, and compaction can be priced as the
 * removal of context from later turns valued at that realized rate.
 *
 * What compaction removes is a fixed block. Replacing the history accumulated by
 * the compaction point with a shorter summary drops the same
 * `context_before - preserved_prefix - summary` tokens from EVERY later turn's
 * input. Those removed tokens are exactly the stable, repeated prefix — the part
 * the provider was most likely serving from cache — so on a turn where the
 * ledger shows cache reads they are valued at the cached rate, not the full
 * one. That is a deliberate under-claim on cache-heavy traffic (the ledger's own
 * convention): compaction is credited only with what the removed tokens actually
 * cost, which on a warm cache is a tenth of their face value. The one-off
 * summarisation call is charged at the FULL input rate, against compaction, so
 * the net never flatters the lever.
 */

/** One turn of a task, projected from a recorded ledger event to just what pricing needs. */
export type LedgerTurn = {
  taskId?: string;
  turnIndex: number;
  /** For ordering turns that share a turnIndex; optional. */
  timestampMs?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type LedgerCompactionSpec = {
  /** The turn (1-based, within the task) that first carries the summary. */
  atTurn: number;
  /** Size of the summary that replaces the discarded history. */
  summaryTokens: number;
  /**
   * The always-present prefix (system + tools) compaction keeps verbatim.
   * Defaults to the smallest input seen in the task — a safe lower bound that,
   * if anything, under-states what is removed and so under-claims the saving.
   */
  preservedPrefixTokens?: number;
};

export type LedgerCompactionEstimate = {
  taskId?: string;
  turns: number;
  compactionTurn: number;
  summaryTokens: number;
  preservedPrefixTokens: number;
  /** Tokens dropped from every post-compaction turn's input. */
  removedTokensPerTurn: number;
  postCompactionTurns: number;
  /** Full task cost as recorded (sum of each turn priced at its realized usage). */
  recordedCostUsd: number;
  /** One-off cost of producing the summary, charged at the full input rate. */
  summarizationCostUsd: number;
  /** Realized value of the context compaction removes, summed over later turns. */
  grossSavingUsd: number;
  netSavingUsd: number;
  savingPercent: number;
  worthwhile: boolean;
  /** Turns after the compaction point before the one-off cost is repaid, or null. */
  breakEvenTurns: number | null;
};

/**
 * Project recorded ledger events into per-task turn streams: keep the succeeded
 * events that carry usage, group them by taskId, and order each group by turn.
 * Events with no taskId are each treated as their own single-turn task.
 */
export function ledgerTurnsByTask(events: readonly BillableEvent[]): Map<string, LedgerTurn[]> {
  const byTask = new Map<string, LedgerTurn[]>();
  for (const event of events) {
    if (event.status !== "succeeded" || !event.usage) continue;
    const key = event.taskId ?? `__single:${event.requestId}`;
    const turn: LedgerTurn = {
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      turnIndex: event.turnIndex ?? 0,
      timestampMs: Date.parse(event.timestamp),
      inputTokens: event.usage.inputTokens,
      outputTokens: event.usage.outputTokens,
      cachedInputTokens: event.usage.cachedInputTokens,
    };
    const bucket = byTask.get(key);
    if (bucket) bucket.push(turn);
    else byTask.set(key, [turn]);
  }
  for (const bucket of byTask.values()) {
    bucket.sort((left, right) =>
      left.turnIndex - right.turnIndex ||
      (left.timestampMs ?? 0) - (right.timestampMs ?? 0));
  }
  return byTask;
}

function inputRatePerToken(price: TokenPrice): number {
  return price.inputPerMillion / 1_000_000;
}

function cachedRatePerToken(price: TokenPrice): number {
  return (price.cachedInputPerMillion ?? price.inputPerMillion * 0.1) / 1_000_000;
}

/** Realized cost of one recorded turn: input (fresh + cached split) plus output. */
function recordedTurnCostUsd(turn: LedgerTurn, price: TokenPrice): number {
  const cached = Math.min(turn.cachedInputTokens, turn.inputTokens);
  const fresh = turn.inputTokens - cached;
  return (
    fresh * inputRatePerToken(price) +
    cached * cachedRatePerToken(price) +
    (turn.outputTokens / 1_000_000) * price.outputPerMillion
  );
}

/**
 * Price a compaction decision from a single task's recorded turns. `price` is
 * the resolved catalogue rate for the task's model (look it up with
 * `priceUsage` / `lookupPrice` and pass `.price`).
 */
export function estimateCompactionFromLedger(
  turns: readonly LedgerTurn[],
  compaction: LedgerCompactionSpec,
  price: TokenPrice,
): LedgerCompactionEstimate {
  if (turns.length < 2) throw new Error("Compaction needs at least two recorded turns.");
  if (compaction.atTurn < 2 || compaction.atTurn > turns.length) {
    throw new Error("Compaction must happen after the first turn and within the task.");
  }
  const ordered = [...turns].sort((left, right) =>
    left.turnIndex - right.turnIndex || (left.timestampMs ?? 0) - (right.timestampMs ?? 0));

  const preservedPrefixTokens =
    compaction.preservedPrefixTokens ??
    ordered.reduce((min, turn) => Math.min(min, turn.inputTokens), Infinity);

  // Context carried into the compaction point is the input of the turn before it.
  const contextBefore = ordered[compaction.atTurn - 2]!.inputTokens;
  const removedTokensPerTurn = Math.max(
    0,
    contextBefore - preservedPrefixTokens - compaction.summaryTokens,
  );

  const post = ordered.slice(compaction.atTurn - 1);

  // Each later turn no longer carries the removed block. Those tokens are the
  // repeated prefix, so where the turn shows cache reads they are valued at the
  // cached rate — what they actually cost — not their full face value.
  const perTurnSavingUsd = post.map((turn) => {
    const rate = turn.cachedInputTokens > 0 ? cachedRatePerToken(price) : inputRatePerToken(price);
    return removedTokensPerTurn * rate;
  });
  const grossSavingUsd = perTurnSavingUsd.reduce((sum, value) => sum + value, 0);

  // The summarisation call reads the pre-compaction context and emits the
  // summary. Charged at the full input rate (against compaction), plus writing
  // the summary once at the full input rate, plus the output it produces.
  const summarizationCostUsd =
    contextBefore * inputRatePerToken(price) +
    compaction.summaryTokens * inputRatePerToken(price) +
    (compaction.summaryTokens / 1_000_000) * price.outputPerMillion;

  const netSavingUsd = grossSavingUsd - summarizationCostUsd;
  const recordedCostUsd = ordered.reduce((sum, turn) => sum + recordedTurnCostUsd(turn, price), 0);
  const savingPercent = recordedCostUsd === 0 ? 0 : (netSavingUsd / recordedCostUsd) * 100;

  // Break-even: the first later turn at which cumulative saving clears the one-off cost.
  let breakEvenTurns: number | null = null;
  let running = 0;
  for (let index = 0; index < perTurnSavingUsd.length; index += 1) {
    running += perTurnSavingUsd[index]!;
    if (running >= summarizationCostUsd) {
      breakEvenTurns = index;
      break;
    }
  }

  return {
    ...(ordered[0]!.taskId === undefined ? {} : { taskId: ordered[0]!.taskId }),
    turns: ordered.length,
    compactionTurn: compaction.atTurn,
    summaryTokens: compaction.summaryTokens,
    preservedPrefixTokens,
    removedTokensPerTurn,
    postCompactionTurns: post.length,
    recordedCostUsd,
    summarizationCostUsd,
    grossSavingUsd,
    netSavingUsd,
    savingPercent,
    worthwhile: netSavingUsd > 0,
    breakEvenTurns,
  };
}
