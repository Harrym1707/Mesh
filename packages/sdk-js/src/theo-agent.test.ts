import { describe, expect, it } from "vitest";
import { WORKLOAD_ARCHETYPES } from "../../core/dist/src/savings-model.js";
import type { TokenPrice } from "../../core/dist/src/cost.js";
import { extractBlindFeatures } from "./blind-features.js";
import { policyToReductionConfig } from "./theo-policy.js";
import {
  createTheoMemory,
  observeWorkload,
  runTheoCycle,
  type TheoMemory,
  type TheoObservation,
  type TheoProof,
} from "./theo-agent.js";

const AT = "2026-11-09T00:00:00.000Z";
const LATER = "2026-11-09T01:00:00.000Z";

// Catalogued Claude Sonnet 5.5 rate, with cache rates so caching can be priced.
const PRICE: TokenPrice = {
  inputPerMillion: 2,
  outputPerMillion: 10,
  cachedInputPerMillion: 0.2,
  cacheWriteInputPerMillion: 2.5,
};

const PROFILE = WORKLOAD_ARCHETYPES.toolHeavyAgent!;
const OBS: TheoObservation = { profile: PROFILE, price: PRICE };

/** A proof the caller obtained from the replay gate for an enforceable lossy lever. */
function proof(overrides: Partial<TheoProof> = {}): TheoProof {
  return {
    lever: "tool-schema-description-trim",
    savingPercent: 30,
    qualityDeltaPercent: -0.5,
    grader: "tool-selection",
    provenAt: LATER,
    ...overrides,
  };
}

