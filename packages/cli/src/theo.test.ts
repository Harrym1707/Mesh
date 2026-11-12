import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTheoMemory, type TheoMemory } from "../../sdk-js/src/theo-agent.js";
import { defaultTheoMemoryPath, loadTheoMemory, saveTheoMemory } from "../../sdk-js/src/theo-agent-store.js";
import type { TheoPolicyBundle } from "../../sdk-js/src/theo-policy.js";
import { parseDuration, readGateKey, resolveQualityCeiling, runTheoDecision, theoWatch, type TheoRunOptions } from "./theo.js";

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

describe("mesh theo — --quality-ceiling can only tighten unless told otherwise", () => {
  it("lowering always takes effect", () => {
    expect(resolveQualityCeiling(2, 1, false)).toEqual({ ceilingPercent: 1 });
    expect(resolveQualityCeiling(2, 2, false)).toEqual({ ceilingPercent: 2 });
  });

  it("raising is ignored, with a note, without the explicit flag", () => {
    const resolved = resolveQualityCeiling(2, 4, false);
    expect(resolved.ceilingPercent).toBe(2);
    expect(resolved.note).toMatch(/looser than the current 2% and was ignored/);
  });

  it("raising with the flag works but never passes the 5% hard cap", () => {
    expect(resolveQualityCeiling(2, 4, true).ceilingPercent).toBe(4);
    const capped = resolveQualityCeiling(2, 50, true);
    expect(capped.ceilingPercent).toBe(5);
    expect(capped.note).toMatch(/RAISED from 2% to 5%/);
    // The cap also binds a request that would otherwise be ignored.
    expect(resolveQualityCeiling(5, 50, false).ceilingPercent).toBe(5);
  });
});

describe("mesh theo — answering proposals from the command line", () => {
  const LEVER = "tool-schema-description-trim";
  let ledgerDir: string;
  let policyPath: string;
  let options: TheoRunOptions;
  let printed: string[];

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "mesh-decide-"));
    ledgerDir = join(root, "ledger");
    mkdirSync(ledgerDir, { recursive: true });
    policyPath = join(root, "home", "theo-policy.json");
    options = { ledgerDir, customer: "local", maxSamples: 20, apply: false, policyPath };
    const memory: TheoMemory = {
      ...createTheoMemory("local", "recommend", "2026-11-10T00:00:00.000Z"),
      proposals: [{
        lever: LEVER,
        savingPercent: 12,
        qualityDeltaPercent: -0.4,
        grader: "agent",
        provenAt: "2026-11-10T09:00:00.000Z",
        message: `${LEVER}: proven to save ~12.0%`,
      }],
    };
    saveTheoMemory(defaultTheoMemoryPath(ledgerDir, "local"), memory);
    printed = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { printed.push(String(line)); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const memoryNow = (): TheoMemory => loadTheoMemory(defaultTheoMemoryPath(ledgerDir, "local"))!;

  it("--proposals lists each one with the command that answers it, and changes nothing", () => {
    runTheoDecision({ ...options, listProposals: true });
    expect(printed.join("\n")).toContain(`mesh theo --accept ${LEVER}`);
    expect(printed.join("\n")).toContain(`mesh theo --reject ${LEVER}`);
    expect(memoryNow().proposals).toHaveLength(1);
    expect(existsSync(policyPath)).toBe(false);
  });

  it("--accept makes the lever live in the proxy's policy file and closes the proposal", () => {
    runTheoDecision({ ...options, accept: LEVER });
    const bundle = JSON.parse(readFileSync(policyPath, "utf8")) as TheoPolicyBundle;
    const live = bundle.default.levers.find((l) => l.lever === LEVER);
    expect(live?.gate?.grader).toBe("agent");
    expect(memoryNow().proposals).toEqual([]);
    expect(memoryNow().driftBaselines[LEVER]).toMatchObject({ retryRate: 0, failureRate: 0 });
  });

  it("--accept with --route lands the lever on that route only", () => {
    runTheoDecision({ ...options, accept: LEVER, route: "claude-haiku*" });
    const bundle = JSON.parse(readFileSync(policyPath, "utf8")) as TheoPolicyBundle;
    expect(bundle.default.levers.some((l) => l.lever === LEVER)).toBe(false);
    expect(bundle.routes?.[0]?.route).toBe("claude-haiku*");
    expect(bundle.routes?.[0]?.levers.some((l) => l.lever === LEVER)).toBe(true);
  });

  it("--reject closes it without touching the policy; --reconsider undoes that", () => {
    runTheoDecision({ ...options, reject: LEVER });
    expect(memoryNow().proposals).toEqual([]);
    expect(memoryNow().declined).toEqual([LEVER]);
    expect(existsSync(policyPath)).toBe(false);
    runTheoDecision({ ...options, reconsider: LEVER });
    expect(memoryNow().declined).toEqual([]);
  });

  it("fails clearly for an unknown lever, and before Theo has ever run", () => {
    expect(() => runTheoDecision({ ...options, accept: "stale-history-compaction" })).toThrow(/No open proposal/);
    expect(() => runTheoDecision({ ...options, customer: "nobody", listProposals: true })).toThrow(/has not run/);
  });
});
