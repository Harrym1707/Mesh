import { estimateTokenCost, type TokenPrice } from "../../core/dist/src/cost.js";
import { normalizeProviderUsage } from "../../core/dist/src/provider-usage.js";
import { simultaneousGroupBootstrapLowerBounds } from "../../core/dist/src/confidence.js";
import { reduceRequest, type MeshTokenReductionConfig } from "./reduce-request.js";

/**
 * Decide whether a lossy reduction may be switched on, by replaying real
 * requests both ways and comparing.
 *
 * The lossless levers need no gate: a compacted schema decodes identically, an
 * exact duplicate carries no information, and moving a timestamp changes a
 * billing rate rather than a prompt. The levers that actually drive cost down
 * hard are different. Trimming tool descriptions changes how a model picks a
 * tool. Capping output truncates the tail. Those are behaviour changes, and the
 * only honest way to enable one is to show on the customer's own traffic that
 * quality held.
 *
 * Two properties make the verdict billable rather than decorative:
 *
 *   Token savings come from the provider's reported usage on both runs, not from
 *   MESH's own estimate. That makes the saving measured, not projected.
 *
 *   Candidates are bounded simultaneously. Trying six settings and keeping the
 *   best biases that winner upward, and a per-candidate bound would not cover
 *   the search. This is the same correction the offline benchmark uses, from the
 *   same implementation.
 *
 * Replay costs money: each request is sent twice unless recorded baseline
 * responses are supplied. The call count is reported so the bill is visible.
 */

type AnyObject = Record<string, unknown>;

export type ReplayComparison = {
  request: unknown;
  baselineResponse: unknown;
  candidateResponse: unknown;
};

/** Returns 1 when the candidate is as good as the baseline, 0 when unusable. */
export type ReplayGrader = (comparison: ReplayComparison) => number | Promise<number>;

export type ReplayCandidate = {
  label: string;
  config: MeshTokenReductionConfig;
};

export type ReplayGateOptions = {
  /** A representative sample of real requests. */
  requests: unknown[];
  /** Sends a request and returns the provider's response. */
  call: (request: unknown) => Promise<unknown>;
  candidates: ReplayCandidate[];
  grade: ReplayGrader;
  /** Mean quality the gate may give up, against the unreduced baseline. Default 0.02. */
  maximumQualityDrop?: number;
  bootstrapSamples?: number;
  seed?: string;
  /**
   * Group label per request. Several requests drawn from one prompt or task are
   * correlated, and treating them as independent overstates the bound.
   */
  groupOf?: (request: unknown, index: number) => string;
  /** Recorded baseline responses, to avoid paying for the baseline run again. */
  baselineResponses?: unknown[];
  /** Rate used to express savings in money as well as tokens. */
  price?: TokenPrice;
  /**
   * Called before the baseline run and before each candidate run.
   *
   * Providers hold state between calls: a prefix cache is cold on the first
   * request and warm afterwards. Without a reset between runs the baseline
   * warms the cache that the candidates then benefit from, which flatters every
   * candidate and makes the baseline look worse than it is. Use this to clear
   * whatever state would otherwise leak across runs.
   */
  beforeRun?: (label: string) => void | Promise<void>;
};

export type ReplayUsage = {
  /** Total input billed, inclusive of anything served from cache. */
  inputTokens: number;
  outputTokens: number;
  /** Input served from the provider's cache, billed at the cached rate. */
  cachedInputTokens: number;
  /** Input written into the cache, which some providers bill at a premium. */
  cacheWriteInputTokens: number;
};

export type ReplayCandidateResult = {
  label: string;
  config: MeshTokenReductionConfig;
  graded: number;
  /** Requests where either side failed, excluded from the verdict. */
  failed: number;
  meanQualityDelta: number;
  lower95QualityDelta: number;
  approved: boolean;
  rejectionReason?: string;
  baselineUsage: ReplayUsage;
  candidateUsage: ReplayUsage;
  inputTokensSaved: number;
  outputTokensSaved: number;
  tokenSavingPercent: number;
  costSavedUsd?: number;
  costSavingPercent?: number;
};

export type ReplayGateResult = {
  candidates: ReplayCandidateResult[];
  /** The most aggressive candidate that held quality, if any did. */
  approved?: ReplayCandidateResult;
  maximumQualityDrop: number;
  /** Provider calls this replay made, so its cost is visible. */
  calls: number;
  notes: string[];
};

function isPlainObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull usage out of a Responses, Chat Completions or Anthropic Messages shape.
 *
 * Cached tokens must be read, not ignored. Pricing all input at the full rate
 * makes prefix caching worth exactly zero to the gate, which would mean the
 * largest lossless lever could never be measured or credited.
 *
 * The parsing itself now lives in packages/core (normalizeProviderUsage), the
 * single shared normaliser the SDK wrapper and the ledger read through too, so
 * the gate and the meter can never disagree about what a response cost. This
 * wrapper keeps the gate's historical contract: the usage, or undefined.
 */
export function replayUsage(response: unknown): ReplayUsage | undefined {
  const result = normalizeProviderUsage(response);
  if (result.status !== "ok") return undefined;
  const { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens } = result.usage;
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens };
}

/** Concatenate the assistant text of a response, ignoring structure. */
export function responseText(response: unknown): string {
  if (!isPlainObject(response)) return "";
  if (typeof response.output_text === "string") return response.output_text;
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isPlainObject(value)) return;
    if (typeof value.text === "string") parts.push(value.text);
    if (Array.isArray(value.content)) walk(value.content);
    if (isPlainObject(value.message)) walk(value.message);
  };
  walk(response.output ?? response.choices ?? response.content ?? []);
  return parts.join("\n");
}

export type ToolCall = { name: string; argumentsJson: string };

/**
 * Serialise with object keys sorted, recursively.
 *
 * Reparsing and re-serialising is not enough: JSON.stringify preserves
 * insertion order, so {"b":2,"a":1} and {"a":1,"b":2} stay different strings
 * and two identical tool calls would grade as a mismatch. That would make the
 * gate reject a safe reduction and understate what it saved.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Tool calls a response made, normalised so two responses can be compared. */
export function responseToolCalls(response: unknown): ToolCall[] {
  const calls: ToolCall[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isPlainObject(value)) return;
    const name = typeof value.name === "string" ? value.name : undefined;
    const isCall = value.type === "function_call" || value.type === "tool_call" ||
      isPlainObject(value.function);
    if (isCall) {
      const fn = isPlainObject(value.function) ? value.function : undefined;
      const callName = name ?? (fn && typeof fn.name === "string" ? fn.name : undefined);
      const rawArguments = value.arguments ?? (fn ? fn.arguments : undefined);
      if (callName !== undefined) {
        let argumentsJson = "";
        try {
          // Canonicalised, so neither key order nor whitespace can make two
          // identical calls look different to the grader.
          argumentsJson = typeof rawArguments === "string"
            ? canonicalJson(JSON.parse(rawArguments))
            : canonicalJson(rawArguments ?? null);
        } catch {
          argumentsJson = typeof rawArguments === "string" ? rawArguments : "";
        }
        calls.push({ name: callName, argumentsJson });
      }
    }
    for (const nested of Object.values(value)) {
      if (Array.isArray(nested) || isPlainObject(nested)) walk(nested);
    }
  };
  walk(response);
  // Deduplicate: the walk can reach one call through more than one path.
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.name}|${call.argumentsJson}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Scores 1 only when the assistant text matches exactly. */
export const exactTextGrader: ReplayGrader = ({ baselineResponse, candidateResponse }) =>
  responseText(baselineResponse).trim() === responseText(candidateResponse).trim() ? 1 : 0;

/**
 * Scores on whether the same tools were called with the same arguments.
 *
 * The grader that matters for tool-description trimming, because that lever's
 * risk is precisely that the model picks a different tool. Text graders miss it:
 * two different tool choices can produce similarly-worded replies.
 */
export const toolSelectionGrader: ReplayGrader = ({ baselineResponse, candidateResponse }) => {
  const baseline = responseToolCalls(baselineResponse);
  const candidate = responseToolCalls(candidateResponse);
  if (baseline.length === 0 && candidate.length === 0) return 1;
  const key = (call: ToolCall) => `${call.name}|${call.argumentsJson}`;
  const baselineKeys = new Set(baseline.map(key));
  const candidateKeys = new Set(candidate.map(key));
  const matched = [...baselineKeys].filter((value) => candidateKeys.has(value)).length;
  const union = new Set([...baselineKeys, ...candidateKeys]).size;
  return union === 0 ? 1 : matched / union;
};

/** Scores 1 when the same tool names were called, ignoring their arguments. */
export const toolNameGrader: ReplayGrader = ({ baselineResponse, candidateResponse }) => {
  const names = (response: unknown) => new Set(responseToolCalls(response).map((call) => call.name));
  const baseline = names(baselineResponse);
  const candidate = names(candidateResponse);
  if (baseline.size === 0 && candidate.size === 0) return 1;
  const matched = [...baseline].filter((name) => candidate.has(name)).length;
  const union = new Set([...baseline, ...candidate]).size;
  return union === 0 ? 1 : matched / union;
};

