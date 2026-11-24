/**
 * Cache compatibility: does a Mesh lever keep a conversation cacheable?
 *
 * A prompt cache matches an exact prefix. An agent re-sends its whole history
 * every turn, so turn N's request is a prefix of turn N+1's, and a client that
 * caches (Claude Code does) pays a tenth of the input rate for it. A proxy
 * that changes bytes inside that prefix differently on two turns turns those
 * reads into writes at 1.25x. Removing tokens can then RAISE the bill - a
 * published study measured exactly that for another local proxy.
 *
 * So for every lever, on multi-turn sessions, this checks three things:
 *
 *   A. PREFIX STABILITY. The reduced request for turn N must be an exact
 *      prefix of the reduced request for turn N+1 (as the provider lays the
 *      prompt out, cache markers aside), wherever the raw one was.
 *   B. CALLER-MARKED BYTES. Where the caller placed cache_control, are the
 *      bytes inside the marked prefix the same after Mesh as before? A lever
 *      can change them and still pass A (it changes them the same way every
 *      turn); it then costs one cache re-write if it is switched on in the
 *      middle of a conversation, and nothing if it was on from the start.
 *   C. THE BILL. The stream priced under the cache rules, raw against
 *      reduced: with the lever on from the first turn, and with it switched
 *      on halfway through.
 *
 * SIMULATOR. Real recorded tool outputs, scripted sessions, approximate token
 * counts, turns 20 seconds apart. No model is run and no provider is called.
 */

import { approximateTokenCount } from "../packages/core/src/token-reduction.js";
import type { MeshTokenReductionConfig } from "../packages/sdk-js/src/reduce-request.js";
import { agentSessions, corpusAvailable } from "./agent-tasks.js";
import { browsingSession } from "./browsing-shape.js";
import { layout, priceStream, reduceStream, type AnyObject, type TimedRequest } from "./cache-stream.js";

const MODEL = "claude-sonnet-5-5";
const TURN_GAP_SECONDS = 20;
const MARK = { cache_control: { type: "ephemeral" } };

export type CompatSession = {
  id: string;
  label: string;
  /** How the CALLER caches: not at all, with its own breakpoints, or with the top-level automatic field. */
  callerCache: "none" | "breakpoints" | "automatic";
  requests: TimedRequest[];
};

export type CompatLever = {
  id: string;
  label: string;
  /** On in a default install. */
  default: boolean;
  /** What the reducer records for it. */
  lossless: boolean;
  config: MeshTokenReductionConfig;
  /** Compare against the stream reduced with this configuration instead of the raw stream. */
  against?: MeshTokenReductionConfig;
};

/** Each lever alone, so a failure names its cause. */
export const COMPAT_LEVERS: CompatLever[] = [
  { id: "tool-schema-compaction", label: "Tool-schema compaction", default: true, lossless: true, config: { toolSchemas: true, duplicateContext: false } },
  { id: "duplicate-context-removal", label: "Duplicate-context removal", default: true, lossless: true, config: { toolSchemas: false, duplicateContext: true } },
  { id: "cache-prefix-repair", label: "Cache-prefix repair", default: true, lossless: true, config: { toolSchemas: false, duplicateContext: false, repairCachePrefix: true } },
  { id: "defaults", label: "The three defaults together", default: true, lossless: true, config: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true } },
  { id: "tool-result-json-compaction", label: "JSON tool-result compaction", default: false, lossless: true, config: { toolSchemas: false, duplicateContext: false, toolResultJson: true } },
  { id: "cache-ttl-5m", label: "Cache stamp, 5 minutes", default: false, lossless: true, config: { toolSchemas: false, duplicateContext: false, cacheTtl: "5m" } },
  { id: "tool-schema-description-trim", label: "Tool description trim", default: false, lossless: false, config: { toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 12 }, duplicateContext: false } },
  { id: "fresh-tool-result-cap", label: "Fresh tool-result cap", default: false, lossless: false, config: { toolSchemas: false, duplicateContext: false, freshToolResultCap: { maximumTokens: 600 } } },
  { id: "cross-turn-memory-dedup", label: "Cross-turn memory dedup", default: false, lossless: false, config: { toolSchemas: false, duplicateContext: false, crossTurnMemoryDedup: true } },
  { id: "stale-history-compaction", label: "Stale-history compaction", default: false, lossless: false, config: { toolSchemas: false, duplicateContext: false, historyCompaction: true } },
  {
    id: "stale-history-compaction+cache-stamp", label: "Stale-history compaction on top of Mesh's cache stamp", default: false, lossless: false,
    config: { toolSchemas: false, duplicateContext: false, repairCachePrefix: true, cacheTtl: "5m", historyCompaction: true },
    against: { toolSchemas: false, duplicateContext: false, repairCachePrefix: true, cacheTtl: "5m" },
  },
  {
    id: "stale-history-compaction:forced", label: "Stale-history compaction with the cache gate overridden", default: false, lossless: false,
    config: { toolSchemas: false, duplicateContext: false, historyCompaction: { allowUnderCache: true } },
  },
];

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** What a caching client sends: a breakpoint after the system prompt and one on the newest block. */
function withCallerBreakpoints(request: AnyObject): AnyObject {
  const system = typeof request.system === "string"
    ? [{ type: "text", text: request.system, ...MARK }]
    : (request.system as AnyObject[]).map((block, index, all) => (index === all.length - 1 ? { ...block, ...MARK } : block));
  const messages = (request.messages as AnyObject[]).map((message, index, all) => {
    if (index !== all.length - 1) return message;
    const blocks = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : (message.content as AnyObject[]);
    return { ...message, content: blocks.map((block, at, list) => (at === list.length - 1 ? { ...block, ...MARK } : block)) };
  });
  return { ...request, system, messages };
}

