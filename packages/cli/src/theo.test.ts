import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDuration, readGateKey, theoWatch } from "./theo.js";

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

describe("mesh theo — readGateKey (unattended gate provisioning)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-gatekey-"));

  it("reads and trims a key from a 0600 file", () => {
    const path = join(dir, "ok.key");
    writeFileSync(path, "  sk-secret-123\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    const result = readGateKey(path);
    expect(result.key).toBe("sk-secret-123"); // trimmed
    expect(result.reason).toBeUndefined();
  });

  it("refuses a group/other-readable file instead of leaking the key", () => {
    const path = join(dir, "loose.key");
    writeFileSync(path, "sk-secret", { mode: 0o644 });
    chmodSync(path, 0o644);
    const result = readGateKey(path);
    expect(result.key).toBeUndefined();
    expect(result.reason).toMatch(/group\/other-readable|chmod 600/);
  });

  it("reports a missing file and an empty file without throwing", () => {
    expect(readGateKey(join(dir, "nope.key")).reason).toMatch(/not found/);
    const empty = join(dir, "empty.key");
    writeFileSync(empty, "   \n", { mode: 0o600 });
    chmodSync(empty, 0o600);
    const result = readGateKey(empty);
    expect(result.key).toBeUndefined();
    expect(result.reason).toMatch(/empty/);
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
