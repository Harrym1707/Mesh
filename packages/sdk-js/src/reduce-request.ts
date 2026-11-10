// Specific core modules, not the barrel — see the note in proxy.ts.
import { anthropicCacheableMinimumTokens, publishedModelPrices } from "../../core/dist/src/model-prices.js";
import { approximateTokenCount, dedupeRepeatedBlocks, dedupeRepeatedLeadingBlock, type TokenCounter } from "../../core/dist/src/token-reduction.js";
import { minifyToolSchemas } from "../../core/dist/src/tool-schema.js";
import { resolveModelId } from "../../core/dist/src/price-catalogue.js";

/**
 * Reduce a request before it is sent.
 *
 * This is the part of MESH that actually lowers a bill rather than measuring how
 * much it could be lowered. It runs on every request, independent of model
 * routing: the levers here spend fewer tokens on the model the caller already
 * chose, so coupling them to a model swap would be backwards.
 *
 * Every transform here is lossless by default. Tool definitions keep their
 * descriptions, only formatting and schema plumbing go, duplicate blocks are
 * exact duplicates, and prefix repair moves text rather than deleting it. The
 * lossy options exist but are opt-in and reported as such, because descriptions
 * are how a model chooses between tools.
 *
 * Nothing here may break a request. Any failure returns the original untouched.
 */

export type MeshReductionChange = {
  lever: string;
  lossless: boolean;
  estimatedTokensSaved: number;
  detail: string;
};

/** Reasoning/output effort levels Anthropic's `output_config.effort` accepts. */
export type MeshOutputEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type MeshReductionSummary = {
  /** Estimated input tokens before reduction, by MESH's own counter. */
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensSaved: number;
  /** Of the above, the share from transforms that cannot change the answer. */
  estimatedLosslessTokensSaved: number;
  changes: MeshReductionChange[];
  /** True when reduction was attempted but the request was returned unchanged. */
  skipped: boolean;
  skippedReason?: string;
};

export type MeshHistoryCompactionConfig = {
  /**
   * Compaction starts once the conversation has at least this many user turns.
   * Short conversations are left alone: there is nothing stale to compact.
   */
  minimumTurns?: number;
  /** The most recent turns whose content is always left verbatim. */
  keepRecentTurns?: number;
  /**
   * The compaction boundary only advances in steps of this many turns, so the
   * set of compacted messages is identical across several consecutive requests
   * and the provider's exact-prefix cache can keep matching through them.
   */
  epochTurns?: number;
};

export type MeshTokenReductionConfig = {
  /**
   * Tool and MCP schema minification. `true` applies the lossless tier only.
   * Pass an object to opt into description trimming, which is a behaviour change.
   */
  toolSchemas?: boolean | {
    descriptions?: "keep" | "truncate" | "drop";
    maximumDescriptionTokens?: number;
  };
  /**
   * Drop whole tool definitions by name — the "unused-tool removal" lever. A
   * typical MCP server exposes 20-30 tools at 300-500 tokens each, and six
   * connected servers run to 60,000-90,000 tokens of catalogue PER request; a
   * workload that only ever calls a handful pays for all of them every turn.
   * Each named tool is removed from the catalogue (Anthropic `{name}` and OpenAI
   * `{type:"function",function:{name}}` shapes alike) before schema minification
   * runs on the survivors. Past tool_use/tool_result turns in the history are
   * untouched — providers do not require a tool's definition to be present to
   * replay its earlier calls.
   *
   * LOSSY: removing a tool removes the model's ability to call it, so this holds
   * ONLY where the tool is genuinely unreachable for the workload. The names are
   * never guessed — they come from an operator who knows their workload (Theo is
   * content-blind and cannot read tool names) and must clear a replay gate on the
   * customer's own traffic before any saving is billed. Off by default; an empty
   * or absent list is a no-op, and a name not present is skipped.
   */
  dropTools?: string[];
  /** Remove exact duplicate blocks from instructions and message text. */
  duplicateContext?: boolean;
  /**
   * Move per-request values (timestamps, request ids) out of the front of the
   * instructions so the stable remainder becomes a cacheable prefix. Providers
   * match an exact prefix, so one changing value at the top of an otherwise
   * identical system prompt costs the whole prompt's cache discount.
   */
  repairCachePrefix?: boolean;
  /**
   * Replace stale tool-result and assistant bodies in old turns with short
   * deterministic digests. Error messages, file paths and the headline sentence
   * survive verbatim; the rest is summarised by a byte count. The boundary only
   * moves in frozen epochs, so consecutive requests re-emit the compacted
   * history byte-identically and the provider cache re-writes once per epoch,
   * never once per turn. `true` uses the defaults; pass an object to tune.
   */
  historyCompaction?: boolean | MeshHistoryCompactionConfig;
  /**
   * Replace a repeated LEADING block in same-role messages after the first
   * with a short reference marker, keeping each message's differing
   * remainder verbatim. This is the shape a continuous-learning /
   * continuous-memory agent produces: the application glues the same
   * memory or persistent-instruction block to the front of every turn, so
   * the history carries N-1 byte-identical copies that no existing lever
   * catches (`duplicateContext` only ever sees one message's text at a
   * time, never the text several messages back that a later one repeats).
   *
   * LOSSY, unlike `duplicateContext`: the duplicate removed here is never
   * adjacent to its twin, so a model that attends less to context far back
   * in a long history may behave differently with the block present once
   * near the start versus restated fresh every turn. This must be proven
   * on the customer's own traffic through `replayGate` before it is ever
   * billed, and is never enabled by default. The cut is always snapped to
   * a line boundary (see `dedupeRepeatedLeadingBlock`), so a false match on
   * two messages that merely open with the same few words can never
   * truncate into the line where they actually differ. `true` uses the
   * default 64-token minimum block size; pass an object to tune it. Applies
   * only to messages whose content is a plain string or whose first content
   * block is `{type: "text", text}`; anything else is left untouched.
   */
  crossTurnMemoryDedup?: boolean | { minimumBlockTokens?: number };
  /**
   * Cap oversized tool-result and assistant bodies at injection, BEFORE first
   * send. A fresh oversized result is billed once at the FULL input rate and
   * only its cached rebills are discounted, so this reaches tokens that
   * history compaction (which touches already-cached turns) never can. The
   * headline sentence, error mentions, file paths and MESH's own markers
   * survive verbatim; the rest collapses to a char-count marker. Pure,
   * deterministic and idempotent, so consecutive requests re-emit identical
   * bytes and the provider cache keeps matching. Lossy by definition and
   * reported as such. `true` uses the 600-token default; pass an object to
   * tune `maximumTokens` (integer, at least 64).
   */
  freshToolResultCap?: boolean | { maximumTokens?: number };
  /**
   * Output budget, applied through the field each surface honours: Responses
   * max_output_tokens (set only when absent), Chat Completions
   * max_completion_tokens (set only when the caller set no cap in any
   * spelling), Anthropic Messages max_tokens (downward-only clamp of the
   * caller's required value). Output is the dearer half of the bill.
   */
  maxOutputTokens?: number;
  /**
   * Output effort governor: Anthropic's `output_config.effort`
   * ("low" | "medium" | "high" | "xhigh" | "max"; default "high"). The one
   * output-side lever that is PROVIDER-SANCTIONED rather than a prompt hack — a
   * lower effort makes the model think less and answer terser (less preamble,
   * fewer and more-consolidated tool calls), cutting the dearest half of the
   * bill: output tokens price 4-8x input. This is MESH's honest equivalent of a
   * competitor that "trims the model's replies": the model decides how to be
   * briefer, we do not truncate or rewrite its words.
   *
   * It is a TOP-LEVEL request field, outside the cached prefix (tools -> system
   * -> messages), so a STABLE value never invalidates a prompt cache — unlike
   * editing the system prompt to beg for brevity, which rewrites the cached
   * prefix every turn. (A value that CHANGED between turns would invalidate the
   * messages cache, so this is a per-workload setting, never flipped mid-run.)
   *
   * LOSSY: it changes the answer's depth and length, so it is off by default,
   * must clear a TASK-COMPLETION replay gate before any saving is billed
   * (exactTextGrader is meaningless here — a terser answer is different text by
   * definition), and is only ever the caller's per-workload flag. Applied only
   * on Claude models whose published effort range includes the requested level
   * (an unsupported level is a 400, and this reducer must never break a
   * request); an unsupported pairing is recorded and skipped, never stamped. A
   * caller who set `output_config.effort` themselves is left untouched. The
   * OpenAI `reasoning.effort` sibling is a planned follow-on, not wired here.
   */
  outputEffort?: MeshOutputEffort;
  /**
   * Execution tier for requests the caller has flagged latency-tolerant.
   * "flex" sets OpenAI's service_tier on the request (batch-level pricing, 50%
   * off input and output, on a synchronous API with a possible 429 fallback to
   * standard). The answer is unchanged - same model, same tokens - so this is
   * deterministic for cost; only latency changes, which is why it must be the
   * CALLER's flag per workload and is never set by default. Applied only when
   * the request does not already carry a service_tier, only on OpenAI-shaped
   * requests (service_tier is not an Anthropic field), and only for models the
   * published catalogue resolves - a tier delta on an unpriceable model could
   * never be verified, so it is never stamped.
   */
  executionTier?: "flex";
  /**
   * Anthropic prompt-cache stamping. Anthropic's cache is OPT-IN: a Claude
   * request with no cache_control gets no caching at all and re-pays full
   * rate for its entire history every turn (the first live export measured a
   * five-turn agent with zero cache traffic). This lever stamps
   * `cache_control: {type: "ephemeral", ttl}` on the STABLE prefix of an
   * Anthropic-shaped request (a `claude-*` model with a `messages` array):
   * always on the system prompt when one exists, and on the last message only
   * for multi-turn requests, whose history is re-sent verbatim next turn. A
   * one-shot request with no system prompt is never stamped — its prefix
   * never repeats, so a breakpoint could only buy write premiums (the first
   * live export measured exactly that loss).
   *
   * Pick the TTL by call spacing. "5m" (writes 1.25x base, reads 0.1x) is the
   * multi-turn agent setting: turns arrive seconds apart, so every turn after
   * the first reads its history at a tenth of the price. "1h" (writes 2x)
   * pays exactly when calls arrive MORE than ~5 minutes but less than an hour
   * apart - the regime where a 5m entry expires between calls and every call
   * rewrites. Applied only when the request carries no cache_control of its
   * own: a caller who placed breakpoints has chosen their own caching and
   * silently raising their write rate would change their bill. Never set by
   * default; like executionTier, it must be the caller's per-workload flag.
   */
  cacheTtl?: "5m" | "1h";
  /**
   * Cross-turn volatility guard for the cache stamp (see
   * cache-volatility-guard.ts). The reducer is a pure per-request function
   * and cannot see that a conversation's prefix churns between turns; the
   * guard can, and a churning prefix turns the stamp into pure write premium
   * (the second live export measured exactly that loss). The proxy and
   * withMesh install one automatically whenever cacheTtl is set; it is
   * consulted with the RAW request before any stamp is placed.
   */
  cacheVolatilityGuard?: { observe(request: unknown): { stamp: boolean; reason?: string } };
  countTokens?: TokenCounter;
  onReduction?: (summary: MeshReductionSummary) => void;
};

