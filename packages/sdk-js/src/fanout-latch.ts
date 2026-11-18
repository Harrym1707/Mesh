/**
 * Lossless cache-race repair for concurrent fan-out requests sharing a
 * stamped prefix.
 *
 * Anthropic's own docs state the mechanism this exists for: "For concurrent
 * requests, note that a cache entry only becomes available after the first
 * response starts. If you need cache hits for parallel requests, wait for
 * the first response before sending subsequent requests." (platform.claude
 * .com/docs/en/build-with-claude/prompt-caching, "Cache limitations",
 * fetched 2026-11-18.) A multi-agent orchestrator that fires N sub-agent
 * calls sharing one system+tool prefix in the same instant — the Claude
 * Agent SDK's own documented pattern ("Parallelization: multiple subagents
 * can run concurrently... During a code review, you can run style-checker,
 * security-scanner, and test-coverage subagents simultaneously instead of
 * sequentially", code.claude.com/docs/en/agent-sdk/subagents, fetched
 * 2026-11-18) — is exactly this race: every racer arrives before any of them
 * has a response, so every one of them WRITES the shared prefix (1.25x/2x
 * base) instead of READING it (0.05x-0.1x base), and a cache stamp earns
 * nothing on N-1 of them.
 *
 * The fix changes nothing about what is sent — bytes identical, only send
 * TIMING moves — which is why this is lossless and carries no replay-gate
 * requirement. FanoutLatch lets the first same-prefix request through
 * immediately (the "leader") and holds every other request on that prefix (a
 * "follower") until the leader's dispatch settles, so the followers' own
 * requests arrive after the provider's cache entry exists and have a chance
 * to read it instead of re-writing it.
 *
 * NOT validated on real traffic. This is a coordination primitive with full
 * unit coverage; wiring it onto a live dispatch path is the caller's choice
 * (see `MeshProxyOptions.fanoutLatch`, which ships off by default). Holding a
 * real request back from a real dispatch is a latency and timeout risk, not
 * only a pricing one — `holdCapMs` must be sized to the shared prefix's own
 * measured cold-write time-to-first-byte (see docs/rnd/ for the open
 * measurement this still owes), never guessed, and callers must keep their
 * own client-side timeouts wide enough to absorb it.
 */

export type FanoutLatchOptions = {
  /**
   * How long a follower waits for its leader before dispatching unlatched.
   * There is no default: sizing this too low defeats the lever (followers
   * release before the leader's cache write has landed); sizing it too high
   * risks stranding a follower past its own caller's timeout. It must come
   * from a measurement of the shared prefix's own cold-write latency, not a
   * guess.
   */
  holdCapMs: number;
};

export type FanoutOutcome<T> = {
  result: T;
  /** "leader" dispatched immediately; "follower" waited on another racer first. */
  role: "leader" | "follower";
  /** Only set for a follower: how long it actually waited, bounded by holdCapMs. */
  heldMs?: number;
};

type PendingLeader = {
  /** Settles the instant the leader's dispatch resolves OR rejects. */
  settled: Promise<void>;
};

function raceWithTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(finish, finish);
  });
}

/**
 * Coordinates racers sharing a cache prefix so only the first of them writes
 * it; every later racer on the same key waits for that write to start (or
 * the hold cap, whichever comes first) before making its own real request.
 */
export class FanoutLatch {
  private readonly pending = new Map<string, PendingLeader>();
  private readonly holdCapMs: number;

  constructor(options: FanoutLatchOptions) {
    if (!Number.isFinite(options.holdCapMs) || options.holdCapMs <= 0) {
      throw new Error(
        "FanoutLatch requires a positive holdCapMs, sized to the shared prefix's own measured cold-write TTFB.",
      );
    }
    this.holdCapMs = options.holdCapMs;
  }

  /**
   * Run `dispatch` for one racer sharing `prefixKey`. The first caller for a
   * key with no racer currently in flight runs immediately as the leader;
   * every later caller before the leader's dispatch settles waits for that
   * settlement (success, failure, or the hold cap, whichever comes first)
   * before running its OWN dispatch — it still makes its own real call, only
   * later, so it has a chance to read what the leader wrote instead of
   * racing it.
   *
   * `dispatch` must resolve (or reject) at the point the caller wants other
   * racers to treat as "the response started" — i.e. once headers/status
   * are available, before draining a stream body — matching Anthropic's own
   * definition of when a cache entry becomes available.
   */
  async run<T>(prefixKey: string, dispatch: () => Promise<T>): Promise<FanoutOutcome<T>> {
    const leader = this.pending.get(prefixKey);
    if (leader === undefined) {
      let release!: () => void;
      const settled = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entry: PendingLeader = { settled };
      this.pending.set(prefixKey, entry);
      try {
        const result = await dispatch();
        return { result, role: "leader" };
      } finally {
        release();
        if (this.pending.get(prefixKey) === entry) this.pending.delete(prefixKey);
      }
    }

    const startedWaitingAt = Date.now();
    await raceWithTimeout(leader.settled, this.holdCapMs);
    const result = await dispatch();
    return { result, role: "follower", heldMs: Date.now() - startedWaitingAt };
  }
}
