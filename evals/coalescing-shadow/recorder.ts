import { createHash } from "node:crypto";

/**
 * Shadow-mode recorder for the in-flight request-coalescing candidate (S2 in
 * docs/rnd/cost-reduction-rnd-2026-11-04.md).
 *
 * It OBSERVES the request path and never changes it: no request is held, merged
 * or de-duplicated. It emits one content-free event per request boundary so an
 * offline analyzer (analyze.ts) can reconstruct which byte-identical requests
 * were concurrently in flight and would have collapsed under a real single-flight
 * latch. The point is to turn S2's "project 0, bill realised-only" into a measured
 * duplicate-burst rate on real traffic WITHOUT touching behaviour or making a call.
 *
 * Privacy (matches the proxy's blind-feature-stream ethos): the only identifiers
 * that leave are irreversible SHA-256 hashes (of the canonical request and of the
 * scope key) plus structural fields — model name, timestamps, provider-reported
 * usage, and an ineligibility reason. No request or response content is recorded.
 *
 * Keying MIRRORS packages/sdk-js/src/exact-cache.ts (ExactResponseCache.keyFor /
 * canonicalJson) deliberately, so the measured keys match what a real coalescer
 * built on the same canonicalization would collapse. It is inlined rather than
 * imported so this R&D prototype stays decoupled from packages/ (which is mid
 * Flux->Mesh rename). If this graduates into the SDK, delete the copy and call the
 * SDK's own keyer. KEEP IN SYNC until then.
 */

export type ShadowUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

export type ShadowEvent = {
  phase: "start" | "end";
  /** Monotonic per-process id; pairs a start with its end. */
  id: number;
  /** SHA-256 of `scopeKey\n<canonical request>`. Irreversible, content-free. Absent when not coalesce-keyable. */
  keyHash?: string;
  /** SHA-256 of the scope key: buckets a tenant/user/job without revealing it. */
  scopeHash?: string;
  /** Model name (low-sensitivity, useful for splitting). */
  model?: string;
  /** Why the request carries no key (so the analyzer can report the eligible/ineligible split). */
  ineligible?: string;
  /**
   * Set on a keyed request that is keyable but would need the caller to opt in,
   * because it is not provably deterministic (e.g. temperature > 0, no seed).
   * The analyzer separates "safe" coalescing from "needs opt-in" coalescing.
   */
  gated?: string;
  /** Epoch ms. */
  t: number;
  /** End only: provider-reported usage — the cost a coalesced follower would avoid. */
  usage?: ShadowUsage;
};

export type ShadowRecorderConfig = {
  /**
   * Non-sensitive tenant/user/job id. Returning undefined removes the request from
   * the measurement entirely (same scope gating as ExactResponseCache).
   */
  getScopeKey: (request: unknown) => string | undefined;
  /** Sink for content-free events (append to a JSONL file, push to an array, etc.). */
  emit: (event: ShadowEvent) => void;
  /** Injectable clock for tests. */
  now?: () => number;
  /**
   * Apply the determinism gate (temperature 0 or a seed). Default true: a
   * non-deterministic request is marked `gated: "nondeterministic"` but still keyed,
   * so the analyzer can report both the safe band and the opt-in band. (Structural
   * exclusions below are always hard — they can never be coalesced.)
   */
  gateNondeterministic?: boolean;
};

export type ShadowHandle = { id: number; keyHash?: string; recorded: boolean };

/** Mirror of exact-cache.ts canonicalJson — stable, order-independent JSON for keying. */
function canonicalJson(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const values = value.map((item) => canonicalJson(item, seen));
    seen.delete(value);
    return values.some((item) => item === undefined) ? undefined : `[${values.join(",")}]`;
  }
  if (typeof value !== "object" ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return undefined;
  }
  if (seen.has(value)) return undefined;
  seen.add(value);
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).sort().map((key) => {
    const child = canonicalJson(record[key], seen);
    return child === undefined ? undefined : `${JSON.stringify(key)}:${child}`;
  });
  seen.delete(value);
  return entries.some((entry) => entry === undefined) ? undefined : `{${entries.join(",")}}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

type Classification = { keyHash?: string; ineligible?: string; gated?: string; model?: string };

/**
 * Decide whether a request is coalesce-keyable, mirroring ExactResponseCache.keyFor
 * exclusions plus the report's determinism gate. Structural exclusions are hard;
 * the determinism gate is soft (keyed but flagged) so the full landscape is visible.
 */
export function classifyRequest(
  request: unknown,
  scopeKey: string,
  gateNondeterministic: boolean,
): Classification {
  if (!request || typeof request !== "object") return { ineligible: "non-object" };
  const body = request as Record<string, unknown>;
  const model = typeof body.model === "string" ? body.model : undefined;
  // Hard exclusions: these can never be safely served from one shared response.
  if (body.stream === true) return { ineligible: "streaming", model };
  if (body.tools !== undefined) return { ineligible: "tools", model };
  if (body.tool_choice !== undefined) return { ineligible: "tool_choice", model };
  if (body.previous_response_id !== undefined) return { ineligible: "responses-chain", model };
  if (body.conversation !== undefined) return { ineligible: "conversation", model };
  const serialized = canonicalJson(request);
  if (serialized === undefined) return { ineligible: "unserializable", model };
  const keyHash = sha256(`${scopeKey}\n${serialized}`);
  // Soft gate: a shared sample across callers freezes randomness, so non-deterministic
  // requests are keyed but flagged — coalescing them needs explicit opt-in.
  const deterministic = body.temperature === 0 || typeof body.seed === "number";
  if (gateNondeterministic && !deterministic) return { keyHash, gated: "nondeterministic", model };
  return { keyHash, model };
}

export class ShadowCoalescingRecorder {
  private seq = 0;
  constructor(private readonly config: ShadowRecorderConfig) {}

  private now(): number {
    return this.config.now ? this.config.now() : Date.now();
  }

  /** Call at request admission. Emits a `start` event. Pair the returned handle with `end`. */
  begin(request: unknown): ShadowHandle {
    const id = ++this.seq;
    const scopeKey = this.config.getScopeKey(request);
    if (typeof scopeKey !== "string" || scopeKey.trim() === "") {
      return { id, recorded: false }; // out of scope → not measured, like ExactResponseCache
    }
    const { keyHash, ineligible, gated, model } = classifyRequest(
      request,
      scopeKey,
      this.config.gateNondeterministic ?? true,
    );
    this.config.emit({
      phase: "start",
      id,
      t: this.now(),
      scopeHash: sha256(scopeKey),
      ...(keyHash ? { keyHash } : {}),
      ...(ineligible ? { ineligible } : {}),
      ...(gated ? { gated } : {}),
      ...(model ? { model } : {}),
    });
    return { id, keyHash, recorded: true };
  }

  /** Call when the upstream response completes (or errors). Emits an `end` event. */
  end(handle: ShadowHandle, usage?: ShadowUsage): void {
    if (!handle.recorded) return;
    this.config.emit({
      phase: "end",
      id: handle.id,
      t: this.now(),
      ...(handle.keyHash ? { keyHash: handle.keyHash } : {}),
      ...(usage ? { usage } : {}),
    });
  }
}
