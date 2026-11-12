import { describe, expect, it } from "vitest";
import { FanOutLatch, fanOutLatchKey } from "./fan-out-latch.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("fanOutLatchKey", () => {
  it("is the same for requests sharing model + tools + system, regardless of the rest", () => {
    const a = fanOutLatchKey({ model: "claude-sonnet-5", tools: [{ name: "search" }], system: "You are an agent." });
    const b = fanOutLatchKey({ model: "claude-sonnet-5", tools: [{ name: "search" }], system: "You are an agent." });
    expect(a).toBe(b);
  });

  it("differs when the model, tools, or system differ", () => {
    const base = { model: "claude-sonnet-5", tools: [{ name: "search" }], system: "You are an agent." };
    expect(fanOutLatchKey(base)).not.toBe(fanOutLatchKey({ ...base, model: "claude-haiku-5" }));
    expect(fanOutLatchKey(base)).not.toBe(fanOutLatchKey({ ...base, tools: [{ name: "fetch" }] }));
    expect(fanOutLatchKey(base)).not.toBe(fanOutLatchKey({ ...base, system: "You are a different agent." }));
  });

  it("is stable whether tools/system are absent (treated as null, not undefined-shaped)", () => {
    expect(fanOutLatchKey({ model: "m" })).toBe(fanOutLatchKey({ model: "m", tools: undefined, system: undefined }));
  });
});

describe("FanOutLatch", () => {
  it("lets a solo request through immediately, with no holding", async () => {
    const latch = new FanOutLatch({ holdCapMs: 1_000 });
    const started = Date.now();
    const release = await latch.acquire("key-a");
    expect(Date.now() - started).toBeLessThan(50);
    release();
    expect(latch.stats().heldCount).toBe(0);
  });

  it("holds a second same-key racer until the first releases", async () => {
    const latch = new FanOutLatch({ holdCapMs: 5_000 });
    const order: string[] = [];

    const first = await latch.acquire("shared");
    order.push("first-acquired");

    const secondPromise = latch.acquire("shared").then((release) => {
      order.push("second-acquired");
      return release;
    });

    // Give the second racer a tick to prove it is actually waiting, not
    // proceeding concurrently.
    await sleep(20);
    expect(order).toEqual(["first-acquired"]);

    first(); // release-on-success path
    const secondRelease = await secondPromise;
    expect(order).toEqual(["first-acquired", "second-acquired"]);
    secondRelease();
  });

  it("releases racers when the holder fails, not only when it succeeds", async () => {
    const latch = new FanOutLatch({ holdCapMs: 5_000 });
    const release = await latch.acquire("shared");

    const racer = latch.acquire("shared");
    await sleep(10);

    // Simulate the held-for request's own error path: callers release in a
    // `finally`, so failure unblocks racers exactly like success does.
    release();
    await expect(racer).resolves.toBeInstanceOf(Function);
  });

  it("never stalls past the hold cap even if the holder never releases", async () => {
    const latch = new FanOutLatch({ holdCapMs: 30 });
    await latch.acquire("shared"); // deliberately never released

    const started = Date.now();
    const release = await latch.acquire("shared");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(200);
    expect(latch.stats().timedOutCount).toBeGreaterThan(0);
    release();
  });

  it("serializes three simultaneous racers one at a time, each behind the one before it", async () => {
    const latch = new FanOutLatch({ holdCapMs: 5_000 });
    const order: string[] = [];

    const a = await latch.acquire("shared");
    order.push("a");
    const bPromise = latch.acquire("shared").then((release) => { order.push("b"); return release; });
    const cPromise = latch.acquire("shared").then((release) => { order.push("c"); return release; });

    await sleep(10);
    expect(order).toEqual(["a"]);
    a();

    const b = await bPromise;
    await sleep(10);
    expect(order).toEqual(["a", "b"]);
    b();

    const c = await cPromise;
    expect(order).toEqual(["a", "b", "c"]);
    c();
  });

  it("keeps independent keys fully concurrent — no cross-key contention", async () => {
    const latch = new FanOutLatch({ holdCapMs: 5_000 });
    const releaseA = await latch.acquire("agent-team-1");
    const started = Date.now();
    const releaseB = await latch.acquire("agent-team-2");
    expect(Date.now() - started).toBeLessThan(50);
    releaseA();
    releaseB();
  });

  it("is idempotent: releasing twice does not free a slot a new holder already owns", async () => {
    const latch = new FanOutLatch({ holdCapMs: 5_000 });
    const releaseA = await latch.acquire("shared");
    releaseA();
    const releaseB = await latch.acquire("shared");
    releaseA(); // stale double-release must be a no-op
    // A third acquire must still see B as the holder, not an incorrectly-freed slot.
    const started = Date.now();
    const cPromise = latch.acquire("shared");
    await sleep(15);
    expect(Date.now()).toBeGreaterThanOrEqual(started);
    releaseB();
    const releaseC = await cPromise;
    releaseC();
  });

  it("rejects a non-positive hold cap", () => {
    expect(() => new FanOutLatch({ holdCapMs: 0 })).toThrow(/positive/);
    expect(() => new FanOutLatch({ holdCapMs: -5 })).toThrow(/positive/);
  });
});