type AnyObject = Record<string, unknown>;

/** Values that change per request and therefore end a cacheable prefix. */
const PREFIX_BREAKERS: RegExp[] = [
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
];

function isPlainObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `output_config.effort` levels a given Claude model accepts, conservatively.
 *
 * An effort value the model does not support is rejected at the wire with a 400,
 * and the reducer's prime rule is that it may never break a request. So this is
 * a DENY-by-default allow-list keyed off the model id: a model (or level) not
 * positively known to support effort returns an empty set, and the governor
 * then records why and leaves the request untouched rather than risk a 400.
 * Kept deliberately narrow and dated (claude-api skill, 2026-06): widen it only
 * against a provider source, never by guessing a newer id supports a level.
 */
function anthropicEffortSupport(model: string): Set<MeshOutputEffort> {
  const m = model.toLowerCase();
  if (!m.includes("claude")) return new Set();
  // Full range including xhigh: Fable 5 / Mythos 5 / Opus 5 / Opus 4.8 / 4.7 /
  // Sonnet 5. (xhigh arrived with Opus 4.7.)
  if (m.includes("opus-5") || m.includes("opus-4-8") || m.includes("opus-4-7") ||
      m.includes("sonnet-5") || m.includes("fable-5") || m.includes("mythos-5")) {
    return new Set<MeshOutputEffort>(["low", "medium", "high", "xhigh", "max"]);
  }
  // Effort but no xhigh: Opus 4.6 / Sonnet 4.6.
  if (m.includes("opus-4-6") || m.includes("sonnet-4-6")) {
    return new Set<MeshOutputEffort>(["low", "medium", "high", "max"]);
  }
  // Opus 4.5: low/medium/high only (no xhigh, no max).
  if (m.includes("opus-4-5")) return new Set<MeshOutputEffort>(["low", "medium", "high"]);
  // Sonnet 4.5, every Haiku, 3.x, and anything unrecognised: effort errors or is
  // unknown -> never stamp.
  return new Set();
}

/**
 * Move leading per-request values to the end of the instructions.
 *
 * The text is preserved in full and only reordered, so the model still sees
 * every instruction and every value. Only lines in the first part of the prompt
 * are considered: a timestamp buried in the middle is not what ends a prefix.
 */
function repairPrefix(instructions: string): { text: string; moved: string[] } {
  const lines = instructions.split("\n");
  const moved: string[] = [];
  const kept: string[] = [];
  // Only the opening lines can be what breaks the prefix for everything after.
  const window = Math.min(lines.length, 8);
  for (const [index, line] of lines.entries()) {
    const breaks = index < window && PREFIX_BREAKERS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(line);
    });
    if (breaks) moved.push(line);
    else kept.push(line);
  }
  if (moved.length === 0) return { text: instructions, moved };
  return { text: [...kept, ...moved].join("\n"), moved };
}

/** Segments of a stale body that must survive compaction verbatim. */
const STALE_BODY_MUST_KEEP =
  /\b(error|errors|errored|fail|fails|failed|failure|exception|traceback|stack trace|denied|timeout|timed out|warning|fatal|panic|refused|rejected|not found|invalid)\b/i;

