// EXPERIMENT (lab-local, not in the product): span-keyed cache stamping.
//
// The product decides whether to place cache breakpoints with a conversation
// guard (packages/sdk-js cache-volatility-guard.ts): it hashes the RAW
// {tools, system}, requires the message history to extend turn over turn, and
// on any churn withholds EVERY breakpoint. Two blind spots follow, both visible
// in the live coding-agent spool (stamp, stamp, then three suppressions while
// the same 2,267-token prefix is billed at full price):
//
//   1. It hashes raw bytes, so a per-turn clock reads as churn even when
//      `repairCachePrefix` has already moved the clock out of the stamped span.
//   2. It is all-or-nothing. A rewritten or windowed history makes the MESSAGE
//      breakpoint worthless — but the tools + system breakpoint sits BEFORE the
//      history and still reads. Suppressing it forfeits the largest stable part
//      of an agent's prompt.
//
// The provider matches on bytes, not conversations. So this stamper keys each
// breakpoint on what the provider would match:
//
//   system breakpoint  — placed when the exact span Mesh would stamp (tools +
//                        the stamped system blocks, after Mesh's deterministic
//                        levers) has been seen before. Conversation identity is
//                        irrelevant: six different users sharing one tool belt
//                        share one cache entry.
//   message breakpoint — placed only when the client's raw history extends, as
//                        the product guard already requires.
//
// "Seen before" is the conservative rule: a prefix that never repeats never
// pays a write premium. With a remembered route (the span has repeated on this
// route in the past) the stamp can go on at first sight; `stampOnFirstSight`
// models that steady state.
//
// Lossless and content-blind: it reads hashes and decides WHERE breakpoints go.
// The bytes the model reads are exactly what the reducer already sends.

import { createHash } from "node:crypto";
import { CachePrefixVolatilityGuard } from "../../packages/sdk-js/src/cache-volatility-guard.js";
import { reduceRequest, type MeshTokenReductionConfig } from "../../packages/sdk-js/src/reduce-request.js";

type AnyObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is AnyObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const carriesStamp = (value: unknown): boolean => JSON.stringify(value ?? null).includes('"cache_control"');

const withoutCacheControl = (value: unknown): string =>
  JSON.stringify(value ?? null, (key, inner) => (key === "cache_control" ? undefined : inner));

/**
 * The part of a (reduced, stamped) system prompt a cache breakpoint covers:
 * every block up to and including the last one carrying `cache_control`. A
 * system with no breakpoint is returned whole.
 */
export function stampedSystemSpan(system: unknown): unknown {
  if (!Array.isArray(system)) return system ?? null;
  let last = -1;
  system.forEach((block, index) => {
    if (isPlainObject(block) && "cache_control" in block) last = index;
  });
  return last < 0 ? system : system.slice(0, last + 1);
}

/** Hash of the bytes the provider would match for the system breakpoint. */
export function stampedSpanKey(reduced: AnyObject): string | undefined {
  if (!Array.isArray(reduced.system) || !carriesStamp(reduced.system)) return undefined;
  return createHash("sha256")
    .update(`${withoutCacheControl(reduced.tools ?? [])}\n${withoutCacheControl(stampedSystemSpan(reduced.system))}`)
    .digest("hex")
    .slice(0, 32);
}

function stripMessageStamps(request: AnyObject): AnyObject {
  if (!Array.isArray(request.messages)) return request;
  return {
    ...request,
    messages: JSON.parse(
      JSON.stringify(request.messages, (key, inner) => (key === "cache_control" ? undefined : inner)),
    ) as unknown[],
  };
}

export type SpanStampOutcome = {
  request: AnyObject;
  systemStamped: boolean;
  messageStamped: boolean;
  /** Why the system breakpoint was or was not placed. */
  reason: "no-stampable-span" | "first-sight" | "span-repeats";
};

export class SpanKeyedStamper {
  private readonly seen = new Set<string>();
  /** Only its history check is used: the prefix it sees is held constant. */
  private readonly historyGuard = new CachePrefixVolatilityGuard();
  private readonly base: MeshTokenReductionConfig;
  private readonly ttl: "5m" | "1h";

  constructor(
    config: MeshTokenReductionConfig,
    private readonly options: { stampOnFirstSight?: boolean } = {},
  ) {
    const { cacheVolatilityGuard: _guard, onReduction: _callback, cacheTtl, ...rest } = config;
    this.base = rest;
    this.ttl = cacheTtl ?? "5m";
  }

  reduce(request: AnyObject): SpanStampOutcome {
    const unstamped = reduceRequest(request, this.base).request as AnyObject;
    const stamped = reduceRequest(request, { ...this.base, cacheTtl: this.ttl }).request as AnyObject;

    // Always observe, so the history guard's state stays in step with traffic.
    const historyExtends = this.historyGuard.observe({
      model: request.model,
      tools: null,
      system: null,
      messages: request.messages,
    }).messageBreakpoint !== false;

    const key = stampedSpanKey(stamped);
    if (key === undefined) {
      return { request: unstamped, systemStamped: false, messageStamped: false, reason: "no-stampable-span" };
    }
    const repeats = this.seen.has(key);
    this.seen.add(key);
    if (!repeats && !this.options.stampOnFirstSight) {
      return { request: unstamped, systemStamped: false, messageStamped: false, reason: "first-sight" };
    }

    const result = historyExtends ? stamped : stripMessageStamps(stamped);
    return {
      request: result,
      systemStamped: true,
      messageStamped: Array.isArray(result.messages) && carriesStamp(result.messages),
      reason: repeats ? "span-repeats" : "first-sight",
    };
  }
}
