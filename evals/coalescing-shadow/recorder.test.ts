import { describe, expect, it } from "vitest";
import { ShadowCoalescingRecorder, classifyRequest, type ShadowEvent } from "./recorder.js";
import { analyzeCoalescing } from "./analyze.js";
import { generateEvents } from "./synthetic.js";

const scope = "tenant-a";

describe("classifyRequest", () => {
  it("gives byte-identical deterministic requests the same key, and different scopes different keys", () => {
    const req = { model: "m", temperature: 0, messages: [{ role: "user", content: "hi" }] };
    const a = classifyRequest(req, scope, true);
    const b = classifyRequest({ messages: [{ role: "user", content: "hi" }], temperature: 0, model: "m" }, scope, true);
    expect(a.keyHash).toBeDefined();
    expect(a.keyHash).toBe(b.keyHash); // key order does not matter (canonical)
    const other = classifyRequest(req, "tenant-b", true);
    expect(other.keyHash).not.toBe(a.keyHash); // scope isolates
  });

  it("hard-excludes streaming, tools, tool_choice, responses-chain and conversation", () => {
    expect(classifyRequest({ model: "m", stream: true }, scope, true).ineligible).toBe("streaming");
    expect(classifyRequest({ model: "m", tools: [] }, scope, true).ineligible).toBe("tools");
    expect(classifyRequest({ model: "m", tool_choice: "auto" }, scope, true).ineligible).toBe("tool_choice");
    expect(classifyRequest({ model: "m", previous_response_id: "x" }, scope, true).ineligible).toBe("responses-chain");
    expect(classifyRequest({ model: "m", conversation: "c" }, scope, true).ineligible).toBe("conversation");
  });

  it("gates non-deterministic requests but still keys them when the gate is on", () => {
    const hot = { model: "m", temperature: 0.7, messages: [{ role: "user", content: "hi" }] };
    const gated = classifyRequest(hot, scope, true);
    expect(gated.keyHash).toBeDefined();
    expect(gated.gated).toBe("nondeterministic");
    const seeded = classifyRequest({ model: "m", temperature: 0.7, seed: 42 }, scope, true);
    expect(seeded.gated).toBeUndefined(); // a seed makes it eligible
  });
});

describe("recorder emits content-free events", () => {
  it("never carries request or response content, only hashes and structure", () => {
    const events: ShadowEvent[] = [];
    let t = 0;
    const recorder = new ShadowCoalescingRecorder({
      getScopeKey: (r) => (r as { scope?: string }).scope,
      emit: (e) => events.push(e),
      now: () => (t += 10),
    });
    const secret = "patient SSN 123-45-6789";
    const handle = recorder.begin({ scope, model: "m", temperature: 0, messages: [{ role: "user", content: secret }] });
    recorder.end(handle, { inputTokens: 100, outputTokens: 10, costUsd: 0.001 });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("123-45-6789");
    expect(events[0]!.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0]!.scopeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not record out-of-scope requests", () => {
    const events: ShadowEvent[] = [];
    const recorder = new ShadowCoalescingRecorder({ getScopeKey: () => undefined, emit: (e) => events.push(e) });
    const handle = recorder.begin({ model: "m", temperature: 0 });
    recorder.end(handle);
    expect(events).toHaveLength(0);
  });
});

describe("analyzeCoalescing single-flight reconstruction", () => {
  function startEnd(id: number, keyHash: string, scopeHash: string, startedAt: number, endedAt: number): ShadowEvent[] {
    return [
      { phase: "start", id, keyHash, scopeHash, t: startedAt },
      { phase: "end", id, keyHash, t: endedAt, usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 } },
    ];
  }

  it("collapses concurrent identical requests into one leader + N-1 followers", () => {
    // Three identical requests whose windows overlap: [0,100], [20,130], [40,150].
    const k = "k1";
    const s = "s1";
    const events = [
      ...startEnd(1, k, s, 0, 100),
      ...startEnd(2, k, s, 20, 130),
      ...startEnd(3, k, s, 40, 150),
    ];
    const report = analyzeCoalescing(events, { maxHoldMs: 5_000 });
    expect(report.leaders).toBe(1);
    expect(report.coalescedFollowers).toBe(2);
    expect(report.callEliminationPercentOfKeyed).toBeCloseTo((2 / 3) * 100, 5);
    expect(report.wouldSave.costUsd).toBeCloseTo(0.002, 6); // two followers' cost avoided
  });

  it("does not coalesce requests that do not overlap in time", () => {
    const events = [
      ...startEnd(1, "k", "s", 0, 50),
      ...startEnd(2, "k", "s", 100, 150), // arrives after the leader finished
    ];
    const report = analyzeCoalescing(events, { maxHoldMs: 5_000 });
    expect(report.leaders).toBe(2);
    expect(report.coalescedFollowers).toBe(0);
  });

  it("drops a follower whose modelled hold exceeds the cap", () => {
    const events = [
      ...startEnd(1, "k", "s", 0, 10_000), // long leader
      ...startEnd(2, "k", "s", 100, 10_050), // would wait ~9.9s
    ];
    const report = analyzeCoalescing(events, { maxHoldMs: 5_000 });
    expect(report.coalescedFollowers).toBe(0);
    expect(report.followersOverCap).toBe(1);
  });

  it("excludes gated (non-deterministic) requests from the safe band but counts them when asked", () => {
    const events: ShadowEvent[] = [
      { phase: "start", id: 1, keyHash: "k", scopeHash: "s", gated: "nondeterministic", t: 0 },
      { phase: "end", id: 1, keyHash: "k", t: 100, usage: { costUsd: 0.001 } },
      { phase: "start", id: 2, keyHash: "k", scopeHash: "s", gated: "nondeterministic", t: 20 },
      { phase: "end", id: 2, keyHash: "k", t: 120, usage: { costUsd: 0.001 } },
    ];
    expect(analyzeCoalescing(events, { maxHoldMs: 5_000 }).coalescedFollowers).toBe(0);
    expect(analyzeCoalescing(events, { maxHoldMs: 5_000, includeGated: true }).coalescedFollowers).toBe(1);
  });
});

describe("end-to-end on synthetic traffic", () => {
  it("runs the recorder->analyzer pipeline and reports a sane, bounded result", () => {
    const report = analyzeCoalescing(generateEvents(), { maxHoldMs: 5_000 });
    expect(report.recordedRequests).toBeGreaterThan(0);
    expect(report.keyedRequests).toBeGreaterThan(0);
    expect(report.leaders + report.coalescedFollowers + report.followersOverCap).toBeLessThanOrEqual(report.keyedRequests);
    expect(report.callEliminationPercentOfKeyed).toBeGreaterThanOrEqual(0);
    expect(report.callEliminationPercentOfKeyed).toBeLessThanOrEqual(100);
    expect(report.ineligibleByReason.streaming ?? 0).toBeGreaterThanOrEqual(0);
  });
});