/** The caller asks for automatic caching with the top-level field. */
const withAutomaticCache = (request: AnyObject): AnyObject => ({ ...request, cache_control: { type: "ephemeral" } });

const timed = (requests: AnyObject[], outputTokens: number[] = []): TimedRequest[] =>
  requests.map((request, index) => ({ atSeconds: index * TURN_GAP_SECONDS, request, outputTokens: outputTokens[index] ?? 200 }));

const RULES = Array.from({ length: 90 }, (_, index) =>
  `Rule ${index + 1}: when a customer on plan tier ${(index % 5) + 1} asks about ${["refunds", "invoices", "seat changes", "data export", "single sign-on", "rate limits"][index % 6]}, ` +
  `answer from the policy text only, cite section ${10 + index}.${index % 7}, and escalate if the amount exceeds ${(index + 2) * 25} units.`,
).join("\n");
const BIG_SYSTEM = `You are the support assistant for an invoicing product. Follow every rule below exactly.\n${RULES}`;

/** Tool definitions as an MCP server ships them: schema plumbing, titles and long descriptions. */
const PLUMBED_TOOLS = Array.from({ length: 8 }, (_, index) => ({
  name: `records_${["search", "get", "list", "create", "update", "archive", "export", "audit"][index]}`,
  description: `Use this tool to ${["search", "fetch", "list", "create", "update", "archive", "export", "audit"][index]} customer records. ` +
    "It returns a JSON object. Call it only after you have confirmed the customer's account id, and never guess an id. " +
    "Results are paginated; ask for the next page with the cursor from the previous result.",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `Records${index}Input`,
    type: "object",
    properties: {
      accountId: { type: "string", title: "accountId", description: "Account identifier." },
      cursor: { type: "string", title: "cursor", description: "Opaque pagination cursor." },
      limit: { type: "integer", title: "limit", default: 20 },
    },
    required: ["accountId"],
  },
}));

const PARAGRAPH = "Refunds issued to a closed card are returned to the original payment method where the issuer supports it, " +
  "and otherwise credited to the customer wallet within one business day. The agent must confirm the last four digits first.";
const MEMORY = `Standing notes about this customer:\n${Array.from({ length: 30 }, (_, index) => `- Note ${index + 1}: prefers email, plan tier ${index % 5 + 1}, renewal month ${index % 12 + 1}.`).join("\n")}`;

