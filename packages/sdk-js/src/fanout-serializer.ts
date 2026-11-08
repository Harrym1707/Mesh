import { createHash } from "node:crypto";

/**
 * Shared-prefix fan-out serialization: the in-flight latch behind the
 * `serializeFanoutWrites` proxy option.
 *
 * Provider rule: a prompt-cache entry exists only once the FIRST response
 * that wrote it has started (its headers have arrived) — not at the moment
 * that request was sent. Multiple requests sharing an identical cacheable
 * prefix (tools + system), dispatched before that moment, cannot see each
 * other: every one of them misses the cache and pays the write premium.
 * This is the common shape of multi-agent fan-out — several sub-agents
 * sharing one system prompt and tool catalogue, launched together in a
 * single batch (the Claude Agent SDK's own documented behaviour for a
 * parallel `Agent` call: several calls issued in one message, "launching
 * all of them simultaneously") — where the skew between dispatch times is
 * event-loop/network jitter, not a deliberate gap, and is reliably smaller
 * than the time a cache write of any real size takes to become visible.
 *
 * FanoutSerializer holds every request but the first, for a given prefix
 * key, until the first's response has started (or errored, or the hold cap
 * elapses), then releases them together so they are sent only once they
 * can actually READ the entry instead of racing to write it again. This
 * changes nothing the model reads — only WHEN a request leaves the proxy —
 * so it is lossless: no replay gate applies, the same category as the
 * cache-stamp metadata change it rides alongside.
 *
 * Fails open by construction: a hold past `maxHoldMs`, or the first
 * request erroring, releases every waiter immediately. A released waiter
 * proceeds exactly as if this lever did not exist for it — a stall here
 * must never become a client-visible failure (the proxy's own rule).
 */
export type FanoutSerializerOptions = {
  /**
   * Upper bound on how long a waiter may be held, in milliseconds. Must
   * exceed the slowest write this deployment's prefixes will see — a cap
   * tighter than that turns the lever into added latency for no saving,
   * since the waiter still has to query at the end anyway.
   */
  maxHoldMs?: number;
};

type Gate = {
  settled: boolean;
  waiters: Array<() => void>;
  timer: NodeJS.Timeout;
};

export class FanoutSerializer {
  private readonly gates = new Map<string, Gate>();
  private readonly maxHoldMs: number;

  constructor(options: FanoutSerializerOptions = {}) {
    this.maxHoldMs = options.maxHoldMs ?? 5_000;
    if (!Number.isFinite(this.maxHoldMs) || this.maxHoldMs <= 0) {
      throw new Error("maxHoldMs must be a positive number.");
    }
  }

  /**
   * Call before sending a request for `key`. Resolves `true` when the
   * caller is first for this key — it must send its own request right away
   * and call `release(key)` itself once that request's response has
   * started, or on error — and `false` when another request for the same
   * key is already in flight, in which case this call does not resolve
   * until that first request is released (by it, by its error path, or by
   * the hold cap), at which point the caller sends its own request as a
   * normal read.
   */
  async admit(key: string): Promise<boolean> {
    const existing = this.gates.get(key);
    if (existing === undefined) {
      const timer = setTimeout(() => this.release(key), this.maxHoldMs);
      timer.unref();
      this.gates.set(key, { settled: false, waiters: [], timer });
      return true;
    }
    if (existing.settled) return true; // already resolved; nothing to hold for
    await new Promise<void>((resolve) => existing.waiters.push(resolve));
    return false;
  }

  /**
   * Release every request currently held for `key`. Call this once the
   * first request's response has started (success) or failed (so held
   * requests are never stuck behind a request that is never coming back).
   * Idempotent: a second call for an already-released key is a no-op.
   */
  release(key: string): void {
    const gate = this.gates.get(key);
    if (gate === undefined || gate.settled) return;
    gate.settled = true;
    clearTimeout(gate.timer);
    const waiters = gate.waiters;
    gate.waiters = [];
    for (const resolve of waiters) resolve();
    // Keep the settled gate around briefly: a request that arrives just
    // after release, for the same key, should see "already available" and
    // proceed at once rather than opening a fresh hold for no reason.
    const cleanup = setTimeout(() => {
      if (this.gates.get(key) === gate) this.gates.delete(key);
    }, this.maxHoldMs);
    cleanup.unref();
  }

  /** Waiters currently held for `key` (0 when none, or the key is unknown). */
  pendingCount(key: string): number {
    return this.gates.get(key)?.waiters.length ?? 0;
  }
}

/**
 * The cacheable prefix a fan-out race is keyed on: model + tools + system,
 * the exact span the provider's longest-exact-prefix match covers before
 * message content. Two requests with the same key would write the same
 * provider cache entry if sent at the same instant.
 */
export function cacheablePrefixKey(request: unknown): string {
  const body = (typeof request === "object" && request !== null)
    ? (request as Record<string, unknown>)
    : {};
  return createHash("sha256")
    .update(JSON.stringify([body.model ?? null, body.tools ?? null, body.system ?? null]))
    .digest("hex");
}