/** File paths survive verbatim: they are how later turns refer back. */
const STALE_BODY_FILE_PATH =
  /(?:^|[\s"'`(=[])((?:\/|\.{1,2}\/|~\/|[A-Za-z]:\\)[\w.\\/-]+|[\w.-]+\/[\w./-]+|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|jsonl|md|yml|yaml|toml|txt|csv|tsv|html|css|go|rs|java|rb|sh|sql|log|xml|lock))\b/;

/**
 * MESH's own digest/cap markers. Both the fresh-result capper and the stale
 * compactor keep segments carrying one, so a body either lever has already
 * reduced passes through the other byte-identically: the two levers are
 * byte-stable together and the provider's exact-prefix cache keeps matching.
 */
const MESH_MARKER = /\[mesh: \d+ chars of [\w -]+\]/;

/**
 * Digest one stale body. Pure function of the text, so every later request in
 * the same epoch re-emits exactly the same bytes, which is what lets the
 * provider's exact-prefix cache match across the compacted region.
 *
 * Kept verbatim: the headline (first sentence), any sentence that mentions an
 * error, and any sentence containing a file path. Everything else collapses to
 * a byte count. If that would not actually shorten the text, the original is
 * returned untouched.
 */
export function digestStaleBody(text: string): string {
  const segments = text.split(/(?<=[.!?])\s+|\n+/).filter((segment) => segment.length > 0);
  if (segments.length <= 1) return text;
  const kept: string[] = [];
  let droppedChars = 0;
  for (const [index, segment] of segments.entries()) {
    const keep = index === 0 ||
      STALE_BODY_MUST_KEEP.test(segment) ||
      STALE_BODY_FILE_PATH.test(segment) ||
      MESH_MARKER.test(segment);
    if (keep) kept.push(segment);
    else droppedChars += segment.length;
  }
  if (droppedChars === 0) return text;
  const digest = `${kept.join(" ")} [mesh: ${droppedChars} chars of stale detail compacted]`;
  return digest.length < text.length ? digest : text;
}

/**
 * Cap one oversized tool-result body at injection time, BEFORE it is first
 * sent. A fresh result is billed once at the FULL input rate; only its cached
 * rebills get the provider discount, so this is the one lever that removes
 * full-rate tokens rather than nibbling 0.1x rebills of an already-cached copy.
 *
 * Pure and idempotent: a body at or under `maximumTokens` is returned
 * untouched (identity, no marker), and capping a capped body changes nothing,
 * because every surviving segment - the headline, error mentions, file paths
 * and MESH's own markers - is a keeper on the second pass too. The same keep
 * rules as stale compaction apply, so later turns still find the reference
 * they depend on; a capper that lost the latest result's headline would fail
 * tasks, which is exactly the quality bar working.
 */
export function capToolResultBody(
  text: string,
  maximumTokens: number,
  countTokens: TokenCounter,
): string {
  if (!Number.isInteger(maximumTokens) || maximumTokens < 64) {
    throw new Error("freshToolResultCap maximumTokens must be an integer of at least 64.");
  }
  if (countTokens(text) <= maximumTokens) return text;
  const segments = text.split(/(?<=[.!?])\s+|\n+/).filter((segment) => segment.length > 0);
  if (segments.length <= 1) return text;
  const kept: string[] = [];
  let droppedChars = 0;
  for (const [index, segment] of segments.entries()) {
    const keep = index === 0 ||
      STALE_BODY_MUST_KEEP.test(segment) ||
      STALE_BODY_FILE_PATH.test(segment) ||
      MESH_MARKER.test(segment);
    if (keep) kept.push(segment);
    else droppedChars += segment.length;
  }
  if (droppedChars === 0) return text;
  const capped = `${kept.join(" ")} [mesh: ${droppedChars} chars of fresh tool-result detail capped]`;
  return capped.length < text.length ? capped : text;
}

/**
 * Apply one text transform to a message body of unknown shape; count how many
 * bodies changed. Shared traversal for stale-history digests and fresh-result
 * caps, so both levers see exactly the same string/{text}/{content} shapes.
 */
function transformBodyValue(
  value: unknown,
  transform: (text: string) => string,
  state: { bodies: number },
): unknown {
  if (typeof value === "string") {
    const transformed = transform(value);
    if (transformed !== value) state.bodies += 1;
    return transformed;
  }
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (!isPlainObject(part)) return part;
      if (typeof part.text === "string") {
        const transformed = transform(part.text);
        if (transformed !== part.text) state.bodies += 1;
        return transformed === part.text ? part : { ...part, text: transformed };
      }
      if ("content" in part) {
        const transformed = transformBodyValue(part.content, transform, state);
        return transformed === part.content ? part : { ...part, content: transformed };
      }
      return part;
    });
  }
  return value;
}

/** Digest a message body of unknown shape; count how many bodies changed. */
function digestBodyValue(value: unknown, state: { bodies: number }): unknown {
  return transformBodyValue(value, digestStaleBody, state);
}

/**
 * Whether a user message is a tool-result CARRIER: Anthropic's convention puts
 * tool results back into the conversation as {type: 'tool_result'} blocks
 * inside a user-role message. A message that is nothing but such blocks is the
 * transport for tool output, not a human turn, so turn counting must skip it
 * or Anthropic conversations would count twice as many turns as the identical
 * OpenAI-shaped conversation and compact on a different boundary.
 */
function isToolResultCarrier(message: unknown): boolean {
  return isPlainObject(message) && message.role === "user" && Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => isPlainObject(block) && block.type === "tool_result");
}

/**
 * Transform ONLY the {type: 'tool_result'} blocks inside a user message,
 * leaving genuine user text verbatim, always. Shared by the fresh-result cap
 * and stale-history compaction so both levers see the Anthropic tool-result
 * convention identically. Returns the original message when nothing changed.
 */
function transformUserToolResultBlocks(
  message: AnyObject,
  transform: (text: string) => string,
  countTokens: TokenCounter,
  state: { bodies: number },
  addSavedTokens: (saved: number) => void,
): unknown {
  if (!Array.isArray(message.content)) return message;
  const sizeOf = (value: unknown): number =>
    countTokens(typeof value === "string" ? value : JSON.stringify(value) ?? "");
  let changed = false;
  const blocks = message.content.map((block) => {
    if (!isPlainObject(block) || block.type !== "tool_result" || !("content" in block)) return block;
    const before = sizeOf(block.content);
    // transformBodyValue returns fresh arrays even when no text changed, so
    // the change signal is the bodies counter, not reference equality.
    const bodiesBefore = state.bodies;
    const transformed = transformBodyValue(block.content, transform, state);
    if (state.bodies === bodiesBefore) return block;
    changed = true;
    addSavedTokens(Math.max(0, before - sizeOf(transformed)));
    return { ...block, content: transformed };
  });
  return changed ? { ...message, content: blocks } : message;
}

/**
 * Cap oversized fresh tool results in a message array.
 *
 * Unlike stale-history compaction this has no turn boundary: it runs on every
 * tool-result and assistant body because its target is the FIRST send of an
 * oversized result, which is billed at the full input rate. It is idempotent,
 * so re-walking already-capped history is a byte-level no-op, and the capped
 * bytes are deterministic, so the provider's exact-prefix cache still matches
 * across consecutive requests. User, system and developer messages are never
 * touched.
 */