describe("Theo agent — memory and observe", () => {
  it("a new agent is strict, lossless-only, with the chosen autonomy", () => {
    const m = createTheoMemory("acme", "recommend", AT);
    expect(m.autonomy).toBe("recommend");
    expect(m.policy.qualityCeilingPercent).toBe(2);
    expect(m.policy.levers.every((l) => l.class === "lossless")).toBe(true);
    expect(m.proposals).toEqual([]);
    expect(m.experiments).toEqual([]);
  });

  it("observeWorkload learns shape from blind features only, including a stable prefix", () => {
    const tools = [{ type: "function", function: { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];
    const system = "You are a precise senior engineer. Read before you edit.";
    const requests = [0, 1, 2].map((turn) => ({
      model: "claude-sonnet-5-5",
      system,
      tools,
      messages: [{ role: "user", content: `Step ${turn}: continue.` }],
    }));
    const features = requests.map((r) => extractBlindFeatures(r, { hmacKey: "test-key" }));
    const profile = observeWorkload(features, { name: "coding-agent", outputTokensMean: 420 });
    expect(profile.requests).toBe(3);
    expect(profile.segments.toolSchemas).toBeGreaterThan(0);
    expect(profile.segments.output).toBe(420);
    // tools + system are identical across turns -> a cacheable prefix.
    expect(profile.stableSegments).toContain("toolSchemas");
    expect(profile.stableSegments).toContain("systemPrompt");
  });

  it("observeWorkload on no traffic is a safe empty profile", () => {
    const profile = observeWorkload([]);
    expect(profile.requests).toBe(1);
    expect(profile.segments.toolSchemas).toBe(0);
    expect(profile.stableSegments).toEqual([]);
  });
});

describe("Theo agent — hypothesise and the frontier", () => {
  it("ranks enforceable lossy candidates and reports non-enforceable opportunities as frontier", () => {
    const m = createTheoMemory("acme", "recommend", AT);
    const { memory } = runTheoCycle(m, { observation: OBS }, LATER);
    const candidateIds = memory.hypotheses.map((h) => h.lever);
    expect(candidateIds).toContain("tool-schema-description-trim");
    expect(memory.hypotheses.every((h) => h.class === "lossy")).toBe(true);
    // unused-tool-removal / prompt-compression have no enforceable proxy lever yet.
    const frontierConcepts = memory.frontier.map((f) => f.concept);
    expect(frontierConcepts.length).toBeGreaterThan(0);
    expect(candidateIds).not.toContain("unused-tool-removal");
  });

  it("does not change the policy when it only observes and hypothesises", () => {
    const m = createTheoMemory("acme", "recommend", AT);
    const { memory } = runTheoCycle(m, { observation: OBS }, LATER);
    expect(memory.policy.version).toBe(m.policy.version);
    expect(memory.proposals).toEqual([]);
  });
});

describe("Theo agent — the autonomy ladder gates what a proof does", () => {
  it("recommend: a passing proof becomes a PROPOSAL, not a policy change", () => {
    const m = createTheoMemory("acme", "recommend", AT);
    const { memory, actions } = runTheoCycle(m, { observation: OBS, proofs: [proof()] }, LATER);
    expect(memory.policy.version).toBe(m.policy.version); // not published
    expect(memory.proposals.map((p) => p.lever)).toContain("tool-schema-description-trim");
    expect(actions.some((a) => a.kind === "proposal-opened")).toBe(true);
    expect(memory.experiments.at(-1)?.passed).toBe(true);
  });

  it("optimise: a passing proof is PUBLISHED and enforced, no proposal", () => {
    const m = createTheoMemory("acme", "optimise", AT);
    const { memory, actions } = runTheoCycle(m, { observation: OBS, proofs: [proof()] }, LATER);
    expect(memory.policy.version).toBe(m.policy.version + 1);
    expect(actions.some((a) => a.kind === "policy-published")).toBe(true);
    expect(memory.proposals).toEqual([]);
    // The enforced reducer config now trims tool-schema descriptions.
    expect(typeof policyToReductionConfig(memory.policy).toolSchemas).toBe("object");
  });

  it("observe: a passing proof is logged but never proposed or published", () => {
    const m = createTheoMemory("acme", "observe", AT);
    const { memory, actions } = runTheoCycle(m, { observation: OBS, proofs: [proof()] }, LATER);
    expect(memory.policy.version).toBe(m.policy.version);
    expect(memory.proposals).toEqual([]);
    expect(actions.some((a) => a.kind === "lossless-active")).toBe(false);
    expect(memory.experiments.at(-1)?.passed).toBe(true);
  });
});

describe("Theo agent — the quality ceiling and proof integrity hold in code", () => {
  it("rejects a proof whose measured quality drop exceeds the route ceiling", () => {
    const m = createTheoMemory("acme", "optimise", AT);
    const { memory, actions } = runTheoCycle(
      m,
      { observation: OBS, proofs: [proof({ qualityDeltaPercent: -3 })] }, // ceiling is 2%
      LATER,
    );
    expect(memory.policy.version).toBe(m.policy.version); // never published
    expect(memory.proposals).toEqual([]);
    expect(actions.some((a) => a.kind === "proof-rejected")).toBe(true);
    expect(memory.experiments.at(-1)?.passed).toBe(false);
  });

  it("rejects a proof with no verified saving", () => {
    const m = createTheoMemory("acme", "optimise", AT);
    const { memory } = runTheoCycle(m, { observation: OBS, proofs: [proof({ savingPercent: 0 })] }, LATER);
    expect(memory.policy.version).toBe(m.policy.version);
    expect(memory.experiments.at(-1)?.passed).toBe(false);
  });

  it("refuses a proof for a lever that is not an enforceable lossy lever", () => {
    const m = createTheoMemory("acme", "optimise", AT);
    const { memory, actions } = runTheoCycle(
      m,
      { observation: OBS, proofs: [proof({ lever: "progressive-disclosure" })] },
      LATER,
    );
    expect(memory.policy.version).toBe(m.policy.version);
    const rejection = actions.find((a) => a.kind === "proof-rejected");
    expect(rejection && rejection.kind === "proof-rejected" && rejection.reason).toContain("enforceable");
  });
});

describe("Theo agent — initiating experiments", () => {
  it("from test autonomy upward, Theo emits gate requests for the next candidates", () => {
    const m = createTheoMemory("acme", "test", AT);
    const { actions } = runTheoCycle(m, { observation: OBS }, LATER);
    const gate = actions.find((a) => a.kind === "gate-requested");
    expect(gate && gate.kind === "gate-requested" && gate.levers.length).toBeGreaterThan(0);
  });

  it("at recommend autonomy, Theo proposes but does not self-initiate gate runs", () => {
    const m = createTheoMemory("acme", "recommend", AT);
    const { actions } = runTheoCycle(m, { observation: OBS }, LATER);
    expect(actions.some((a) => a.kind === "gate-requested")).toBe(false);
  });

  it("memory round-trips through a cycle without mutating the input", () => {
    const m: TheoMemory = createTheoMemory("acme", "optimise", AT);
    const before = JSON.stringify(m);
    runTheoCycle(m, { observation: OBS, proofs: [proof()] }, LATER);
    expect(JSON.stringify(m)).toBe(before); // input untouched (pure)
  });
});