/** A chat that grows by one user turn and one answer each time. `userText` builds each user message. */
function chat(turns: number, options: { system: string; tools?: unknown[]; userText: (turn: number) => string }): AnyObject[] {
  const messages: AnyObject[] = [];
  const requests: AnyObject[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: "user", content: options.userText(turn) });
    requests.push({ model: MODEL, max_tokens: 600, system: options.system, ...(options.tools ? { tools: options.tools } : {}), messages: [...messages] });
    messages.push({ role: "assistant", content: `Answer ${turn + 1}: under section ${10 + turn}.${turn % 7} the policy allows this within the billing period. The next step is to open the billing page, confirm the change and wait for the confirmation email. `.repeat(4) });
  }
  return requests;
}

/** The sessions the check runs on. Needs the recorded tool outputs (lab/agent-tasks/corpus). */
export function compatSessions(): CompatSession[] {
  if (!corpusAvailable()) throw new Error("The recorded tool outputs are missing. Record them with: bash lab/agent-tasks/capture.sh");
  const sessions: CompatSession[] = [];
  for (const { id, session } of agentSessions()) {
    sessions.push({ id: `agent:${id}`, label: `Agent loop (${id})`, callerCache: "none", requests: timed(session.requests, session.outputTokens) });
    sessions.push({ id: `agent:${id}:caller-breakpoints`, label: `Agent loop (${id}), client caches with breakpoints`, callerCache: "breakpoints", requests: timed(session.requests.map(withCallerBreakpoints), session.outputTokens) });
  }
  const coding = agentSessions().find((entry) => entry.id === "coding-fix")!.session;
  sessions.push({ id: "agent:coding-fix:caller-automatic", label: "Agent loop (coding-fix), client uses automatic caching", callerCache: "automatic", requests: timed(coding.requests.map(withAutomaticCache), coding.outputTokens) });

  const browsing = browsingSession(20);
  sessions.push({ id: "browsing", label: "Browsing agent, 20 snapshots", callerCache: "none", requests: timed(browsing.requests, browsing.outputTokens) });
  sessions.push({ id: "browsing:caller-breakpoints", label: "Browsing agent, client caches with breakpoints", callerCache: "breakpoints", requests: timed(browsing.requests.map(withCallerBreakpoints), browsing.outputTokens) });

  const plumbed = chat(12, { system: BIG_SYSTEM, tools: PLUMBED_TOOLS, userText: (turn) => `Question ${turn + 1}: can I change seats mid-term on tier ${turn % 5 + 1}?` });
  sessions.push({ id: "chat:mcp-tools", label: "Chat with MCP-style tool definitions", callerCache: "none", requests: timed(plumbed) });
  sessions.push({ id: "chat:mcp-tools:caller-breakpoints", label: "Chat with MCP-style tool definitions, client caches", callerCache: "breakpoints", requests: timed(plumbed.map(withCallerBreakpoints)) });

  const duplicated = chat(12, { system: BIG_SYSTEM, userText: (turn) => `Context:\n\n${PARAGRAPH}\n\n${PARAGRAPH}\n\nQuestion ${turn + 1}: what happens to a refund on a closed card?` });
  sessions.push({ id: "chat:duplicates", label: "Chat whose messages repeat a block", callerCache: "none", requests: timed(duplicated) });
  sessions.push({ id: "chat:duplicates:caller-breakpoints", label: "Chat whose messages repeat a block, client caches", callerCache: "breakpoints", requests: timed(duplicated.map(withCallerBreakpoints)) });

  const memory = chat(12, { system: BIG_SYSTEM, userText: (turn) => `${MEMORY}\n\nQuestion ${turn + 1}: what should I offer this customer at renewal?` });
  sessions.push({ id: "chat:memory", label: "Memory agent: the same notes at the top of every turn", callerCache: "none", requests: timed(memory) });
  sessions.push({ id: "chat:memory:caller-breakpoints", label: "Memory agent, client caches", callerCache: "breakpoints", requests: timed(memory.map(withCallerBreakpoints)) });

  const clock = chat(12, { system: BIG_SYSTEM, userText: (turn) => `Question ${turn + 1}: is my invoice final?` })
    .map((request, turn) => ({ ...request, system: `Current time: 2026-11-23T09:${String(turn).padStart(2, "0")}:00Z\n${BIG_SYSTEM}` }));
  sessions.push({ id: "chat:clock", label: "Chat with a clock at the top of its instructions", callerCache: "none", requests: timed(clock) });
  sessions.push({ id: "chat:clock:caller-automatic", label: "Chat with a clock at the top, client uses automatic caching", callerCache: "automatic", requests: timed(clock.map(withAutomaticCache)) });

  const long = chat(40, { system: BIG_SYSTEM, userText: (turn) => `Question ${turn + 1}: explain rule ${turn + 1} for tier ${turn % 5 + 1}.` });
  sessions.push({ id: "chat:long", label: "Long chat, 40 turns", callerCache: "none", requests: timed(long) });
  sessions.push({ id: "chat:long:caller-breakpoints", label: "Long chat, 40 turns, client caches", callerCache: "breakpoints", requests: timed(long.map(withCallerBreakpoints)) });
  return sessions;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

/** For each turn but the last: how much of it is an exact prefix of the next turn, in tokens. */
const carryMemo = new WeakMap<readonly TimedRequest[], { held: number; turnTokens: number; whole: boolean }[]>();
const pricedMemo = new WeakMap<readonly TimedRequest[], ReturnType<typeof priceStream>>();
const priced = (requests: readonly TimedRequest[]): ReturnType<typeof priceStream> => {
  const known = pricedMemo.get(requests);
  if (known !== undefined) return known;
  const value = priceStream(requests);
  pricedMemo.set(requests, value);
  return value;
};

function prefixCarry(requests: readonly TimedRequest[]): { held: number; turnTokens: number; whole: boolean }[] {
  const known = carryMemo.get(requests);
  if (known !== undefined) return known;
  const value = computePrefixCarry(requests);
  carryMemo.set(requests, value);
  return value;
}

function computePrefixCarry(requests: readonly TimedRequest[]): { held: number; turnTokens: number; whole: boolean }[] {
  const contents = requests.map(({ request }) => layout(request).content);
  const out: { held: number; turnTokens: number; whole: boolean }[] = [];
  for (let turn = 0; turn + 1 < contents.length; turn += 1) {
    const common = commonPrefixLength(contents[turn]!, contents[turn + 1]!);
    out.push({
      held: approximateTokenCount(contents[turn]!.slice(0, common)),
      turnTokens: approximateTokenCount(contents[turn]!),
      whole: common === contents[turn]!.length,
    });
  }
  return out;
}

export type CompatRow = {
  session: string;
  callerCache: CompatSession["callerCache"];
  lever: string;
  turns: number;
  /** Is this conversation's history under a cache breakpoint (the caller's, or Mesh's stamp in the compared configuration)? */
  cached: boolean;
  /** Did the lever change any request in this session at all? */
  acted: boolean;
  /** Turn pairs where the RAW turn N is wholly a prefix of turn N+1. */
  rawWholePairs: number;
  /** Of those, the pairs where the REDUCED turn N is no longer wholly a prefix of the reduced turn N+1. */
  brokenPairs: number;
  /** Check A: no pair that held raw is broken reduced. */
  prefixStable: boolean;
  /** Tokens of cacheable prefix carried turn to turn, summed over the session: raw, then reduced. */
  rawCarriedTokens: number;
  reducedCarriedTokens: number;
  /**
   * Check B, sessions where the caller caches only: are the bytes inside the
   * caller's cached prefix identical after Mesh? Undefined when the caller does not cache.
   */
  callerPrefixUntouched?: boolean;
  /** Check C: change to the billed INPUT cost with the lever on from the first turn. Positive = cheaper. */
  billChangePercent: number;
  /** The same with the lever switched on halfway through the conversation. */
  midSessionBillChangePercent: number;
  /** Change in input TOKENS sent, for comparison with the bill. Positive = fewer tokens. */
  tokenChangePercent: number;
};

const percent = (before: number, after: number): number => (before === 0 ? 0 : ((before - after) / before) * 100);

export function checkCompat(session: CompatSession, lever: CompatLever): CompatRow {
  const raw = lever.against === undefined ? session.requests : reduceStream(session.requests, lever.against);
  const reduced = reduceStream(session.requests, lever.config);
  const cached = raw.some(({ request }) => layout(request).breakpoints.length > 0);
  const rawCarry = prefixCarry(raw);
  const reducedCarry = prefixCarry(reduced);
  let rawWholePairs = 0;
  let brokenPairs = 0;
  rawCarry.forEach((pair, index) => {
    if (!pair.whole) return;
    rawWholePairs += 1;
    if (!reducedCarry[index]!.whole) brokenPairs += 1;
  });

  let callerPrefixUntouched: boolean | undefined;
  if (session.callerCache !== "none") {
    callerPrefixUntouched = session.requests.every(({ request }, index) => {
      const before = layout(request);
      const after = layout(reduced[index]!.request);
      const end = before.breakpoints.length > 0 ? Math.max(...before.breakpoints.map(({ offset }) => offset)) : 0;
      return before.content.slice(0, end) === after.content.slice(0, end);
    });
  }

  const half = Math.floor(raw.length / 2);
  const switchedOnHalfway = raw.map((timedRequest, index) => (index < half ? timedRequest : reduced[index]!));
  const rawPriced = priced(raw);
  const reducedPriced = priceStream(reduced);
  return {
    session: session.id,
    callerCache: session.callerCache,
    lever: lever.id,
    turns: raw.length,
    cached,
    acted: raw.some(({ request }, index) => layout(request).content !== layout(reduced[index]!.request).content ||
      JSON.stringify(request) !== JSON.stringify(reduced[index]!.request)),
    rawWholePairs,
    brokenPairs,
    prefixStable: brokenPairs === 0,
    rawCarriedTokens: rawCarry.reduce((sum, pair) => sum + pair.held, 0),
    reducedCarriedTokens: reducedCarry.reduce((sum, pair) => sum + pair.held, 0),
    ...(callerPrefixUntouched === undefined ? {} : { callerPrefixUntouched }),
    billChangePercent: percent(rawPriced.inputUnits, reducedPriced.inputUnits),
    midSessionBillChangePercent: percent(rawPriced.inputUnits, priceStream(switchedOnHalfway).inputUnits),
    tokenChangePercent: percent(rawPriced.inputTokens, reducedPriced.inputTokens),
  };
}

export type LeverVerdict = {
  lever: string;
  label: string;
  default: boolean;
  lossless: boolean;
  sessionsActedOn: number;
  /** Check A over every session. */
  prefixStableEverywhere: boolean;
  brokenSessions: string[];
  /** Check A where it costs money: sessions whose history is under a cache breakpoint. */
  prefixStableWhereCached: boolean;
  brokenCachedSessions: string[];
  /** Check B over the sessions where the caller caches and the lever acted. */
  callerPrefixTouchedIn: string[];
  /** Check C: the worst and best bill change among sessions whose history is cached. */
  worstCallerCachedBillChangePercent: number;
  bestCallerCachedBillChangePercent: number;
  /** The worst bill change when the lever is switched on halfway through a cached conversation. */
  worstMidSessionBillChangePercent: number;
  rows: CompatRow[];
};

export function qualifyCacheCompat(): LeverVerdict[] {
  const sessions = compatSessions();
  return COMPAT_LEVERS.map((lever) => {
    const rows = sessions.map((session) => checkCompat(session, lever));
    const acted = rows.filter((row) => row.acted);
    const callerCached = acted.filter((row) => row.cached);
    const brokenCached = rows.filter((row) => row.cached && !row.prefixStable).map((row) => row.session);
    const of = (values: number[], pick: (...numbers: number[]) => number): number => (values.length === 0 ? 0 : pick(...values));
    return {
      lever: lever.id,
      label: lever.label,
      default: lever.default,
      lossless: lever.lossless,
      sessionsActedOn: acted.length,
      prefixStableEverywhere: rows.every((row) => row.prefixStable),
      brokenSessions: rows.filter((row) => !row.prefixStable).map((row) => row.session),
      prefixStableWhereCached: brokenCached.length === 0,
      brokenCachedSessions: brokenCached,
      callerPrefixTouchedIn: callerCached.filter((row) => row.callerPrefixUntouched === false).map((row) => row.session),
      worstCallerCachedBillChangePercent: of(callerCached.map((row) => row.billChangePercent), Math.min),
      bestCallerCachedBillChangePercent: of(callerCached.map((row) => row.billChangePercent), Math.max),
      worstMidSessionBillChangePercent: of(callerCached.map((row) => row.midSessionBillChangePercent), Math.min),
      rows,
    };
  });
}