function capFreshToolResults(
  input: unknown[],
  maximumTokens: number,
  countTokens: TokenCounter,
  changes: MeshReductionChange[],
): unknown[] {
  const cap = (text: string): string => capToolResultBody(text, maximumTokens, countTokens);
  const state = { bodies: 0 };
  let savedTokens = 0;
  const next = input.map((message) => {
    if (!isPlainObject(message)) return message;
    const role = typeof message.role === "string" ? message.role : undefined;
    if (role === "system" || role === "developer") return message;
    // Genuine user text is verbatim, always. The only part of a user message
    // the cap may touch is Anthropic's {type: 'tool_result'} blocks, which are
    // tool output travelling under the user role.
    if (role === "user") {
      return transformUserToolResultBlocks(message, cap, countTokens, state, (saved) => {
        savedTokens += saved;
      });
    }

    // Responses-style tool output item: { type: "function_call_output", output }.
    if (message.type === "function_call_output" && typeof message.output === "string") {
      const before = countTokens(message.output);
      const capped = transformBodyValue(message.output, cap, state);
      if (capped === message.output) return message;
      savedTokens += Math.max(0, before - countTokens(capped as string));
      return { ...message, output: capped };
    }

    // Chat-style tool results and assistant bodies.
    if ((role === "tool" || role === "assistant") && "content" in message) {
      const before = countTokens(
        typeof message.content === "string" ? message.content : JSON.stringify(message.content) ?? "",
      );
      const capped = transformBodyValue(message.content, cap, state);
      if (capped === message.content) return message;
      savedTokens += Math.max(0, before - countTokens(
        typeof capped === "string" ? capped : JSON.stringify(capped) ?? "",
      ));
      return { ...message, content: capped };
    }
    return message;
  });

  if (state.bodies === 0) return input;
  changes.push({
    lever: "fresh-tool-result-cap",
    lossless: false,
    estimatedTokensSaved: savedTokens,
    detail: `Capped ${state.bodies} oversized tool-result/assistant body(ies) above ${maximumTokens} tokens at ` +
      "injection, before first send (headlines, errors, file paths and MESH markers kept verbatim). These " +
      "tokens would have been billed once at the FULL input rate; history compaction only reaches their " +
      "cached rebills.",
  });
  return next;
}

/**
 * Compact stale turns in a message array.
 *
 * A turn starts at each user message. The most recent `keepRecentTurns` turns
 * are always verbatim, and the compaction boundary advances only in steps of
 * `epochTurns`, so several consecutive requests compact exactly the same set of
 * messages into exactly the same bytes: the provider cache pays one re-write
 * per epoch instead of one per turn. User, system and developer messages are
 * never touched; only tool results and assistant bodies in stale turns are.
 */
function compactStaleHistory(
  input: unknown[],
  options: MeshHistoryCompactionConfig,
  countTokens: TokenCounter,
  changes: MeshReductionChange[],
): unknown[] {
  const minimumTurns = options.minimumTurns ?? 3;
  const keepRecentTurns = options.keepRecentTurns ?? 2;
  const epochTurns = options.epochTurns ?? 2;
  if (minimumTurns < 1 || keepRecentTurns < 1 || epochTurns < 1) {
    throw new Error("History compaction turn counts must be positive integers.");
  }
  // A turn is a REAL user message. User messages that are pure tool-result
  // carriers (Anthropic's convention for returning tool output) are transport,
  // not turns: counting them would give an Anthropic conversation twice the
  // turns of the identical OpenAI-shaped one and move the epoch boundary.
  const isRealUserTurn = (message: unknown): boolean =>
    isPlainObject(message) && message.role === "user" && !isToolResultCarrier(message);
  const totalTurns = input.filter(isRealUserTurn).length;
  if (totalTurns < minimumTurns) return input;
  const compactedTurns = Math.floor((totalTurns - keepRecentTurns) / epochTurns) * epochTurns;
  if (compactedTurns <= 0) return input;

  const state = { bodies: 0 };
  let savedTokens = 0;
  let turn = -1;
  const next = input.map((message) => {
    if (isRealUserTurn(message)) turn += 1;
    if (turn < 0 || turn >= compactedTurns) return message;
    if (!isPlainObject(message)) return message;
    const role = typeof message.role === "string" ? message.role : undefined;
    if (role === "system" || role === "developer") return message;
    // Genuine user text is verbatim, always; only Anthropic tool_result blocks
    // inside stale user messages are digested.
    if (role === "user") {
      return transformUserToolResultBlocks(message, digestStaleBody, countTokens, state, (saved) => {
        savedTokens += saved;
      });
    }

    // Responses-style tool output item: { type: "function_call_output", output }.
    if (message.type === "function_call_output" && typeof message.output === "string") {
      const before = countTokens(message.output);
      const digested = digestBodyValue(message.output, state);
      if (digested === message.output) return message;
      savedTokens += Math.max(0, before - countTokens(digested as string));
      return { ...message, output: digested };
    }

    // Chat-style tool results and stale assistant bodies.
    if ((role === "tool" || role === "assistant") && "content" in message) {
      const before = countTokens(
        typeof message.content === "string" ? message.content : JSON.stringify(message.content) ?? "",
      );
      const digested = digestBodyValue(message.content, state);
      if (digested === message.content) return message;
      savedTokens += Math.max(0, before - countTokens(
        typeof digested === "string" ? digested : JSON.stringify(digested) ?? "",
      ));
      return { ...message, content: digested };
    }
    return message;
  });

  if (state.bodies === 0) return input;
  changes.push({
    lever: "stale-history-compaction",
    lossless: false,
    estimatedTokensSaved: savedTokens,
    detail: `Compacted ${state.bodies} stale tool/assistant body(ies) from the first ${compactedTurns} of ` +
      `${totalTurns} turns into deterministic digests (errors, file paths and headlines kept verbatim). ` +
      `The boundary is frozen to ${epochTurns}-turn epochs so the compacted prefix stays byte-identical ` +
      "across consecutive requests.",
  });
  return next;
}

/** A message's leading text, for cross-turn memory matching: a plain string
 *  `content`, or the text of a leading `{type: "text"}` content block. A
 *  tool-result carrier's first block is `{type: "tool_result"}`, so it never
 *  matches here. */
function leadingText(message: AnyObject): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content) && message.content.length > 0) {
    const first = message.content[0];
    if (isPlainObject(first) && first.type === "text" && typeof first.text === "string") return first.text;
  }
  return undefined;
}

/** Rewrite a message's leading text in place of whichever shape leadingText read it from. */
function withLeadingText(message: AnyObject, text: string): AnyObject {
  if (typeof message.content === "string") return { ...message, content: text };
  const content = message.content as unknown[];
  return { ...message, content: [{ ...(content[0] as AnyObject), text }, ...content.slice(1)] };
}

/**
 * Cross-turn memory dedup: within the user turns of a message array, treats
 * the first turn's leading text as canonical and replaces a repeated leading
 * block in every later turn with a reference marker (see
 * `dedupeRepeatedLeadingBlock`). Restricted to the `user` role: that is
 * where a continuous-memory agent's application code re-injects its memory
 * block, and keeping this lever off assistant and tool bodies (which the
 * other, digest-based levers already reach) avoids two different reduction
 * strategies fighting over the same bytes.
 */
