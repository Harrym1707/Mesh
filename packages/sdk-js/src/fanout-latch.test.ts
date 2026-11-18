import { describe, expect, it, vi } from "vitest";
import { FanoutLatch } from "./fanout-latch.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("FanoutLatch", () => {
  it("rejects a non-positive holdCapMs", () => {
    expect(() => new FanoutLatch({ holdCapMs: 0 })).toThrow(/positive holdCapMs/);
    expect(() => new FanoutLatch({ holdCapMs: -5 })).toThrow(/positive holdCapMs/);
    expect(() => new FanoutLatch({ holdCapMs: Number.NaN })).toThrow(/positive holdCapMs/);
  });

  it("dispatches the first racer on a key immediately, as the leader", async () => {
    const latch = new FanoutLatch({ holdCapMs: 5_000 });
    const dispatch = vi.fn(async () => "ok");
    const outcome = await latch.run("prefix-a", dispatch);
    expect(outcome).toEqual({ result: "ok", role: "leader" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("holds a follower until the leader's dispatch resolves, then dispatches it", async () => {
    const latch = new FanoutLatch({ holdCapMs: 5_000 });
    const leaderGate = deferred<string>();
    const leaderDispatch = vi.fn(() => leaderGate.promise);
    const followerDispatch = vi.fn(async () => "follower-result");

    const leaderCall = latch.run("prefix-a", leaderDispatch);
    // Give the leader branch a microtask to register itself before the follower arrives.
    await Promise.resolve();
    const followerCall = latch.run("prefix-a", followerDispatch);

    // The follower must not have dispatched yet: the leader hasn't settled.
    await Promise.resolve();
    await Promise.resolve();
    expect(followerDispatch).not.toHaveBeenCalled();

    leaderGate.resolve("leader-result");
    const [leaderOutcome, followerOutcome] = await Promise.all([leaderCall, followerCall]);

    expect(leaderOutcome).toEqual({ result: "leader-result", role: "leader" });
    expect(followerOutcome.role).toBe("follower");
    expect(followerOutcome.result).toBe("follower-result");
    expect(followerOutcome.heldMs).toBeGreaterThanOrEqual(0);
    expect(followerDispatch).toHaveBeenCalledTimes(1);
  });

  it("releases a follower immediately when the leader fails, rather than waiting the hold cap", async () => {
    const latch = new FanoutLatch({ holdCapMs: 60_000 });
    const leaderGate = deferred<never>();
    const leaderDispatch = vi.fn(() => leaderGate.promise);
    const followerDispatch = vi.fn(async () => "follower-result");

    const leaderCall = latch.run("prefix-a", leaderDispatch).catch((error: unknown) => error);
    await Promise.resolve();
    const followerCall = latch.run("prefix-a", followerDispatch);

    leaderGate.reject(new Error("upstream unreachable"));
    const leaderOutcome = await leaderCall;
    expect(leaderOutcome).toBeInstanceOf(Error);

    // The follower should proceed right away (well under the 60s hold cap),
    // not be stuck waiting for it.
    const followerOutcome = await followerCall;
    expect(followerOutcome.role).toBe("follower");
    expect(followerDispatch).toHaveBeenCalledTimes(1);
  });

  it("releases a follower after the hold cap when the leader never settles", async () => {
    vi.useFakeTimers();
    try {
      const latch = new FanoutLatch({ holdCapMs: 1_000 });
      const leaderDispatch = vi.fn(() => new Promise<string>(() => {})); // never settles
      const followerDispatch = vi.fn(async () => "follower-result");

      const leaderCall = latch.run("prefix-a", leaderDispatch);
      void leaderCall; // intentionally never awaited: the leader hangs forever
      await Promise.resolve();
      const followerCall = latch.run("prefix-a", followerDispatch);

      await vi.advanceTimersByTimeAsync(999);
      expect(followerDispatch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const followerOutcome = await followerCall;
      expect(followerOutcome.role).toBe("follower");
      expect(followerDispatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not block racers on a different prefix key", async () => {
    const latch = new FanoutLatch({ holdCapMs: 5_000 });
    const leaderGate = deferred<string>();
    const leaderDispatch = vi.fn(() => leaderGate.promise);
    const otherDispatch = vi.fn(async () => "other-result");

    const leaderCall = latch.run("prefix-a", leaderDispatch);
    await Promise.resolve();
    const otherOutcome = await latch.run("prefix-b", otherDispatch);

    expect(otherOutcome).toEqual({ result: "other-result", role: "leader" });
    leaderGate.resolve("leader-result");
    await leaderCall;
  });

  it("starts a fresh leader once the prior leader has fully settled and cleaned up", async () => {
    const latch = new FanoutLatch({ holdCapMs: 5_000 });
    const first = await latch.run("prefix-a", async () => "first");
    expect(first.role).toBe("leader");

    const second = await latch.run("prefix-a", async () => "second");
    expect(second.role).toBe("leader");
  });

  it("releases every waiting follower together when the leader settles", async () => {
    const latch = new FanoutLatch({ holdCapMs: 5_000 });
    const leaderGate = deferred<string>();
    const leaderDispatch = vi.fn(() => leaderGate.promise);
    const followerA = vi.fn(async () => "a");
    const followerB = vi.fn(async () => "b");
    const followerC = vi.fn(async () => "c");

    const leaderCall = latch.run("prefix-a", leaderDispatch);
    await Promise.resolve();
    const calls = [
      latch.run("prefix-a", followerA),
      latch.run("prefix-a", followerB),
      latch.run("prefix-a", followerC),
    ];

    await Promise.resolve();
    await Promise.resolve();
    expect(followerA).not.toHaveBeenCalled();
    expect(followerB).not.toHaveBeenCalled();
    expect(followerC).not.toHaveBeenCalled();

    leaderGate.resolve("leader-result");
    await leaderCall;
    const outcomes = await Promise.all(calls);
    expect(outcomes.every((outcome) => outcome.role === "follower")).toBe(true);
    expect(followerA).toHaveBeenCalledTimes(1);
    expect(followerB).toHaveBeenCalledTimes(1);
    expect(followerC).toHaveBeenCalledTimes(1);
  });
});
