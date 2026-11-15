import { describe, expect, it } from "vitest";
import { toolSearchGate } from "./tool-search-gate.js";
import { responseToolCalls, toolSelectionGrader } from "./replay-gate.js";
import { taskCompletionGrader } from "./graders.js";
import { defaultPolicy, publishLever, policyToReductionConfig, policyCoverage } from "./theo-policy.js";

const AT = "2026-11-07T00:00:00.000Z";

// An Anthropic request with a catalogue big enough for the lever to fire.
function anthropicRequest(tag: string): Record<string, unknown> {
  return {
    model: "claude-opus-5",
    system: "You are a support agent.",
    messages: [{ role: "user", content: `Cold turn ${tag}: which tool?` }],
    tools: Array.from({ length: 12 }, (_, i) => ({
      name: `lookup_${i}`,
      description: "Look up a record set for a customer account.",
      input_schema: { type: "object", properties: { accountId: { type: "string" } }, required: ["accountId"] },
    })),
  };
}

const coldCorpus = Array.from({ length: 8 }, (_, i) => anthropicRequest(String(i)));

/**
 * A deterministic fake provider. It returns Anthropic Messages-shaped responses:
 *  - input_tokens falls by 500 per DEFERRED tool, modelling the cold-turn cut
 *    (the baseline defers nothing, so it always bills the full catalogue);
 *  - the model calls the right tool (lookup_7) UNLESS at least `failAt` tools
 *    were deferred, modelling it failing to search for an over-deferred tool.
 */
function fakeCall(failAt = Number.POSITIVE_INFINITY) {
  return async (request: unknown): Promise<unknown> => {
    const tools = (request as { tools?: unknown[] }).tools ?? [];
    const deferred = tools.filter((t) => (t as { defer_loading?: unknown }).defer_loading === true).length;
    const wrong = deferred >= failAt;
    return {
      usage: { input_tokens: 8000 - deferred * 500, output_tokens: 50 },
      content: [{ type: "tool_use", name: wrong ? "lookup_wrong" : "lookup_7", input: { accountId: "1" } }],
    };
  };
}

describe("responseToolCalls / toolSelectionGrader on Anthropic tool_use", () => {
  it("reads an Anthropic tool_use block (name + input), which the grader needs to see", () => {
    const resp = { content: [{ type: "tool_use", name: "lookup_7", input: { accountId: "1" } }] };
    const calls = responseToolCalls(resp);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("lookup_7");
  });

  it("scores 1 for identical tool_use and <1 when the deferred tool is missed", () => {
    const right = { content: [{ type: "tool_use", name: "lookup_7", input: { accountId: "1" } }] };
    const wrong = { content: [{ type: "tool_use", name: "lookup_wrong", input: { accountId: "1" } }] };
    expect(toolSelectionGrader({ request: {}, baselineResponse: right, candidateResponse: right })).toBe(1);
    expect(toolSelectionGrader({ request: {}, baselineResponse: right, candidateResponse: wrong })).toBeLessThan(1);
  });
});