function dedupeMemoryAcrossTurns(
  input: unknown[],
  options: { minimumBlockTokens?: number },
  countTokens: TokenCounter,
  changes: MeshReductionChange[],
): unknown[] {
  const minimumBlockTokens = options.minimumBlockTokens ?? 64;
  if (!Number.isInteger(minimumBlockTokens) || minimumBlockTokens < 1) {
    throw new Error("crossTurnMemoryDedup minimumBlockTokens must be a positive integer.");
  }
  const indices: number[] = [];
  for (const [index, message] of input.entries()) {
    if (!isPlainObject(message) || message.role !== "user") continue;
    if (leadingText(message) === undefined) continue;
    indices.push(index);
  }
  if (indices.length < 2) return input;

  const texts = indices.map((index) => leadingText(input[index] as AnyObject)!);
  const before = texts.reduce((sum, text) => sum + countTokens(text), 0);
  const result = dedupeRepeatedLeadingBlock(texts, minimumBlockTokens, countTokens);
  if (result.notes.length === 0) return input;
  const after = result.texts.reduce((sum, text) => sum + countTokens(text), 0);

  const next = [...input];
  indices.forEach((index, position) => {
    if (result.texts[position] === texts[position]) return;
    next[index] = withLeadingText(next[index] as AnyObject, result.texts[position]!);
  });

  changes.push({
    lever: "cross-turn-memory-dedup",
    lossless: false,
    estimatedTokensSaved: Math.max(0, before - after),
    detail: `Replaced ${result.notes.length} repeated leading block(s) across user turns with reference ` +
      "markers (the first turn's block, and every turn's own differing remainder, kept verbatim). This is a " +
      "behaviour change, not a cache-rate change, so it needs a replay-gate pass on the customer's own traffic " +
      "before the saving may be billed.",
  });
  return next;
}

function reduceText(
  text: string,
  config: MeshTokenReductionConfig,
  countTokens: TokenCounter,
  changes: MeshReductionChange[],
  label: string,
): string {
  let current = text;
  if (config.duplicateContext !== false) {
    const before = countTokens(current);
    const reduced = dedupeRepeatedBlocks(24, countTokens).reduce(current);
    const saved = before - countTokens(reduced.text);
    if (saved > 0) {
      current = reduced.text;
      changes.push({
        lever: "duplicate-context-removal",
        lossless: true,
        estimatedTokensSaved: saved,
        detail: `Removed ${reduced.notes.length} duplicate block(s) from ${label}.`,
      });
    }
  }
  return current;
}

/** Collect the text of a Responses-style message, leaving structure untouched. */
function reduceMessageContent(
  content: unknown,
  config: MeshTokenReductionConfig,
  countTokens: TokenCounter,
  changes: MeshReductionChange[],
): unknown {
  if (typeof content === "string") return reduceText(content, config, countTokens, changes, "a message");
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!isPlainObject(part) || typeof part.text !== "string") return part;
      return { ...part, text: reduceText(part.text, config, countTokens, changes, "a message part") };
    });
  }
  return content;
}

/**
 * Stamp the 1h prompt-cache TTL on an Anthropic-shaped request, copy-on-write.
 *
 * Returns true when at least one breakpoint was stamped. The request must look
 * like an Anthropic Messages call (a claude model with a non-empty `messages`
 * array) and must not already carry any cache_control anywhere: a caller who
 * placed their own breakpoints has chosen their caching, and silently doubling
 * their write rate would change their bill behind their back.
 *
 * PLACEMENT is what decides whether this lever earns or loses money, and the
 * first live export falsified the old rule (last block of the last message):
 * on one-shot templated traffic the last message varies per request, so every
 * request paid the 2x write premium and no request ever read — a measured loss.
 * The rule now follows what is actually stable:
 *
 * - A system prompt is stable across the workload, so it always gets a
 *   breakpoint (a string body is lifted into the equivalent single text
 *   block, which the Anthropic API documents as the same request). Tools
 *   precede system in the cached prefix, so this caches both.
 * - When prefix repair moved per-request values (a clock, a request id) to
 *   the end of a string system, the breakpoint must NOT cover them: the
 *   second live export measured a per-turn loss from exactly that (every
 *   turn a cache write, never a read). The system is split at the repair
 *   boundary — stable text gets the breakpoint, the volatile tail follows as
 *   an unstamped block (Anthropic's documented shared-prefix/varying-suffix
 *   placement) — and no message breakpoint is placed, because a message
 *   breakpoint's prefix would include the volatile tail and never match.
 * - On a MULTI-turn request the full history including the newest message is
 *   re-sent verbatim next turn, so the last message also gets a breakpoint —
 *   next turn reads it and extends. A one-shot request gets no message
 *   breakpoint: there is nothing stable below the system prompt.
 * - Anthropic will not cache a prefix shorter than its documented minimum
 *   (1,024 tokens, 2,048 on Haiku-class models; `anthropicCacheableMinimumTokens`)
 *   at all — it just processes the request without caching, a silent
 *   provider-side no-op. Each candidate breakpoint is measured against that
 *   minimum over the FULL prefix it would cover (tools + system for the
 *   system breakpoint; tools + system + every message up to and including
 *   the last one for the message breakpoint) before it is placed, so MESH
 *   never records a cache-TTL saving for a breakpoint that could never be
 *   read back.
 */
