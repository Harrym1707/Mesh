import { createHash } from "node:crypto";

/**
 * Shared-prefix fan-out cache-race repair.
 *
 * A provider prompt cache does not create an entry until the write that
 * produces it has started returning a response — a cache read requires a
 * previously WRITTEN span, and "written" means committed, not merely sent.
 * When several requests that share a long stable prefix (system + tools) are
 * dispatched at the same instant — the normal shape of a multi-agent fan-out,
 * where an orchestrator starts several sub-agents in parallel (LangGraph's
 * `Send` API runs them in the same superstep; CrewAI's `akickoff_for_each` /
 * `asyncio.gather` pattern does the same) — every one of them arrives before
 * any of the others has a cache entry to read. All of them miss. All of them
 * pay the write premium, instead of one write and N-1 cheap reads.
 *
 * The fix changes nothing the model reads: it only changes WHEN the proxy
 * sends each racer upstream. The first request for a given prefix is sent
 * immediately (the "leader"); every other request that arrives for the same
 * prefix while the leader is still in flight is held until the leader's
 * response begins (or a bounded timeout elapses, so a leader that errors or
 * stalls can never hang a follower — it just proceeds exactly as it would
 * without this lever, at ordinary cost). By the time a held request is
 * released, the leader's write has committed, so the provider serves it from
 * cache instead of racing a second write.
 *
 * This is deliberately NOT applied by default. Hold time is a real latency
 * cost (a client is billed in wall-clock, not model-visible, cost for
 * waiting), and `maxHoldMs` is a configuration guess until it is calibrated
 * against a cold write's measured time-to-first-byte for the prefix's actual
 * size — see the adversarial conditions on lever P5 in
 * `docs/rnd/lever-backlog.md`. Opt in with `fanOutLatch: true` wherever the
 * caller has confirmed held-request latency is acceptable for that route.
 */

export type FanOutPrefixParts = {
  model?: string;
  tools?: unknown;
  system?: unknown;
};

/**
 * The same {model, tools, system} span the cache stamp and the volatility
 * guard key on: the part of the request a provider's longest-prefix match
 * actually depends on. Two requests with this hash equal are racing to write
 * (or read) the exact same cache entry.
 */
export function fanOutPrefixHash(parts: FanOutPrefixParts): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.model ?? null, parts.tools ?? null, parts.system ?? null]))
    .digest("hex");
}

export type FanOutLatchOptions = {
  /**
   * A follower proceeds unconditionally after this many milliseconds even if
   * the leader never releases it — a stalled or errored leader must never
   * hang another request. Default 5000ms; callers with their own measured
   * cold-write TTFB for a prefix's size should pass that instead.
   */
  maxHoldMs?: number;
};

type Hold = { release: () => void };

/**
 * One latch per proxy process (or per route, if routes should not block each
 * other). Not persisted and not shared across processes: a latch only needs
 * to outlive the handful of milliseconds between racing requests, and a
 * process restart mid-race simply drops back to the unlatched (both-write)
 * outcome, never to a hang.
 */
export class FanOutLatch {
  private readonly inFlight = new Map<string, Hold[]>();
  private readonly maxHoldMs: number;

  constructor(options: FanOutLatchOptions = {}) {
    const maxHoldMs = options.maxHoldMs ?? 5_000;
    if (!Number.isFinite(maxHoldMs) || maxHoldMs < 0) {
      throw new Error("maxHoldMs must be a non-negative number.");
    }
    this.maxHoldMs = maxHoldMs;
  }

  /**
   * Register arrival for `prefixHash`. The first caller in flight for that
   * prefix is the leader and returns immediately. Every later caller, while
   * the leader has not yet released the prefix, is held (awaits here) until
   * `release` is called for it or `maxHoldMs` elapses, then returns.
   *
   * Call once per upstream request, before sending it, and always pair with
   * exactly one `release` call for every `acquire` that returned `"leader"`
   * (in a `finally`, so an error releases followers too).
   */
  async acquire(prefixHash: string): Promise<"leader" | "follower"> {
    const holders = this.inFlight.get(prefixHash);
    if (holders === undefined) {
      this.inFlight.set(prefixHash, []);
      return "leader";
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.maxHoldMs);
      holders.push({ release: () => { clearTimeout(timer); resolve(); } });
    });
    return "follower";
  }

  /**
   * The leader's response for `prefixHash` has started arriving (or failed).
   * Releases every request held on it and clears the prefix so the next
   * arrival becomes a fresh leader. A no-op if nothing is held — safe to call
   * even when `acquire` was never invoked for this prefix.
   */
  release(prefixHash: string): void {
    const holders = this.inFlight.get(prefixHash);
    if (holders === undefined) return;
    this.inFlight.delete(prefixHash);
    for (const holder of holders) holder.release();
  }

  /** Prefixes currently held open (diagnostic only). */
  get size(): number {
    return this.inFlight.size;
  }
}
