import { createHash } from "node:crypto";

/**
 * Shared-prefix fan-out serialization (lever backlog P5).
 *
 * A provider's prompt cache entry exists only once the WRITING request's
 * first response bytes arrive — not at send time. A multi-agent orchestrator
 * that fans several sub-agents out at once, all carrying the same system +
 * tools block, sends them before any of them could have registered a write:
 * every one of them pays the write premium (1.25x / 2x on Anthropic), and
 * none of them reads. This is pure send-timing waste — the bytes each
 * sub-agent sends are untouched by MESH either way.
 *
 * The latch fixes the timing without touching content: the first request for
 * a given shared-prefix key proceeds immediately; any other request for the
 * SAME key that arrives while the first is still in flight is held until the
 * first is released (its response started, or it failed, or a hold cap
 * elapses) — by which point the provider's cache entry has had a chance to
 * register, so the held request reads instead of racing a second write.
 *
 * This is deliberately conservative:
 *  - keyed only on the stable {tools, system} prefix (the part a fan-out
 *    shares), never on the per-agent task, so sub-agents with genuinely
 *    different prefixes never contend;
 *  - bounded by a hold cap, so a slow or hung first request can never stall
 *    the others indefinitely — a timed-out hold just proceeds as a normal
 *    (uncollided) request would have, at worst forfeiting this round's
 *    saving, never breaking the request;
 *  - release-on-error: the caller MUST release on both success and failure
 *    (a `finally`), so a failed first request never wedges its racers;
 *  - no mutation of any request body — only WHEN a held request is allowed
 *    to proceed changes, never WHAT is sent.
 *
 * What this module does NOT yet do (see docs/rnd/ for the open items): log
 * real arrival timestamps for a live collision-rate measurement, or decide
 * on its own whether a given key is "stamp-approved" / above the per-model
 * cache minimum — callers are expected to key only requests that already
 * clear that bar (the same guards the cache-TTL stamp itself applies).
 */

export type FanOutLatchOptions = {
  /**
   * Longest time a held request may wait for the racer ahead of it, in
   * milliseconds. Should be well under the caller's own request timeout —
   * a held request that times out here still proceeds (unlatched), it just
   * forfeits the serialization saving for that round. Required: there is no
   * safe default duration, since it must relate to the caller's own TTFB
   * budget for the sizes of prefix it actually sends.
   */
  holdCapMs: number;
};

type InFlight = {
  waiters: Array<() => void>;
};

/**
 * Key a latch on exactly the bytes a cache breakpoint would cover — the
 * stable {tools, system} prefix MESH would stamp — never on the full request
 * (which differs per sub-agent) and never on raw, un-transformed bytes (the
 * latch must key on what will actually be SENT, after MESH's own lossless
 * transforms, or two requests that only differ before those transforms run
 * would be wrongly treated as distinct).
 */
export function fanOutLatchKey(reducedRequest: { tools?: unknown; system?: unknown; model?: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify([reducedRequest.model ?? null, reducedRequest.tools ?? null, reducedRequest.system ?? null]) ?? "null")
    .digest("hex");
}

/**
 * Holds concurrent same-key requests behind an in-flight latch. Call
 * `acquire(key)` immediately before dispatching a request upstream; await
 * its result, then call the returned `release()` exactly once, in a
 * `finally`, as soon as the response's first bytes (or an error) are known.
 */
export class FanOutLatch {
  private readonly holdCapMs: number;
  private readonly inFlight = new Map<string, InFlight>();
  /** Diagnostics only — never affects request content or billing by itself. */
  private heldCount = 0;
  private timedOutCount = 0;

  constructor(options: FanOutLatchOptions) {
    if (!Number.isFinite(options.holdCapMs) || options.holdCapMs <= 0) {
      throw new Error("FanOutLatch requires a positive holdCapMs.");
    }
    this.holdCapMs = options.holdCapMs;
  }

  async acquire(key: string): Promise<() => void> {
    const current = this.inFlight.get(key);
    if (current === undefined) {
      const entry: InFlight = { waiters: [] };
      this.inFlight.set(key, entry);
      let released = false;
      return () => {
        if (released) return; // idempotent: a caller that releases twice never double-frees the slot
        released = true;
        if (this.inFlight.get(key) !== entry) return;
        this.inFlight.delete(key);
        for (const wake of entry.waiters) wake();
      };
    }

    this.heldCount += 1;
    let timedOut = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), this.holdCapMs);
      current.waiters.push(() => {
        timedOut = false;
        clearTimeout(timer);
        resolve();
      });
    });
    if (!timedOut) {
      // The racer ahead released — its write should now be readable.
      // Re-enter acquire() so a THIRD simultaneous racer queues correctly
      // behind whichever of us becomes the new holder.
      return this.acquire(key);
    }
    // The hold cap elapsed and the racer ahead STILL hasn't released (it may
    // be hung, slow, or simply slower than our budget). Proceed unlatched
    // rather than stall forever: this forfeits this round's serialization
    // saving, but a stuck holder must never be able to wedge its racers. Do
    // NOT recurse into acquire() here — the still-outstanding holder is
    // still the map's entry, so recursing would just re-queue and time out
    // again, every holdCapMs, for as long as that holder never releases.
    this.timedOutCount += 1;
    return () => {}; // no-op: never held the slot, so there is nothing to free
  }

  /** Diagnostics snapshot: never used to decide billing, only to watch for breach conditions. */
  stats(): { inFlightKeys: number; heldCount: number; timedOutCount: number } {
    return { inFlightKeys: this.inFlight.size, heldCount: this.heldCount, timedOutCount: this.timedOutCount };
  }
}