function stampAnthropicCacheTtl(
  next: AnyObject,
  ttl: "5m" | "1h",
  systemVolatileTail: string[],
  countTokens: TokenCounter,
): { stamped: boolean; belowMinimum?: { measuredTokens: number; minimumTokens: number } } {
  const model = typeof next.model === "string" ? next.model.toLowerCase() : "";
  if (!model.includes("claude")) return { stamped: false };
  if (!Array.isArray(next.messages) || next.messages.length === 0) return { stamped: false };
  // A top-level cache_control (the automatic-caching request field) is the
  // caller choosing their caching at the request level; stamping an explicit
  // breakpoint with a different TTL alongside it risks a provider-side
  // TTL-mismatch rejection, so the stamp defers exactly as it does for
  // caller-placed block-level breakpoints.
  if (next.cache_control !== undefined) return { stamped: false };
  const carriesCacheControl = (value: unknown): boolean =>
    (JSON.stringify(value ?? null) ?? "").includes('"cache_control"');
  if (carriesCacheControl(next.messages) || carriesCacheControl(next.system) ||
      carriesCacheControl(next.tools)) {
    return { stamped: false };
  }

  // Calibration (docs/rnd/knowledge/2026-10-25-acquired-knowledge.md §3):
  // MESH's approximate counter overcounts prose by up to 1.28x, so a prefix
  // the counter scores at the documented minimum can be well below it in the
  // provider's own tokens — a silent no-op stamp. Require the approximate
  // count to clear the minimum with a 1.30x margin; a boundary stamp earns
  // pennies, a false lever record costs trust.
  const APPROX_OVERCOUNT_MARGIN = 1.3;
  const minimumTokens = Math.ceil(anthropicCacheableMinimumTokens(model) * APPROX_OVERCOUNT_MARGIN);
  const measureTokens = (value: unknown): number => {
    try {
      return typeof value === "string" ? countTokens(value) : countTokens(JSON.stringify(value) ?? "");
    } catch {
      return 0;
    }
  };
  const toolsTokens = Array.isArray(next.tools) && next.tools.length > 0 ? measureTokens(next.tools) : 0;
  // Captured before either breakpoint mutates `next.system` / `next.messages`,
  // so the message breakpoint's prefix size is measured against the request
  // as the caller sent it, not against a shape this same call already rewrote.
  const fullSystemTokens = measureTokens(next.system);
  const fullMessagesTokens = measureTokens(next.messages);
  let belowMinimum: { measuredTokens: number; minimumTokens: number } | undefined;
  const recordBelowMinimum = (measuredTokens: number): void => {
    if (belowMinimum === undefined) belowMinimum = { measuredTokens, minimumTokens };
  };

  const cacheControl = { type: "ephemeral", ttl };
  let stamped = false;
  // When repair relocated per-request values to the end of the system string,
  // the breakpoint must stop before them; any breakpoint placed after them
  // (including one on the last message) could never be read back.
  let volatileTailPresent = false;

  // The stable template: system (which also pulls tools into the cached prefix).
  if (typeof next.system === "string" && next.system.trim() !== "") {
    const tailText = systemVolatileTail.join("\n");
    if (systemVolatileTail.length > 0 && tailText.trim() !== "" &&
        (next.system === tailText || next.system.endsWith(`\n${tailText}`))) {
      volatileTailPresent = true;
      // Keep the separating newline attached to the stable block: the two
      // blocks are concatenated by the provider with no inserted separator,
      // so dropping it here would glue the stable text to the tail and
      // change what the model reads, not just where the breakpoint sits.
      const stable = next.system === tailText ? "" : next.system.slice(0, -tailText.length);
      if (stable.trim() !== "") {
        const stableTokens = toolsTokens + measureTokens(stable);
        if (stableTokens < minimumTokens) {
          recordBelowMinimum(stableTokens);
        } else {
          next.system = [
            { type: "text", text: stable, cache_control: cacheControl },
            { type: "text", text: tailText },
          ];
          stamped = true;
        }
      }
      // An all-volatile system has no stable prefix to stamp: nothing is
      // stamped anywhere on this request (a breakpoint could only buy the
      // write premium, which is the measured loss this rule exists to stop).
    } else {
      const stableTokens = toolsTokens + fullSystemTokens;
      if (stableTokens < minimumTokens) {
        recordBelowMinimum(stableTokens);
      } else {
        next.system = [{ type: "text", text: next.system, cache_control: cacheControl }];
        stamped = true;
      }
    }
  } else if (Array.isArray(next.system) && next.system.length > 0) {
    const blocks = [...next.system];
    const lastBlock = blocks[blocks.length - 1];
    if (isPlainObject(lastBlock) &&
        !(typeof lastBlock.text === "string" && lastBlock.text.trim() === "")) {
      const stableTokens = toolsTokens + fullSystemTokens;
      if (stableTokens < minimumTokens) {
        recordBelowMinimum(stableTokens);
      } else {
        blocks[blocks.length - 1] = { ...lastBlock, cache_control: cacheControl };
        next.system = blocks;
        stamped = true;
      }
    }
  }

  // The settled conversation: only multi-turn requests re-send their newest
  // message verbatim on the next turn, so only they get a message breakpoint —
  // and never when a volatile tail sits in the system, because this
  // breakpoint's prefix would include that tail and could never match.
  if (!volatileTailPresent && next.messages.length >= 2) {
    const messages = [...next.messages];
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    if (isPlainObject(last)) {
      const content = last.content;
      const prefixTokens = toolsTokens + fullSystemTokens + fullMessagesTokens;
      if (typeof content === "string") {
        // An empty or whitespace-only body cannot carry a breakpoint: Anthropic
        // rejects text blocks without visible content, so the stamp would turn
        // a valid request into a 400.
        if (content.trim() !== "") {
          if (prefixTokens < minimumTokens) {
            recordBelowMinimum(prefixTokens);
          } else {
            messages[lastIndex] = {
              ...last,
              content: [{ type: "text", text: content, cache_control: cacheControl }],
            };
            next.messages = messages;
            stamped = true;
          }
        }
      } else if (Array.isArray(content) && content.length > 0) {
        const blocks = [...content];
        const lastBlock = blocks[blocks.length - 1];
        if (isPlainObject(lastBlock) &&
            !(typeof lastBlock.text === "string" && lastBlock.text.trim() === "")) {
          if (prefixTokens < minimumTokens) {
            recordBelowMinimum(prefixTokens);
          } else {
            blocks[blocks.length - 1] = { ...lastBlock, cache_control: cacheControl };
            messages[lastIndex] = { ...last, content: blocks };
            next.messages = messages;
            stamped = true;
          }
        }
      }
    }
  }

  return stamped ? { stamped: true } : { stamped: false, belowMinimum };
}

/**
 * Apply reduction to one request.
 *
 * Returns the original request and a `skipped` summary if anything goes wrong,
 * because a cheaper request that fails is worth less than an expensive one that
 * works.
 */
