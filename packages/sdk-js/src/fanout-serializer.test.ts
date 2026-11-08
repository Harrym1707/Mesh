import { describe, expect, it } from "vitest";
import { FanoutSerializer, cacheablePrefixKey } from "./fanout-serializer.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FanoutSerializer", () => {
  it("admits the first caller for a key immediately", async () => {
    const serializer = new FanoutSerializer();
    await expect(serializer.admit("k")).resolves.toBe(true);
  });

  it("holds a second concurrent caller for the same key until release", async () => {
    const serializer = new FanoutSerializer();
    expect(await serializer.admit("k")).toBe(true);

    let resolved = false;
    const held = serializer.admit("k").then((isFirst) => {
      resolved = true;
      return isFirst;
    });

    await sleep(20);
    expect(resolved).toBe(false); // still held: the first has not released
    expect(serializer.pendingCount("k")).toBe(1);

    serializer.release("k");
    expect(await held).toBe(false); // released as a waiter, not as "first"
    expect(resolved).toBe(true);
  });

  it("does not hold callers for a DIFFERENT key", async () => {
    const serializer = new FanoutSerializer();
    expect(await serializer.admit("a")).toBe(true);
    // A different key is its own, independent race — admitted at once.
    await expect(serializer.admit("b")).resolves.toBe(true);
  });

  it("releases every waiter, not just one, when the first completes", async () => {
    const serializer = new FanoutSerializer();
    expect(await serializer.admit("k")).toBe(true);
    const waiters = [serializer.admit("k"), serializer.admit("k"), serializer.admit("k")];
    await sleep(10);
    expect(serializer.pendingCount("k")).toBe(3);
    serializer.release("k");
    const results = await Promise.all(waiters);
    expect(results).toEqual([false, false, false]);
  });

  it("a release-on-error path (same call) also frees every waiter", async () => {
    const serializer = new FanoutSerializer();
    expect(await serializer.admit("k")).toBe(true);
    const waiting = serializer.admit("k");
    await sleep(10);
    // The "first" request's error path calls release exactly like success —
    // a failed write must never leave racers stuck behind it.
    serializer.release("k");
    await expect(waiting).resolves.toBe(false);
  });

  it("fails open: a waiter is released once the hold cap elapses even if release() is never called", async () => {
    const serializer = new FanoutSerializer({ maxHoldMs: 30 });
    expect(await serializer.admit("k")).toBe(true);
    const waiting = serializer.admit("k");
    await expect(waiting).resolves.toBe(false);
  });

  it("is idempotent: releasing twice, or releasing an unknown key, does not throw", () => {
    const serializer = new FanoutSerializer();
    expect(() => serializer.release("never-admitted")).not.toThrow();
    void serializer.admit("k");
    serializer.release("k");
    expect(() => serializer.release("k")).not.toThrow();
  });

  it("a request arriving just after release for the same key is admitted at once, not held again", async () => {
    const serializer = new FanoutSerializer();
    expect(await serializer.admit("k")).toBe(true);
    serializer.release("k");
    // The entry is now "available" (as in: a provider cache read would
    // succeed) — a later arrival should see that, not open a fresh hold.
    await expect(serializer.admit("k")).resolves.toBe(true);
  });

  it("rejects a non-positive hold cap", () => {
    expect(() => new FanoutSerializer({ maxHoldMs: 0 })).toThrow(/positive/);
    expect(() => new FanoutSerializer({ maxHoldMs: -5 })).toThrow(/positive/);
  });
});

describe("cacheablePrefixKey", () => {
  it("keys on model + tools + system only, ignoring messages", () => {
    const a = cacheablePrefixKey({ model: "m", tools: [1], system: "s", messages: [{ role: "user", content: "x" }] });
    const b = cacheablePrefixKey({ model: "m", tools: [1], system: "s", messages: [{ role: "user", content: "different" }] });
    expect(a).toBe(b);
  });

  it("differs when the tools or system block differs", () => {
    const base = cacheablePrefixKey({ model: "m", tools: [1], system: "s" });
    expect(cacheablePrefixKey({ model: "m", tools: [2], system: "s" })).not.toBe(base);
    expect(cacheablePrefixKey({ model: "m", tools: [1], system: "different" })).not.toBe(base);
    expect(cacheablePrefixKey({ model: "other", tools: [1], system: "s" })).not.toBe(base);
  });

  it("never throws on a malformed request", () => {
    expect(() => cacheablePrefixKey(null)).not.toThrow();
    expect(() => cacheablePrefixKey("not an object")).not.toThrow();
    expect(() => cacheablePrefixKey(undefined)).not.toThrow();
  });
});
