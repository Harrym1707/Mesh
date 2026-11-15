import { describe, expect, it } from "vitest";
import { WORKLOAD_ARCHETYPES } from "../../core/dist/src/savings-model.js";
import type { TokenPrice } from "../../core/dist/src/cost.js";
import { extractBlindFeatures } from "./blind-features.js";
import { policyToReductionConfig } from "./theo-policy.js";
import {
  DRIFT_WINDOW_EVENTS,
  acceptProposal,
  createTheoMemory,
  observeWorkload,
  recentDriftRates,
  reconsiderLever,
  rejectProposal,
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
    // unused-tool-removal stays on the frontier — Theo is content-blind and
    // cannot name the tools — but now it carries the operator step to enable the
    // enforceable lever, not "needs new code".
    const frontierConcepts = memory.frontier.map((f) => f.concept);
    expect(frontierConcepts.length).toBeGreaterThan(0);
    expect(candidateIds).not.toContain("unused-tool-removal");
    const unusedTool = memory.frontier.find((f) => f.concept === "unused-tool-removal");
    expect(unusedTool).toBeDefined();
    expect(unusedTool!.note).toContain("enable it with the tool names");
    expect(unusedTool!.note).not.toContain("needs new reduction code");
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

describe("Theo agent — drift auto-rollback (never degrade, after rollout too)", () => {
  // Apply a lossy lever at a baseline retry rate, then observe a rise.
  function applied(baselineRetryRate: number): TheoMemory {
    const m = createTheoMemory("acme", "optimise", AT);
    const { memory } = runTheoCycle(
      m,
      { observation: { profile: PROFILE, price: PRICE, retryRate: baselineRetryRate }, proofs: [proof()] },
      LATER,
    );
    expect(memory.policy.version).toBe(m.policy.version + 1); // lever applied
    expect(memory.driftBaselines["tool-schema-description-trim"]?.retryRate).toBe(baselineRetryRate);
    return memory;
  }

  it("rolls a lever back when the retry rate rises past the threshold", () => {
    const appl = applied(0.10);
    const { memory, actions } = runTheoCycle(
      appl,
      { observation: { profile: PROFILE, price: PRICE, retryRate: 0.20 } }, // +10pp, over the 5pp threshold
      LATER,
    );
    expect(memory.policy.version).toBe(appl.policy.version + 1); // reverted = another version
    expect(memory.policy.levers.some((l) => l.lever === "tool-schema-description-trim")).toBe(false);
    expect(memory.rolledBack).toContain("tool-schema-description-trim");
    expect(actions.some((a) => a.kind === "rolled-back")).toBe(true);
  });

  it("leaves the lever in place when the retry rate barely moves", () => {
    const appl = applied(0.10);
    const { memory, actions } = runTheoCycle(
      appl,
      { observation: { profile: PROFILE, price: PRICE, retryRate: 0.12 } }, // +2pp, under threshold
      LATER,
    );
    expect(memory.policy.levers.some((l) => l.lever === "tool-schema-description-trim")).toBe(true);
    expect(actions.some((a) => a.kind === "rolled-back")).toBe(false);
  });

  it("rolls back when the FAILURE rate rises, even if retries are flat", () => {
    const m = createTheoMemory("acme", "optimise", AT);
    const { memory: appl } = runTheoCycle(
      m,
      { observation: { profile: PROFILE, price: PRICE, retryRate: 0.1, failureRate: 0.02 }, proofs: [proof()] },
      LATER,
    );
    expect(appl.policy.levers.some((l) => l.lever === "tool-schema-description-trim")).toBe(true);
    const { memory, actions } = runTheoCycle(
      appl,
      { observation: { profile: PROFILE, price: PRICE, retryRate: 0.1, failureRate: 0.20 } }, // failures +18pp, retries flat
      LATER,
    );
    expect(memory.policy.levers.some((l) => l.lever === "tool-schema-description-trim")).toBe(false);
    const rb = actions.find((a) => a.kind === "rolled-back");
    expect(rb && rb.kind === "rolled-back" && rb.reason).toContain("failure rate");
  });

  it("does not re-propose or re-apply a rolled-back lever", () => {
    const appl = applied(0.10);
    const rolled = runTheoCycle(appl, { observation: { profile: PROFILE, price: PRICE, retryRate: 0.20 } }, LATER).memory;
    // It is gone from the candidate queue...
    const next = runTheoCycle(rolled, { observation: { profile: PROFILE, price: PRICE, retryRate: 0.20 } }, LATER);
    expect(next.memory.hypotheses.map((h) => h.lever)).not.toContain("tool-schema-description-trim");
    // ...and a fresh proof for it is refused.
    const withProof = runTheoCycle(rolled, { observation: { profile: PROFILE, price: PRICE, retryRate: 0.20 }, proofs: [proof()] }, LATER);
    expect(withProof.memory.policy.levers.some((l) => l.lever === "tool-schema-description-trim")).toBe(false);
    expect(withProof.actions.some((a) => a.kind === "proof-rejected")).toBe(true);
  });

  it("does nothing when no retry rate is supplied", () => {
    const appl = applied(0.10);
    const { memory, actions } = runTheoCycle(appl, { observation: { profile: PROFILE, price: PRICE } }, LATER);
    expect(memory.policy.levers.some((l) => l.lever === "tool-schema-description-trim")).toBe(true);
    expect(actions.some((a) => a.kind === "rolled-back")).toBe(false);
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

describe("Theo agent — answering a proposal", () => {
  const LEVER = "tool-schema-description-trim";
  /** A recommend-mode agent with one open, proven proposal. */
  function proposed(): TheoMemory {
    const m = createTheoMemory("acme", "recommend", AT);
    return runTheoCycle(m, { observation: OBS, proofs: [proof()] }, LATER).memory;
  }

  it("accepting publishes the lever with its proof, so the proxy enforces it", () => {
    const before = proposed();
    expect(before.proposals.map((p) => p.lever)).toEqual([LEVER]);
    expect(policyToReductionConfig(before.policy).toolSchemas).toBe(true); // lossless tier only

    const decision = acceptProposal(before, LEVER, { retryRate: 0.04, failureRate: 0.01 }, LATER);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const after = decision.memory;
    expect(after.proposals).toEqual([]);
    expect(after.policy.version).toBe(before.policy.version + 1);
    const published = after.policy.levers.find((l) => l.lever === LEVER)!;
    expect(published.class).toBe("lossy");
    expect(published.gate).toEqual({ savingPercent: 30, qualityDeltaPercent: -0.5, grader: "tool-selection", provenAt: LATER });
    // The enforcement point now applies the lossy trim.
    expect(policyToReductionConfig(after.policy).toolSchemas).toMatchObject({ descriptions: "truncate" });
    // Drift is watched from today's rates.
    expect(after.driftBaselines[LEVER]).toEqual({ retryRate: 0.04, failureRate: 0.01, at: LATER });
    expect(JSON.stringify(before.proposals)).toContain(LEVER); // input untouched (pure)
  });

  it("an accepted lever is rolled back by the next cycle if retries rise", () => {
    const decision = acceptProposal(proposed(), LEVER, { retryRate: 0.02, failureRate: 0 }, LATER);
    if (!decision.ok) throw new Error(decision.reason);
    const { memory, actions } = runTheoCycle(
      decision.memory,
      { observation: { ...OBS, retryRate: 0.20, failureRate: 0 } },
      LATER,
    );
    expect(actions.some((a) => a.kind === "rolled-back" && a.lever === LEVER)).toBe(true);
    expect(memory.policy.levers.some((l) => l.lever === LEVER)).toBe(false);
  });

  it("refuses a proof that no longer fits a tightened ceiling", () => {
    const m = proposed();
    const tightened: TheoMemory = { ...m, policy: { ...m.policy, qualityCeilingPercent: 0.1 } };
    const decision = acceptProposal(tightened, LEVER, {}, LATER);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/above the current 0\.1% ceiling/);
  });

  it("refuses a lever with no open proposal, and one rolled back after drift", () => {
    const m = proposed();
    const none = acceptProposal(m, "stale-history-compaction", {}, LATER);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toMatch(/No open proposal/);
    const rolled = acceptProposal({ ...m, rolledBack: [LEVER] }, LEVER, {}, LATER);
    expect(rolled.ok).toBe(false);
  });

  it("rejecting closes the proposal and Theo neither re-proposes nor re-queues it", () => {
    const decision = rejectProposal(proposed(), LEVER, LATER);
    if (!decision.ok) throw new Error(decision.reason);
    expect(decision.memory.proposals).toEqual([]);
    expect(decision.memory.declined).toEqual([LEVER]);

    // A fresh passing proof arrives: still no proposal, and it is not queued.
    const next = runTheoCycle(decision.memory, { observation: OBS, proofs: [proof()] }, LATER);
    expect(next.memory.proposals).toEqual([]);
    expect(next.memory.hypotheses.some((h) => h.lever === LEVER)).toBe(false);
    expect(next.actions).toContainEqual({ kind: "proof-rejected", lever: LEVER, reason: "declined by the customer" });
  });

  it("a decline outranks auto-apply: optimise does not publish a declined lever", () => {
    const decision = rejectProposal(proposed(), LEVER, LATER);
    if (!decision.ok) throw new Error(decision.reason);
    const optimising: TheoMemory = { ...decision.memory, autonomy: "optimise" };
    const next = runTheoCycle(optimising, { observation: OBS, proofs: [proof()] }, LATER);
    expect(next.memory.policy.levers.some((l) => l.lever === LEVER)).toBe(false);
    expect(next.actions.some((a) => a.kind === "policy-published")).toBe(false);
  });

  it("reconsidering puts a declined lever back in play", () => {
    const declined = rejectProposal(proposed(), LEVER, LATER);
    if (!declined.ok) throw new Error(declined.reason);
    const back = reconsiderLever(declined.memory, LEVER, LATER);
    if (!back.ok) throw new Error(back.reason);
    expect(back.memory.declined).toEqual([]);
    const next = runTheoCycle(back.memory, { observation: OBS, proofs: [proof()] }, LATER);
    expect(next.memory.proposals.map((p) => p.lever)).toEqual([LEVER]);
    expect(reconsiderLever(back.memory, LEVER, LATER).ok).toBe(false); // nothing left to undo
  });
});

describe("Theo agent — drift rates use a recent window", () => {
  const at = (index: number): string => new Date(Date.UTC(2026, 10, 1) + index * 1000).toISOString();
  const ok = (index: number) => ({ timestamp: at(index), status: "succeeded" });
  const retry = (index: number) => ({ timestamp: at(index), status: "succeeded", duplicateOfRequestId: "x" });
  const failed = (index: number) => ({ timestamp: at(index), status: "failed" });

  it("an empty ledger gives zero rates", () => {
    expect(recentDriftRates([])).toEqual({ sampleSize: 0, retryRate: 0, failureRate: 0 });
  });

  it("a long clean history does not dilute a fresh rise", () => {
    // 5,000 clean requests, then 200 where one in five is a retry.
    const history = Array.from({ length: 5000 }, (_, i) => ok(i));
    const recent = Array.from({ length: DRIFT_WINDOW_EVENTS }, (_, i) => (i % 5 === 0 ? retry(5000 + i) : ok(5000 + i)));
    const rates = recentDriftRates([...history, ...recent]);
    expect(rates.sampleSize).toBe(DRIFT_WINDOW_EVENTS);
    expect(rates.retryRate).toBeCloseTo(0.2, 5); // whole-ledger would read 0.8%, under the 5-point line
  });

  it("takes the latest events by time, whatever order the spools were read in", () => {
    // Two spools concatenated: the older app's events come last in the array.
    const newer = [failed(10), failed(11)];
    const older = [ok(0), ok(1), ok(2)];
    const rates = recentDriftRates([...newer, ...older], 2);
    expect(rates).toEqual({ sampleSize: 2, retryRate: 0, failureRate: 1 });
  });
});