describe("toolSearchGate", () => {
  it("approves when quality holds, measures the saving from provider usage, and yields a publishable proof", async () => {
    const outcome = await toolSearchGate({
      requests: coldCorpus,
      call: fakeCall(), // never fails: the model always finds the deferred tool
      qualityCeilingPercent: 2,
      seed: "test-approve",
      now: () => AT,
    });

    expect(outcome.result.approved).toBeDefined();
    expect(outcome.approvedResidentTools).toBe(4);
    expect(outcome.proof).toBeDefined();
    // Saving is read from provider usage (baseline 8000 vs candidate 8000-8*500=4000 input).
    expect(outcome.proof!.savingPercent).toBeGreaterThan(0);
    expect(outcome.proof!.qualityDeltaPercent).toBeLessThanOrEqual(0);
    expect(outcome.proof!.grader).toBe("tool-selection");
    expect(outcome.proof!.provenAt).toBe(AT);

    // The proof is enough to turn the held lever on, and only because it cleared
    // the ceiling: publish it, enforce the policy, and the reducer config has it.
    const policy = publishLever(
      defaultPolicy("u", AT),
      { lever: "tool-search-defer", class: "lossy", gate: outcome.proof, params: { residentTools: outcome.approvedResidentTools } },
      AT,
    );
    const config = policyToReductionConfig(policy);
    expect(config.toolSearch).toBeDefined();
    const stand = policyCoverage(policy).stands.find((s) => s.lever === "tool-search-defer")!;
    expect(stand.state).toBe("active");
  });

  it("rejects when deferral breaks tool selection: no proof, lever stays held", async () => {
    const outcome = await toolSearchGate({
      requests: coldCorpus,
      call: fakeCall(1), // any deferral makes the model call the wrong tool
      qualityCeilingPercent: 2,
      seed: "test-reject",
    });

    expect(outcome.result.approved).toBeUndefined();
    expect(outcome.proof).toBeUndefined();
    expect(outcome.approvedResidentTools).toBeUndefined();
    const candidate = outcome.result.candidates[0]!;
    expect(candidate.approved).toBe(false);
    expect(candidate.rejectionReason).toMatch(/[Qq]uality/);
  });

  it("sweeps resident counts and keeps the most aggressive that holds quality", async () => {
    // Deferring 9 tools (resident=3) breaks selection; 8 or 7 (resident 4,5) hold.
    // The gate should approve resident=4 — more aggressive (more deferred, more
    // saved) than resident=5, while resident=3 is rejected.
    const outcome = await toolSearchGate({
      requests: coldCorpus,
      call: fakeCall(9),
      residentToolsCandidates: [3, 4, 5],
      qualityCeilingPercent: 2,
      seed: "test-sweep",
    });

    expect(outcome.approvedResidentTools).toBe(4);
    const byResident = (n: number) =>
      outcome.result.candidates.find((c) => c.label.includes(`resident=${n}`))!;
    expect(byResident(3).approved).toBe(false); // too aggressive, quality broke
    expect(byResident(4).approved).toBe(true);
    expect(byResident(5).approved).toBe(true);
    // resident=4 defers more than resident=5, so it saved more.
    expect(byResident(4).tokenSavingPercent).toBeGreaterThan(byResident(5).tokenSavingPercent);
  });

  it("flags the cold-turn caveat when no cache reset was supplied", async () => {
    const outcome = await toolSearchGate({ requests: coldCorpus, call: fakeCall(), seed: "test-note" });
    expect(outcome.result.notes.some((n) => /cold-turn saving/.test(n))).toBe(true);
  });

  it("phase 5: a search-detour trajectory is rejected by tool-selection but approved by task-completion", async () => {
    // The candidate makes the needed call (lookup_7) AND an extra exploratory
    // call (lookup_3) — the shape a deferral lever produces when the model
    // searches before acting. The task still completed.
    const detourCall = async (request: unknown): Promise<unknown> => {
      const tools = (request as { tools?: unknown[] }).tools ?? [];
      const deferred = tools.filter((t) => (t as { defer_loading?: unknown }).defer_loading === true).length;
      const calls = deferred > 0
        ? [{ type: "tool_use", name: "lookup_7", input: { accountId: "1" } },
           { type: "tool_use", name: "lookup_3", input: { accountId: "1" } }]
        : [{ type: "tool_use", name: "lookup_7", input: { accountId: "1" } }];
      return { usage: { input_tokens: 8000 - deferred * 500, output_tokens: 50 }, content: calls };
    };

    // Strict tool-selection (Jaccard) sees the extra call as a 0.5 mismatch and rejects.
    const strict = await toolSearchGate({ requests: coldCorpus, call: detourCall, qualityCeilingPercent: 2, seed: "p5" });
    expect(strict.proof).toBeUndefined();
    expect(strict.result.candidates[0]!.approved).toBe(false);

    // Task-completion credits the reproduced action, tolerates the detour, approves —
    // and the proof honestly records which grader judged it.
    const lenient = await toolSearchGate({
      requests: coldCorpus,
      call: detourCall,
      grade: taskCompletionGrader(),
      graderLabel: "task-completion",
      qualityCeilingPercent: 2,
      seed: "p5",
      now: () => AT,
    });
    expect(lenient.proof).toBeDefined();
    expect(lenient.proof!.grader).toBe("task-completion");
    expect(lenient.proof!.savingPercent).toBeGreaterThan(0);
    expect(lenient.approvedResidentTools).toBe(4);
  });
});
