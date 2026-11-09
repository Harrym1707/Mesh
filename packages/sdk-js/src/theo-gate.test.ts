import { describe, expect, it } from "vitest";
import { WORKLOAD_ARCHETYPES } from "../../core/dist/src/savings-model.js";
import type { TokenPrice } from "../../core/dist/src/cost.js";
import { policyToReductionConfig } from "./theo-policy.js";
import { createTheoMemory, runTheoCycle } from "./theo-agent.js";
import { proveCandidates } from "./theo-gate.js";

const AT = "2026-11-09T00:00:00.000Z";
const LATER = "2026-11-09T02:00:00.000Z";

const PRICE: TokenPrice = {
  inputPerMillion: 2,
  outputPerMillion: 10,
  cachedInputPerMillion: 0.2,
  cacheWriteInputPerMillion: 2.5,
};

/** Requests with verbose tool descriptions, so description-trim actually shrinks them. */
function makeRequests(n: number): unknown[] {
  const tools = [
    { name: "search", description: "Search the corpus and return the most relevant passages for the query. ".repeat(20), input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    { name: "fetch", description: "Fetch a document by its identifier and return the full contents for inspection. ".repeat(20), input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  ];
  return Array.from({ length: n }, (_, i) => ({
    model: "claude-sonnet-5-5",
    system: "You are a careful research assistant.",
    tools,
    messages: [{ role: "user", content: `Question ${i}: what does the corpus say about reconciliation?` }],
  }));
}

/** A mock provider: usage scales with request size, so a reduced request bills
 * less; the answer text is constant, so quality holds (no tool calls). */
async function sizedCall(request: unknown): Promise<unknown> {
  const inputTokens = Math.max(1, Math.ceil(JSON.stringify(request).length / 4));
  return {
    id: "msg_x",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "The corpus describes reconciliation as comparing proxy spend against the provider invoice." }],
    stop_reason: "end_turn",
    usage: { input_tokens: inputTokens, output_tokens: 24 },
  };
}

/** A mock whose usage never changes, so no candidate can show a saving. */
async function flatCall(): Promise<unknown> {
  return {
    id: "msg_y",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "The corpus describes reconciliation as comparing proxy spend against the provider invoice." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 24 },
  };
}

describe("Theo gate — proving candidates on real traffic", () => {
  it("approves a candidate that saves with quality held, and yields a usable proof", async () => {
    const { proofs, rejections, calls } = await proveCandidates({
      levers: ["tool-schema-description-trim"],
      requests: makeRequests(4),
      call: sizedCall,
      price: PRICE,
      now: LATER,
    });
    expect(rejections).toEqual([]);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]!.lever).toBe("tool-schema-description-trim");
    expect(proofs[0]!.savingPercent).toBeGreaterThan(0);
    expect(Math.abs(proofs[0]!.qualityDeltaPercent)).toBeLessThanOrEqual(2);
    expect(proofs[0]!.provenAt).toBe(LATER);
    expect(calls).toBeGreaterThan(0);
  });

  it("rejects a candidate when the grader shows a quality drop beyond budget", async () => {
    const { proofs, rejections } = await proveCandidates({
      levers: ["tool-schema-description-trim"],
      requests: makeRequests(4),
      call: sizedCall,
      price: PRICE,
      grader: () => 0.3, // every candidate answer graded well below the baseline
      maximumQualityDrop: 0.02,
      now: LATER,
    });
    expect(proofs).toEqual([]);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.lever).toBe("tool-schema-description-trim");
  });

  it("rejects a candidate that holds quality but does not lower the bill", async () => {
    const { proofs, rejections } = await proveCandidates({
      levers: ["tool-schema-description-trim"],
      requests: makeRequests(4),
      call: flatCall,
      price: PRICE,
      now: LATER,
    });
    expect(proofs).toEqual([]);
    expect(rejections).toHaveLength(1);
  });

  it("no candidates or no sample yields no proofs rather than throwing", async () => {
    const none = await proveCandidates({ levers: [], requests: makeRequests(2), call: sizedCall, now: LATER });
    expect(none).toEqual({ proofs: [], rejections: [], calls: 0 });
    const noSample = await proveCandidates({ levers: ["output-effort-low"], requests: [], call: sizedCall, now: LATER });
    expect(noSample.proofs).toEqual([]);
    expect(noSample.rejections[0]!.reason).toContain("no request sample");
  });
});

describe("Theo gate + cycle — the full loop proves then publishes", () => {
  it("a gate proof flows into runTheoCycle at optimise and is enforced", async () => {
    const { proofs } = await proveCandidates({
      levers: ["tool-schema-description-trim"],
      requests: makeRequests(5),
      call: sizedCall,
      price: PRICE,
      now: LATER,
    });
    expect(proofs).toHaveLength(1);

    const memory = createTheoMemory("acme", "optimise", AT);
    const { memory: next } = runTheoCycle(
      memory,
      { observation: { profile: WORKLOAD_ARCHETYPES.toolHeavyAgent!, price: PRICE }, proofs },
      LATER,
    );
    // Theo published the proven lever, and the proxy config now enforces it.
    expect(next.policy.version).toBe(memory.policy.version + 1);
    expect(typeof policyToReductionConfig(next.policy).toolSchemas).toBe("object");
    const published = next.policy.levers.find((lever) => lever.lever === "tool-schema-description-trim");
    expect(published?.gate?.savingPercent).toBeGreaterThan(0);
  });

  it("at recommend, the same proof becomes a proposal rather than an enforced lever", async () => {
    const { proofs } = await proveCandidates({
      levers: ["tool-schema-description-trim"],
      requests: makeRequests(5),
      call: sizedCall,
      price: PRICE,
      now: LATER,
    });
    const memory = createTheoMemory("acme", "recommend", AT);
    const { memory: next } = runTheoCycle(
      memory,
      { observation: { profile: WORKLOAD_ARCHETYPES.toolHeavyAgent!, price: PRICE }, proofs },
      LATER,
    );
    expect(next.policy.version).toBe(memory.policy.version); // not enforced
    expect(next.proposals.map((p) => p.lever)).toContain("tool-schema-description-trim");
  });
});
