import { describe, expect, it } from "vitest";
import { parseDuration, theoWatch } from "./theo.js";

describe("mesh theo — interval parsing", () => {
  it("parses units and a bare seconds number", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("45")).toBe(45_000);
  });

  it("rejects junk and non-positive intervals", () => {
    expect(() => parseDuration("soon")).toThrow();
    expect(() => parseDuration("5x")).toThrow();
    expect(() => parseDuration("0s")).toThrow();
  });
});

describe("mesh theo — the watch loop", () => {
  it("runs exactly maxTicks and sleeps between ticks, never after the last", async () => {
    let ticks = 0;
    let sleeps = 0;
    const ran = await theoWatch({
      tick: async () => { ticks += 1; },
      intervalMs: 1000,
      maxTicks: 3,
      sleep: async () => { sleeps += 1; },
    });
    expect(ran).toBe(3);
    expect(ticks).toBe(3);
    expect(sleeps).toBe(2); // between the three ticks, not after the third
  });

  it("stops promptly once shouldStop flips, mid-run", async () => {
    let ticks = 0;
    let stop = false;
    const ran = await theoWatch({
      tick: async () => { ticks += 1; if (ticks === 2) stop = true; },
      intervalMs: 1,
      maxTicks: 10,
      sleep: async () => {},
      shouldStop: () => stop,
    });
    expect(ran).toBe(2);
  });

  it("does not tick at all if asked to stop before starting", async () => {
    let ticks = 0;
    const ran = await theoWatch({
      tick: async () => { ticks += 1; },
      intervalMs: 1,
      sleep: async () => {},
      shouldStop: () => true,
    });
    expect(ran).toBe(0);
    expect(ticks).toBe(0);
  });
});