export function reduceRequest(
  request: unknown,
  config: MeshTokenReductionConfig = {},
): { request: unknown; summary: MeshReductionSummary } {
  const countTokens = config.countTokens ?? approximateTokenCount;
  const changes: MeshReductionChange[] = [];

  const unchanged = (reason: string): { request: unknown; summary: MeshReductionSummary } => ({
    request,
    summary: {
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
      estimatedTokensSaved: 0,
      estimatedLosslessTokensSaved: 0,
      changes: [],
      skipped: true,
      skippedReason: reason,
    },
  });

  if (!isPlainObject(request)) return unchanged("Request is not an object.");

  try {
    const next: AnyObject = { ...request };
    const measure = (value: unknown): number => {
      try {
        return typeof value === "string" ? countTokens(value) : countTokens(JSON.stringify(value) ?? "");
      } catch {
        return 0;
      }
    };
    const before = measure(next.instructions) + measure(next.system) + measure(next.input) +
      measure(next.messages) + measure(next.tools);

    // Unused-tool removal. Drop whole named tool definitions BEFORE minification,
    // so only the surviving catalogue is compacted. Lossy and operator-named.
    if (Array.isArray(next.tools) && next.tools.length > 0 && Array.isArray(config.dropTools) && config.dropTools.length > 0) {
      const drop = new Set(config.dropTools.filter((name): name is string => typeof name === "string"));
      if (drop.size > 0) {
        const nameOf = (tool: unknown): string | undefined => {
          if (!isPlainObject(tool)) return undefined;
          if (typeof tool.name === "string") return tool.name; // Anthropic + OpenAI Responses
          if (isPlainObject(tool.function) && typeof tool.function.name === "string") return tool.function.name; // OpenAI Chat
          return undefined;
        };
        const toolsBefore = measure(next.tools);
        const kept = (next.tools as unknown[]).filter((tool) => { const name = nameOf(tool); return name === undefined || !drop.has(name); });
        const removed = (next.tools as unknown[]).length - kept.length;
        if (removed > 0) {
          next.tools = kept;
          const saved = toolsBefore - measure(next.tools);
          if (saved > 0) {
            changes.push({
              lever: "unused-tool-removal",
              lossless: false,
              estimatedTokensSaved: saved,
              detail: `Removed ${removed} tool definition(s) the workload does not call; proven on your traffic before billing.`,
            });
          }
        }
      }
    }

    // Tool catalogue. Lossless unless the caller opts into description trimming.
    if (Array.isArray(next.tools) && next.tools.length > 0 && config.toolSchemas !== false) {
      const toolOptions = isPlainObject(config.toolSchemas) ? config.toolSchemas : {};
      const minified = minifyToolSchemas(next.tools, {
        countTokens,
        descriptions: (toolOptions.descriptions as "keep" | "truncate" | "drop" | undefined) ?? "keep",
        ...(typeof toolOptions.maximumDescriptionTokens === "number"
          ? { maximumDescriptionTokens: toolOptions.maximumDescriptionTokens }
          : {}),
      });
      const saved = minified.tokensBefore - minified.tokensAfter;
      if (saved > 0) {
        next.tools = minified.tools;
        if (minified.losslessTokensSaved > 0) {
          changes.push({
            lever: "tool-schema-compaction",
            lossless: true,
            estimatedTokensSaved: minified.losslessTokensSaved,
            detail: `Compacted ${minified.tools.length} tool definition(s); the decoded schema is unchanged.`,
          });
        }
        if (minified.lossyTokensSaved > 0) {
          changes.push({
            lever: "tool-schema-description-trim",
            lossless: false,
            estimatedTokensSaved: minified.lossyTokensSaved,
            detail: "Trimmed tool descriptions, which is how the model chooses between tools.",
          });
        }
      }
    }

    // Instructions: dedupe, then move prefix breakers to the end. The same
    // pass covers a string `system` field, which is where an Anthropic-shaped
    // request keeps exactly what an OpenAI-shaped one keeps in `instructions`:
    // without this the per-request clock at the top of `system` breaks the
    // cached prefix on Anthropic traffic while the identical prompt is
    // repaired on OpenAI traffic. A block-array `system` is left untouched -
    // reordering caller-placed blocks is not ours to do.
    // Lines prefix repair moved to the end of a string `system`: the cache
    // stamp must not cover them (see stampAnthropicCacheTtl).
    let systemVolatileTail: string[] = [];
    const reduceSystemText = (text: string, label: "instructions" | "system"): string => {
      let current = reduceText(text, config, countTokens, changes, label);
      if (config.repairCachePrefix) {
        const repaired = repairPrefix(current);
        if (repaired.moved.length > 0) {
          if (label === "system") systemVolatileTail = repaired.moved;
          current = repaired.text;
          changes.push({
            lever: "cache-prefix-repair",
            lossless: true,
            // The saving is a cache-rate change, not tokens removed.
            estimatedTokensSaved: 0,
            detail: `Moved ${repaired.moved.length} per-request value(s) out of the ${label} prefix, making ` +
              "the stable remainder cacheable. The text is reordered, not removed.",
          });
        }
      }
      return current;
    };
    if (typeof next.instructions === "string") {
      next.instructions = reduceSystemText(next.instructions, "instructions");
    }
    if (typeof next.system === "string") {
      next.system = reduceSystemText(next.system, "system");
    }

    // Fresh tool-result capping, BEFORE history compaction: the cap targets
    // full-rate tokens at injection, and compaction then sees already-capped
    // bodies it keeps byte-identical (both levers keep MESH markers).
    if (config.freshToolResultCap) {
      const capOptions = isPlainObject(config.freshToolResultCap) ? config.freshToolResultCap : {};
      const threshold = capOptions.maximumTokens === undefined ? 600 : capOptions.maximumTokens;
      if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 64) {
        throw new Error("freshToolResultCap maximumTokens must be an integer of at least 64.");
      }
      if (Array.isArray(next.input)) {
        next.input = capFreshToolResults(next.input, threshold, countTokens, changes);
      }
      if (Array.isArray(next.messages)) {
        next.messages = capFreshToolResults(next.messages, threshold, countTokens, changes);
      }
    }

    // Stale-history compaction, before per-message dedupe so digests are what
    // the later passes (and the wire) see.
    if (config.historyCompaction) {
      const options = isPlainObject(config.historyCompaction) ? config.historyCompaction : {};
      if (Array.isArray(next.input)) {
        next.input = compactStaleHistory(next.input, options, countTokens, changes);
      }
      if (Array.isArray(next.messages)) {
        next.messages = compactStaleHistory(next.messages, options, countTokens, changes);
      }
    }

    // Cross-turn memory dedup, before the per-message pass below: it needs
    // the RAW text of every user turn to find what repeats across them, and
    // leaves a marker that the per-message pass's own (same-text) dedupe
    // then simply passes through untouched.
    if (config.crossTurnMemoryDedup) {
      const memoryOptions = isPlainObject(config.crossTurnMemoryDedup) ? config.crossTurnMemoryDedup : {};
      if (Array.isArray(next.input)) {
        next.input = dedupeMemoryAcrossTurns(next.input, memoryOptions, countTokens, changes);
      }
      if (Array.isArray(next.messages)) {
        next.messages = dedupeMemoryAcrossTurns(next.messages, memoryOptions, countTokens, changes);
      }
    }

    if (Array.isArray(next.input)) {
      next.input = next.input.map((message) => {
        if (!isPlainObject(message)) return message;
        if (!("content" in message)) return message;
        return { ...message, content: reduceMessageContent(message.content, config, countTokens, changes) };
      });
    } else if (typeof next.input === "string") {
      next.input = reduceText(next.input as string, config, countTokens, changes, "input");
    }
    // The same per-message pass on `messages`, so Anthropic- and Chat
    // Completions-shaped requests get exactly the reductions `input` gets.
    if (Array.isArray(next.messages)) {
      next.messages = next.messages.map((message) => {
        if (!isPlainObject(message)) return message;
        if (!("content" in message)) return message;
        return { ...message, content: reduceMessageContent(message.content, config, countTokens, changes) };
      });
    }

    // Execution tier, only where the caller has not chosen one themselves,
    // and ONLY on OpenAI-shaped requests for models the catalogue knows:
    // service_tier is an OpenAI request field, so an Anthropic-shaped request
    // is never stamped (the field would 400), and a model the catalogue cannot
    // resolve gets no stamp because an unpriceable tier delta could never be
    // verified or billed - unpriced is excluded, never zeroed, and never
    // stamped on spec.
    if (config.executionTier === "flex" && next.service_tier === undefined) {
      const model = typeof next.model === "string" ? next.model : "";
      const anthropicShaped = model.toLowerCase().includes("claude");
      const catalogued = !anthropicShaped &&
        resolveModelId(publishedModelPrices, "openai", model).status === "resolved";
      if (catalogued) {
        next.service_tier = "flex";
        changes.push({
          lever: "execution-tier-flex",
          lossless: true,
          // The saving is a rate change on the whole request, not tokens removed.
          estimatedTokensSaved: 0,
          detail: "Set service_tier to flex: batch-level pricing (50% off) on a synchronous API. Same model, " +
            "same answer; latency may rise and 429s fall back to standard, so this applies only to workloads " +
            "the caller flagged latency-tolerant.",
        });
      }
    }

    // Cache TTL, only on Anthropic-shaped requests that carry no cache_control
    // of their own. Like the execution tier this changes a billing RATE, not a
    // prompt: the same bytes are cached for an hour at a 2x write premium.
    if (config.cacheTtl === "5m" || config.cacheTtl === "1h") {
      const ttl = config.cacheTtl;
      // The guard sees the RAW request: MESH's own deterministic levers must
      // never be mistaken for client-side churn.
      const decision = config.cacheVolatilityGuard?.observe(request) ?? { stamp: true };
      const result = decision.stamp
        ? stampAnthropicCacheTtl(next, ttl, systemVolatileTail, countTokens)
        : { stamped: false as const };
      if (!decision.stamp) {
        changes.push({
          lever: "cache-ttl-suppressed",
          lossless: true,
          // Nothing was changed; this records WHY no stamp was placed.
          estimatedTokensSaved: 0,
          detail: `Cache stamp withheld: ${decision.reason ?? "the conversation's prefix is not stable"}. ` +
            "A breakpoint over a churning prefix buys write premiums and never reads — a measured loss, not a saving.",
        });
      } else if (!result.stamped && result.belowMinimum) {
        changes.push({
          lever: "cache-ttl-suppressed",
          lossless: true,
          // Nothing was changed; this records WHY no stamp was placed.
          estimatedTokensSaved: 0,
          detail: `Cache stamp withheld: the stable prefix measures ${result.belowMinimum.measuredTokens} token(s) ` +
            `by MESH's approximate counter, under the ${result.belowMinimum.minimumTokens}-token threshold MESH ` +
            `requires — the model's documented ${anthropicCacheableMinimumTokens(typeof next.model === "string" ? next.model : "")}-token cacheable minimum ` +
            "with a 1.30x margin for the counter's calibrated overcount on prose. Anthropic processes a prefix " +
            "under its minimum without caching at all — a provider-side no-op — so a breakpoint here would buy " +
            "a write premium and never read, and would record a saving that can never happen.",
        });
      }
      if (result.stamped) {
        changes.push({
          lever: `cache-ttl-${ttl}`,
          lossless: true,
          // The saving is a rate change (cache reads at 0.1x), not tokens removed.
          estimatedTokensSaved: 0,
          detail: `Stamped cache_control {type: 'ephemeral', ttl: '${ttl}'} on the stable prefix (system ` +
            "prompt; plus the last message on multi-turn requests, whose history repeats next turn). " +
            (ttl === "5m"
              ? "Writes bill at 1.25x base input, reads at 0.1x: the multi-turn agent setting, since " +
                "Anthropic's cache is opt-in and an unstamped agent re-pays full rate for its history " +
                "every turn. The caller must flag the workload - it is never set by default."
              : "Writes bill at 2x base input, reads at 0.1x: this pays only when calls arrive more " +
                "than ~5 minutes apart, and the caller must flag that workload - it is never set by default."),
        });
      }
    }

    // Output budget, applied through the field each surface actually honours,
    // and only where the caller has not set a cap themselves (guard per
    // surface). The Responses behaviour is unchanged.
    if (config.maxOutputTokens !== undefined) {
      const assertValidCap = (): void => {
        if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens! < 1) {
          throw new Error("maxOutputTokens must be a positive integer.");
        }
      };
      const claudeModel = typeof next.model === "string" && next.model.toLowerCase().includes("claude");
      const messagesShaped = Array.isArray(next.messages);
      if (claudeModel && messagesShaped &&
          typeof next.max_tokens === "number" && Number.isFinite(next.max_tokens)) {
        // Anthropic Messages REQUIRES max_tokens, so a real request always
        // carries the caller's own choice: MESH may only tighten it downward,
        // never loosen or replace it. (A claude-shaped request WITHOUT
        // max_tokens is not sendable to the real API; it falls through to the
        // generic branch below unchanged, which keeps simulator-shaped traffic
        // behaving exactly as before.)
        assertValidCap();
        if (next.max_tokens > config.maxOutputTokens) {
          next.max_tokens = config.maxOutputTokens;
          changes.push({
            lever: "output-cap",
            lossless: false,
            estimatedTokensSaved: 0,
            detail: `Clamped max_tokens down to ${config.maxOutputTokens} (downward only; a caller cap at or ` +
              "below the budget is never touched). Responses that would have run longer are truncated, so this " +
              "needs checking against real output lengths.",
          });
        }
      } else if (!claudeModel && messagesShaped) {
        // Chat Completions honours max_completion_tokens (max_tokens is the
        // deprecated alias); either one set by the caller wins.
        if (next.max_completion_tokens === undefined && next.max_tokens === undefined &&
            next.max_output_tokens === undefined) {
          assertValidCap();
          next.max_completion_tokens = config.maxOutputTokens;
          changes.push({
            lever: "output-cap",
            lossless: false,
            estimatedTokensSaved: 0,
            detail: `Set max_completion_tokens to ${config.maxOutputTokens}. Responses that would have run ` +
              "longer are truncated, so this needs checking against real output lengths.",
          });
        }
      } else if (next.max_output_tokens === undefined) {
        assertValidCap();
        next.max_output_tokens = config.maxOutputTokens;
        changes.push({
          lever: "output-cap",
          lossless: false,
          estimatedTokensSaved: 0,
          detail: `Set max_output_tokens to ${config.maxOutputTokens}. Responses that would have run longer are ` +
            "truncated, so this needs checking against real output lengths.",
        });
      }
    }

    // Output effort governor (Anthropic output_config.effort). A rate/behaviour
    // change on the dearest tokens, not a prompt edit: set only when the caller
    // chose no effort of their own, only on a Claude model whose range includes
    // the requested level, and never stamped on a level the model would 400.
    if (config.outputEffort !== undefined) {
      const level = config.outputEffort;
      const model = typeof next.model === "string" ? next.model : "";
      const claudeMessagesShaped = model.toLowerCase().includes("claude") && Array.isArray(next.messages);
      const existingConfig = isPlainObject(next.output_config) ? next.output_config : undefined;
      const callerSetEffort = existingConfig !== undefined && "effort" in existingConfig;
      if (claudeMessagesShaped && !callerSetEffort) {
        if (anthropicEffortSupport(model).has(level)) {
          next.output_config = { ...(existingConfig ?? {}), effort: level };
          changes.push({
            lever: `output-effort-${level}`,
            lossless: false,
            // The saving is fewer output tokens the model chooses to emit, read
            // from provider usage by the gate, not an input-token count here.
            estimatedTokensSaved: 0,
            detail: `Set output_config.effort to '${level}'. The model thinks less and answers terser, cutting ` +
              "output tokens (the dearer half of the bill). A top-level field outside the cached prefix, so a " +
              "stable value never invalidates caching. Lossy — it changes the answer's depth, so it needs a " +
              "task-completion replay-gate pass on the caller's own traffic before the saving may be billed.",
          });
        } else {
          changes.push({
            lever: "output-effort-suppressed",
            lossless: true,
            // Nothing was changed; this records WHY no effort was set.
            estimatedTokensSaved: 0,
            detail: `Effort '${level}' withheld: model '${model || "(none)"}' is not in MESH's dated allow-list of ` +
              "Claude models known to accept that level. An unsupported effort value is a 400, and the reducer " +
              "never risks breaking a request, so it is left as the caller sent it.",
          });
        }
      }
    }

    const after = measure(next.instructions) + measure(next.system) + measure(next.input) +
      measure(next.messages) + measure(next.tools);

    const summary: MeshReductionSummary = {
      estimatedTokensBefore: before,
      estimatedTokensAfter: after,
      estimatedTokensSaved: Math.max(0, before - after),
      estimatedLosslessTokensSaved: changes
        .filter((change) => change.lossless)
        .reduce((sum, change) => sum + change.estimatedTokensSaved, 0),
      changes,
      skipped: false,
    };
    config.onReduction?.(summary);
    return { request: changes.length === 0 ? request : next, summary };
  } catch (cause) {
    return unchanged(cause instanceof Error ? cause.message : String(cause));
  }
}