/**
 * Replay a sample both ways and report which candidates may be enabled.
 *
 * Returns every candidate's verdict, not only the winner, so a rejection can be
 * read as rejected-at-what-cost rather than merely absent.
 */
export async function replayGate(options: ReplayGateOptions): Promise<ReplayGateResult> {
  const {
    requests,
    call,
    candidates,
    grade,
    maximumQualityDrop = 0.02,
    bootstrapSamples = 2_000,
    seed = "mesh-replay-gate-v1",
    price,
  } = options;

  if (requests.length === 0) throw new Error("A replay gate needs at least one request.");
  if (candidates.length === 0) throw new Error("A replay gate needs at least one candidate configuration.");
  if (!Number.isFinite(maximumQualityDrop) || maximumQualityDrop < 0 || maximumQualityDrop > 1) {
    throw new Error("maximumQualityDrop must be between 0 and 1.");
  }
  if (options.baselineResponses !== undefined && options.baselineResponses.length !== requests.length) {
    throw new Error("baselineResponses must line up one-to-one with requests.");
  }

  const notes: string[] = [];
  let calls = 0;
  const groups = requests.map((request, index) => options.groupOf?.(request, index) ?? `request-${index}`);

  // Baseline run, unless recorded responses were supplied.
  if (!options.baselineResponses) await options.beforeRun?.("baseline");
  const baselineResponses: Array<unknown | undefined> = [];
  for (const [index, request] of requests.entries()) {
    if (options.baselineResponses) {
      baselineResponses.push(options.baselineResponses[index]);
      continue;
    }
    try {
      baselineResponses.push(await call(request));
      calls += 1;
    } catch {
      baselineResponses.push(undefined);
    }
  }
  if (options.baselineResponses) {
    notes.push("Baseline responses were supplied, so only the candidate runs were paid for.");
  }

  const perCandidate: Array<{
    candidate: ReplayCandidate;
    deltas: number[];
    graded: number;
    failed: number;
    baselineUsage: ReplayUsage;
    candidateUsage: ReplayUsage;
    reductionSkipped: number;
  }> = [];

  for (const candidate of candidates) {
    await options.beforeRun?.(candidate.label);
    const deltas: number[] = new Array(requests.length).fill(0);
    let graded = 0;
    let failed = 0;
    let reductionSkipped = 0;
    const baselineUsage: ReplayUsage = {
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    };
    const candidateUsage: ReplayUsage = {
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    };

    for (const [index, request] of requests.entries()) {
      const baselineResponse = baselineResponses[index];
      const reduced = reduceRequest(request, candidate.config);
      if (reduced.summary.skipped) reductionSkipped += 1;
      let candidateResponse: unknown;
      try {
        candidateResponse = await call(reduced.request);
        calls += 1;
      } catch {
        failed += 1;
        continue;
      }
      if (baselineResponse === undefined) {
        failed += 1;
        continue;
      }
      const baseline = replayUsage(baselineResponse);
      const candidateUsageRow = replayUsage(candidateResponse);
      if (baseline && candidateUsageRow) {
        baselineUsage.inputTokens += baseline.inputTokens;
        baselineUsage.outputTokens += baseline.outputTokens;
        baselineUsage.cachedInputTokens += baseline.cachedInputTokens;
        baselineUsage.cacheWriteInputTokens += baseline.cacheWriteInputTokens;
        candidateUsage.inputTokens += candidateUsageRow.inputTokens;
        candidateUsage.outputTokens += candidateUsageRow.outputTokens;
        candidateUsage.cachedInputTokens += candidateUsageRow.cachedInputTokens;
        candidateUsage.cacheWriteInputTokens += candidateUsageRow.cacheWriteInputTokens;
      }
      try {
        const score = await grade({ request, baselineResponse, candidateResponse });
        if (!Number.isFinite(score)) throw new Error("Grader returned a non-finite score.");
        // Quality is measured against the baseline, which scores 1 by definition.
        deltas[index] = Math.min(1, Math.max(0, score)) - 1;
        graded += 1;
      } catch {
        failed += 1;
      }
    }
    if (reductionSkipped > 0) {
      notes.push(`${candidate.label}: reduction was skipped on ${reductionSkipped} request(s); ` +
        "those were sent unchanged, so its saving is understated.");
    }
    perCandidate.push({
      candidate, deltas, graded, failed, baselineUsage, candidateUsage, reductionSkipped,
    });
  }

  const usable = perCandidate.filter((row) => row.graded > 0);
  if (usable.length === 0) {
    throw new Error("No candidate produced a single gradeable comparison; check the grader and the client.");
  }
  // One band across the whole search, so the chosen candidate's guarantee
  // survives having been picked as the best of several.
  const bounds = simultaneousGroupBootstrapLowerBounds(
    usable.map((row) => row.deltas),
    groups,
    bootstrapSamples,
    seed,
  );

  const results: ReplayCandidateResult[] = perCandidate.map((row) => {
    const boundIndex = usable.indexOf(row);
    const lower = boundIndex === -1 ? Number.NEGATIVE_INFINITY : bounds[boundIndex]!;
    const meanDelta = row.deltas.reduce((sum, value) => sum + value, 0) / row.deltas.length;
    const inputSaved = row.baselineUsage.inputTokens - row.candidateUsage.inputTokens;
    const outputSaved = row.baselineUsage.outputTokens - row.candidateUsage.outputTokens;
    const baselineTokens = row.baselineUsage.inputTokens + row.baselineUsage.outputTokens;

    // Priced with cache usage, so a lever that changes only the RATE a token is
    // billed at shows up. Without this, prefix caching reads as worthless.
    const priceUsageRow = (usage: ReplayUsage): number | undefined => {
      if (!price) return undefined;
      const cached = price.cachedInputPerMillion === undefined ? 0 : usage.cachedInputTokens;
      const written = price.cacheWriteInputPerMillion === undefined ? 0 : usage.cacheWriteInputTokens;
      return estimateTokenCost(usage.inputTokens, usage.outputTokens, price, {
        cachedInputTokens: cached,
        cacheWriteInputTokens: written,
      });
    };
    const costBaseline = priceUsageRow(row.baselineUsage);
    const costCandidate = priceUsageRow(row.candidateUsage);
    const costFell = costBaseline !== undefined && costCandidate !== undefined &&
      costCandidate < costBaseline;

    const priced = costBaseline !== undefined && costCandidate !== undefined;
    let approved = lower >= -maximumQualityDrop;
    let rejectionReason: string | undefined;
    if (row.graded === 0) {
      approved = false;
      rejectionReason = "No gradeable comparison was produced.";
    } else if (!approved) {
      rejectionReason = `Quality lower bound ${(lower * 100).toFixed(2)} pp breaches the ` +
        `${(maximumQualityDrop * 100).toFixed(2)} pp limit.`;
    } else if (priced) {
      // With a price, the honest test is whether the BILL fell once cache writes
      // and reads are priced in — not whether tokens fell. Compaction is the
      // lever that separates the two: summarising stale turns removes input
      // tokens yet rewrites a prefix the provider was still serving from cache,
      // so it can shrink the prompt and still RAISE the bill. Gating on tokens
      // alone waves that net loss through; gating on cost catches it, while
      // still crediting prefix repair (the bill falls though no tokens move).
      if (!costFell) {
        approved = false;
        rejectionReason =
          "Quality held but the bill did not fall once cache writes and reads are priced in " +
          "(e.g. compacting a prefix the provider was still serving from cache), so there is nothing to enable.";
      }
    } else if (inputSaved + outputSaved <= 0) {
      // No price to judge the bill by, so fall back to the token test.
      approved = false;
      rejectionReason = "Quality held but no tokens were removed, so there is nothing to enable.";
    }

    return {
      label: row.candidate.label,
      config: row.candidate.config,
      graded: row.graded,
      failed: row.failed,
      meanQualityDelta: meanDelta,
      lower95QualityDelta: lower,
      approved,
      ...(rejectionReason === undefined ? {} : { rejectionReason }),
      baselineUsage: row.baselineUsage,
      candidateUsage: row.candidateUsage,
      inputTokensSaved: inputSaved,
      outputTokensSaved: outputSaved,
      tokenSavingPercent: baselineTokens === 0 ? 0 : ((inputSaved + outputSaved) / baselineTokens) * 100,
      ...(costBaseline !== undefined && costCandidate !== undefined
        ? {
          costSavedUsd: costBaseline - costCandidate,
          costSavingPercent: costBaseline === 0 ? 0 : ((costBaseline - costCandidate) / costBaseline) * 100,
        }
        : {}),
    };
  });

  // The most aggressive candidate that held quality, measured by what it saved.
  const approved = results
    .filter((result) => result.approved)
    .sort((left, right) =>
      (right.costSavingPercent ?? right.tokenSavingPercent) -
      (left.costSavingPercent ?? left.tokenSavingPercent))[0];

  if (approved === undefined) {
    notes.push("No candidate held quality. The lossless levers remain available and need no gate.");
  }

  return {
    candidates: results,
    ...(approved === undefined ? {} : { approved }),
    maximumQualityDrop,
    calls,
    notes,
  };
}
