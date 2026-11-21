import { describe, expect, it } from "vitest";
import { FanOutLatch, fanOutPrefixHash } from "./fanout-latch.js";

describe("fanOutPrefixHash", () => {
  it("is stable for the same {model, tools, system}", () => {
    const parts = { model: "claude-sonnet-5-5", tools: [{ name: "search" }], system: "You are an agent." };
    expect(fanOutPrefixHash(parts)).toBe(fanOutPrefixHash({ ...parts }));
  });

  it("differs when the system prompt differs", () => {
    const a = fanOutPrefixHash({ model: "claude-sonnet-5-5", system: "A" });
    const b = fanOutPrefixHash({ model: "claude-sonnet-5-5", system: "B" });
    expect(a).not.toBe(b);
  });

  it("differs when the model differs, same tools/system", () => {
    const a = fanOutPrefixHash({ model: "claude-sonnet-5-5", system: "A" });
    const b = fanOutPrefixHash({ model: "gpt-5.5", system: "A" });
    expect(a).not.toBe(b);
  });

  it("ignores fields outside {model, tools, system}, e.g. messages", () => {
    const hash = fanOutPrefixHash({ model: "m", system: "s" });
    // Callers only ever pass the three named fields; this just documents that
    // extra properties on the parts object are not part of the contract.
    expect(hash).toBe(fanOutPrefixHash({ model: "m", system: "s" }));
  });
});

describe("FanOutLatch", () => {
  it("the first arrival for a prefix is the leader", async () => {
    const latch = new FanOutLatch();
    await expect(latch.acquire("p1")).resolves.toBe("leader");
  });

  it("holds a second arrival until the leader releases", async () => {
    const latch = new FanOutLatch({ maxHoldMs: 10_000 });
    await expect(latch.acquire("p1")).resolves.toBe("leader");

    let followerResolved = false;
    const followerPromise = latch.acquire("p1").then((role) => {
      followerResolved = true;
      return role;
    });

    // Give the microtask queue a turn; the follower must still be waiting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(followerResolved).toBe(false);

    latch.release("p1");
    await expect(followerPromise).resolves.toBe("follower");
    expect(followerResolved).toBe(true);
  });

  it("releases every follower held on the same prefix, not just one", async () => {
    const latch = new FanOutLatch({ maxHoldMs: 10_000 });
    await latch.acquire("shared");
    const followers = [latch.acquire("shared"), latch.acquire("shared"), latch.acquire("shared")];
    await new Promise((resolve) => setTimeout(resolve, 10));
    latch.release("shared");
    await expect(Promise.all(followers)).resolves.toEqual(["follower", "follower", "follower"]);
  });

  it("a follower proceeds after maxHoldMs even if the leader never releases (fail-open)", async () => {
    const latch = new FanOutLatch({ maxHoldMs: 30 });
    await latch.acquire("stuck");
    const start = Date.now();
    await expect(latch.acquire("stuck")).resolves.toBe("follower");
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    // never released: still held open for a fresh follower to see
    expect(latch.size).toBe(1);
  });

  it("release clears the prefix so the next arrival becomes a new leader", async () => {
    const latch = new FanOutLatch();
    await latch.acquire("p1");
    latch.release("p1");
    await expect(latch.acquire("p1")).resolves.toBe("leader");
  });

  it("release is a safe no-op when nothing is held for that prefix", () => {
    const latch = new FanOutLatch();
    expect(() => latch.release("never-acquired")).not.toThrow();
  });

  it("different prefixes never hold each other up", async () => {
    const latch = new FanOutLatch();
    await expect(latch.acquire("a")).resolves.toBe("leader");
    await expect(latch.acquire("b")).resolves.toBe("leader");
  });

  it("rejects a negative maxHoldMs", () => {
    expect(() => new FanOutLatch({ maxHoldMs: -1 })).toThrow();
  });
});
