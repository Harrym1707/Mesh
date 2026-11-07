import { describe, expect, it } from "vitest";
import {
  CandidateSelector,
  DEFAULT_MINIMUM_SAMPLES,
  EscalationManager,
  PolicyLoader,
  RolloutManager,
  ROLLOUT_LADDER,
  ROLLOUT_LADDER_TOP,
  RollbackManager,
  Router,
  RoutingService,
  cohortPosition,
  routingDecisionEvent,
  type RolloutCandidate,
  type RolloutState,
  type RouterRequest,
  type RoutingTelemetrySink,
  type StagedRoutingPolicy,
} from "./routing.js";
import type { InferenceEvent, QualityResult } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const passingQuality: QualityResult = {
  passed: true,
  score: 0.994,
  checks: { schema: true },
  reason: "ok",
};

function candidate(overrides: Partial<RolloutCandidate> = {}): RolloutCandidate {
  return {
    target: { provider: "openai", model: "small-model" },
    estimatedCostReduction: 0.71,
    qualityPolicy: { minimumScore: 0.99, minimumSamples: 200 },
    approved: true,
    evidence: { quality: passingQuality, sampleSize: 500 },
    ...overrides,
  };
}

function policy(overrides: Partial<StagedRoutingPolicy> = {}): StagedRoutingPolicy {
  return {
    id: "pol_classification",
    version: 1,
    taskClass: "classification",
    baseline: { provider: "openai", model: "gpt-x" },
    candidate: candidate(),
    rollout: { stageIndex: 0, status: "active" },
    enabled: true,
    ...overrides,
  };
}

function atStage(stageIndex: number, overrides: Partial<StagedRoutingPolicy> = {}): StagedRoutingPolicy {
  return policy({ rollout: { stageIndex, status: "active" }, ...overrides });
}

function request(requestId: string, taskClass = "classification"): RouterRequest {
  return { requestId, taskClass };
}

/** The share of 10k synthetic request ids the router sends to the candidate. */
function candidateShare(p: StagedRoutingPolicy, n = 10_000): number {
  const router = new Router();
  let routed = 0;
  for (let i = 0; i < n; i += 1) {
    if (!router.route(request(`req-${i}`), p).isBaseline) routed += 1;
  }
  return routed / n;
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("Router determinism", () => {
  it("returns an identical decision for the same request and policy", () => {
    const router = new Router();
    const p = atStage(2); // 10%
    const first = router.route(request("stable-key"), p);
    const second = router.route(request("stable-key"), p);
    expect(second).toEqual(first);
  });

  it("uses no randomness: a full-rollout policy routes every request to the candidate", () => {
    const router = new Router();
    const p = atStage(ROLLOUT_LADDER_TOP); // 100%
    for (const id of ["a", "b", "c", "zzz", "123"]) {
      expect(router.route(request(id), p).isBaseline).toBe(false);
    }
  });

  it("cohort position is stable and in [0, 1)", () => {
    const pos = cohortPosition({ id: "pol", version: 1 }, "req-1");
    expect(pos).toBe(cohortPosition({ id: "pol", version: 1 }, "req-1"));
    expect(pos).toBeGreaterThanOrEqual(0);
    expect(pos).toBeLessThan(1);
  });

  it("is monotonic: a request served by the candidate at 10% stays served as rollout widens", () => {
    const router = new Router();
    const servedAt10 = Array.from({ length: 2_000 }, (_, i) => `req-${i}`).filter(
      (id) => !router.route(request(id), atStage(2)).isBaseline, // 10%
    );
    expect(servedAt10.length).toBeGreaterThan(0);
    for (const id of servedAt10) {
      expect(router.route(request(id), atStage(3)).isBaseline).toBe(false); // 25%
      expect(router.route(request(id), atStage(ROLLOUT_LADDER_TOP)).isBaseline).toBe(false);
    }
  });

  it("reshuffles the cohort when the policy version changes", () => {
    const a = cohortPosition({ id: "pol", version: 1 }, "req-1");
    const b = cohortPosition({ id: "pol", version: 2 }, "req-1");
    expect(a).not.toBe(b);
  });

  it("emits the spec routeReason fields on a candidate decision", () => {
    const decision = new Router().route(request("x"), atStage(2));
    // x happens to fall in the 10% cohort; assert the reason shape regardless.
    const served = new Router().route(
      request(
        Array.from({ length: 1_000 }, (_, i) => `req-${i}`).find(
          (id) => !new Router().route(request(id), atStage(2)).isBaseline,
        )!,
      ),
      atStage(2),
    );
    expect(served.reason).toContain("task_class=classification");
    expect(served.reason).toContain("candidate=small-model");
    expect(served.reason).toContain("quality_evidence=99.4%");
    expect(served.reason).toContain("threshold=99%");
    expect(served.reason).toContain("estimated_cost_reduction=71%");
    expect(served.reason).toContain("rollout=10%");
    // The arbitrary `x` decision is deterministic too.
    expect(decision).toEqual(new Router().route(request("x"), atStage(2)));
  });
});

// ---------------------------------------------------------------------------
// Quality gate (core invariant)
// ---------------------------------------------------------------------------

describe("CandidateSelector quality gate", () => {
  const selector = new CandidateSelector();

  it("qualifies an approved candidate that clears its policy on enough samples", () => {
    expect(selector.select(candidate()).qualified).toBe(true);
  });

  it("refuses a candidate below the score threshold", () => {
    const verdict = selector.select(
      candidate({ evidence: { quality: { ...passingQuality, score: 0.95 }, sampleSize: 500 } }),
    );
    expect(verdict).toMatchObject({ qualified: false, reason: "quality_gate_failed" });
  });

  it("refuses a candidate with too few samples", () => {
    const verdict = selector.select(
      candidate({ evidence: { quality: passingQuality, sampleSize: 2 } }),
    );
    expect(verdict).toMatchObject({ qualified: false, reason: "insufficient_samples" });
  });

  it("refuses an unapproved candidate even when quality is met", () => {
    const verdict = selector.select(candidate({ approved: false }));
    expect(verdict).toMatchObject({ qualified: false, reason: "candidate_not_approved" });
  });
});

describe("Router falls back to baseline unless the candidate qualifies", () => {
  const router = new Router();

  it("routes 100% to baseline when quality fails, despite full rollout", () => {
    const p = atStage(ROLLOUT_LADDER_TOP, {
      candidate: candidate({ evidence: { quality: { ...passingQuality, passed: false, score: 0.5 }, sampleSize: 500 } }),
    });
    expect(candidateShare(p)).toBe(0);
    expect(router.route(request("any"), p).reason).toBe("quality_gate_failed");
  });

  it("routes to baseline on a task-class mismatch", () => {
    const decision = router.route({ requestId: "x", taskClass: "summarisation" }, atStage(ROLLOUT_LADDER_TOP));
    expect(decision).toMatchObject({ isBaseline: true, reason: "task_class_mismatch" });
  });

  it("routes to baseline when the policy is disabled", () => {
    expect(router.route(request("x"), policy({ enabled: false })).reason).toBe("policy_disabled");
  });

  it("routes to baseline when the rollout is halted", () => {
    const p = policy({ rollout: { stageIndex: -1, status: "halted" } });
    expect(router.route(request("x"), p).reason).toBe("rolled_back");
  });
});

// ---------------------------------------------------------------------------
// Rollout ladder
// ---------------------------------------------------------------------------

describe("rollout ladder", () => {
  it("is the spec ladder 1% -> 5% -> 10% -> 25% -> 50% -> 100%", () => {
    expect([...ROLLOUT_LADDER]).toEqual([0.01, 0.05, 0.1, 0.25, 0.5, 1]);
  });

  it("routes roughly the stage percentage of traffic to the candidate", () => {
    // 1% rung: a small but non-zero slice; 50% rung: about half.
    expect(candidateShare(atStage(0))).toBeLessThan(0.03);
    expect(candidateShare(atStage(0))).toBeGreaterThan(0);
    const half = candidateShare(atStage(4));
    expect(half).toBeGreaterThan(0.45);
    expect(half).toBeLessThan(0.55);
  });

  it("the share grows monotonically up the ladder", () => {
    const shares = ROLLOUT_LADDER.map((_, stage) => candidateShare(atStage(stage)));
    for (let i = 1; i < shares.length; i += 1) {
      expect(shares[i]).toBeGreaterThanOrEqual(shares[i - 1]!);
    }
    expect(shares.at(-1)).toBe(1);
  });
});

describe("RolloutManager", () => {
  const manager = new RolloutManager();

  it("starts a fresh rollout at 1%", () => {
    const state = manager.initial();
    expect(state).toMatchObject({ stageIndex: 0, status: "active" });
    expect(manager.percentage(state)).toBe(0.01);
  });

  it("advances one rung and reports the new percentage", () => {
    const state = manager.advance(manager.initial());
    expect(state.stageIndex).toBe(1);
    expect(manager.percentage(state)).toBe(0.05);
  });

  it("caps advancement at 100% and reports completion", () => {
    const top = manager.advance({ stageIndex: ROLLOUT_LADDER_TOP, status: "active" });
    expect(top.stageIndex).toBe(ROLLOUT_LADDER_TOP);
    expect(manager.isComplete(top)).toBe(true);
    expect(manager.percentage(top)).toBe(1);
  });

  it("will not advance a halted rollout", () => {
    const halted: RolloutState = { stageIndex: -1, status: "halted" };
    expect(manager.advance(halted)).toEqual(halted);
  });

  it("steps down one rung, and halts when stepping below the first rung", () => {
    expect(manager.stepDown({ stageIndex: 3, status: "active" }).stageIndex).toBe(2);
    const halted = manager.stepDown({ stageIndex: 0, status: "active" });
    expect(halted).toMatchObject({ stageIndex: -1, status: "halted" });
    expect(manager.percentage(halted)).toBe(0);
  });

  it("halts and resumes", () => {
    const halted = manager.halt(manager.initial());
    expect(halted.status).toBe("halted");
    expect(manager.resume(halted)).toMatchObject({ stageIndex: 0, status: "active" });
  });

  it("treats every transition as immutable", () => {
    const start = manager.initial();
    manager.advance(start);
    expect(start.stageIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

describe("EscalationManager", () => {
  const goodSignal = { quality: passingQuality, sampleSize: 1_000 };

  it("advances one rung on a healthy signal with enough dwell", () => {
    const manager = new EscalationManager({ minimumSamplesPerStage: 100 });
    const decision = manager.evaluate(atStage(1), goodSignal); // 5%
    expect(decision.action).toBe("advance");
    expect(decision.rollout.stageIndex).toBe(2); // -> 10%
  });

  it("holds when too little traffic has been observed at the stage", () => {
    const manager = new EscalationManager({ minimumSamplesPerStage: 100 });
    const decision = manager.evaluate(atStage(1), { quality: passingQuality, sampleSize: 10 });
    expect(decision).toMatchObject({ action: "hold", reason: "insufficient_dwell" });
  });

  it("holds at the top of the ladder", () => {
    const manager = new EscalationManager({ minimumSamplesPerStage: 100 });
    const decision = manager.evaluate(atStage(ROLLOUT_LADDER_TOP), goodSignal);
    expect(decision).toMatchObject({ action: "hold", reason: "rollout_complete" });
  });

  it("rolls back instead of advancing when the live signal regresses", () => {
    const manager = new EscalationManager({ minimumSamplesPerStage: 100 });
    const decision = manager.evaluate(atStage(3), {
      quality: { ...passingQuality, passed: false, score: 0.4 },
      sampleSize: 1_000,
    });
    expect(decision.action).toBe("rollback");
    expect(decision.rollout.status).toBe("halted");
  });

  it("walks the full ladder from 1% to 100% on sustained good signal", () => {
    const manager = new EscalationManager({ minimumSamplesPerStage: 100 });
    let current = policy();
    const stages: number[] = [current.rollout.stageIndex];
    for (let i = 0; i < 10; i += 1) {
      const decision = manager.evaluate(current, goodSignal);
      current = { ...current, rollout: decision.rollout };
      stages.push(current.rollout.stageIndex);
      if (decision.reason === "rollout_complete") break;
    }
    expect(stages).toEqual([0, 1, 2, 3, 4, 5, 5]);
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

describe("RollbackManager", () => {
  const regressed = { quality: { ...passingQuality, passed: false, score: 0.3 }, sampleSize: 300 };

  it("detects a quality regression against the candidate policy", () => {
    const manager = new RollbackManager();
    expect(manager.shouldRollback(candidate(), regressed)).toBe(true);
    expect(manager.shouldRollback(candidate(), { quality: passingQuality, sampleSize: 300 })).toBe(false);
  });

  it("halts the rollout to baseline by default", () => {
    const manager = new RollbackManager("halt");
    const reverted = manager.rollback(atStage(4));
    expect(reverted.rollout).toMatchObject({ stageIndex: -1, status: "halted" });
    // After rollback the Router sends everything to baseline.
    expect(candidateShare(reverted)).toBe(0);
  });

  it("steps down one rung in step_down mode", () => {
    const manager = new RollbackManager("step_down");
    const reverted = manager.rollback(atStage(4));
    expect(reverted.rollout).toMatchObject({ stageIndex: 3, status: "active" });
  });

  it("decide() reverts only on a breach and leaves a holding signal untouched", () => {
    const manager = new RollbackManager("halt");
    expect(manager.decide(atStage(4), regressed)).toMatchObject({ triggered: true });
    const holding = manager.decide(atStage(4), { quality: passingQuality, sampleSize: 300 });
    expect(holding).toMatchObject({ triggered: false, reason: "quality_holding" });
    expect(holding.rollout).toEqual(atStage(4).rollout);
  });
});

// ---------------------------------------------------------------------------
// PolicyLoader
// ---------------------------------------------------------------------------

describe("PolicyLoader", () => {
  it("loads the active policy for a task class", () => {
    const loader = new PolicyLoader([policy()]);
    expect(loader.load("classification")?.id).toBe("pol_classification");
    expect(loader.load("summarisation")).toBeUndefined();
    expect(loader.load(undefined)).toBeUndefined();
  });

  it("does not serve a disabled policy", () => {
    const loader = new PolicyLoader([policy({ enabled: false })]);
    expect(loader.load("classification")).toBeUndefined();
    expect(loader.loadById("pol_classification")?.enabled).toBe(false);
  });

  it("serves the latest version for a task class", () => {
    const loader = new PolicyLoader([policy({ id: "v1", version: 1 })]);
    loader.register(policy({ id: "v2", version: 2 }));
    expect(loader.load("classification")?.id).toBe("v2");
  });

  it("persists a lifecycle transition via update", () => {
    const loader = new PolicyLoader([policy()]);
    const advanced = { ...policy(), rollout: { stageIndex: 3, status: "active" as const } };
    loader.update(advanced);
    expect(loader.load("classification")?.rollout.stageIndex).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

describe("routing telemetry", () => {
  it("maps a decision onto an InferenceEvent carrying the routeReason", () => {
    const decision = new Router().route(request("full"), atStage(ROLLOUT_LADDER_TOP));
    const event = routingDecisionEvent(request("full"), decision, {
      applicationId: "app-1",
      timestamp: "2026-11-07T00:00:00.000Z",
    });
    expect(event).toMatchObject({
      requestId: "full",
      applicationId: "app-1",
      provider: "openai",
      model: "small-model",
      policyId: "pol_classification",
      policyVersion: 1,
      routeReason: decision.reason,
    });
  });

  it("RoutingService records every served request, even a baseline fallback", async () => {
    const recorded: InferenceEvent[] = [];
    const sink: RoutingTelemetrySink = { record: (event) => void recorded.push(event) };
    const loader = new PolicyLoader([atStage(ROLLOUT_LADDER_TOP)]);
    const service = new RoutingService(loader, sink);
    const telemetry = { applicationId: "app-1", timestamp: "2026-11-07T00:00:00.000Z" };

    const served = await service.route(request("full"), { provider: "openai", model: "gpt-x" }, telemetry);
    expect(served.isBaseline).toBe(false);

    const noPolicy = await service.route(request("x", "unknown-task"), { provider: "openai", model: "gpt-x" }, telemetry);
    expect(noPolicy).toMatchObject({ isBaseline: true, reason: "no_active_policy" });

    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.routeReason).toContain("candidate=small-model");
    expect(recorded[1]?.routeReason).toBe("no_active_policy");
  });
});

// ---------------------------------------------------------------------------
// Error-rate and latency ceilings (quality gate)
// ---------------------------------------------------------------------------

describe("Router enforces the error-rate and latency ceilings", () => {
  const router = new Router();
  const selector = new CandidateSelector();

  it("refuses a candidate whose measured error rate breaches maxErrorRate", () => {
    const c = candidate({
      qualityPolicy: { minimumScore: 0.99, maxErrorRate: 0.02, minimumSamples: 200 },
      evidence: { quality: { ...passingQuality, errorRate: 0.1 }, sampleSize: 500 },
    });
    expect(selector.select(c).qualified).toBe(false);
    const p = atStage(ROLLOUT_LADDER_TOP, { candidate: c });
    expect(candidateShare(p)).toBe(0); // zero candidate traffic even at 100%
    expect(router.route(request("any"), p).isBaseline).toBe(true);
  });

  it("routes a candidate within the error-rate ceiling", () => {
    const c = candidate({
      qualityPolicy: { minimumScore: 0.99, maxErrorRate: 0.02, minimumSamples: 200 },
      evidence: { quality: { ...passingQuality, errorRate: 0.005 }, sampleSize: 500 },
    });
    expect(selector.select(c).qualified).toBe(true);
    expect(router.route(request("any"), atStage(ROLLOUT_LADDER_TOP, { candidate: c })).isBaseline).toBe(false);
  });

  it("refuses a candidate whose measured latency breaches maxLatencyMs", () => {
    const c = candidate({
      qualityPolicy: { minimumScore: 0.99, maxLatencyMs: 800, minimumSamples: 200 },
      evidence: { quality: { ...passingQuality, latencyMs: 2_500 }, sampleSize: 500 },
    });
    expect(selector.select(c).qualified).toBe(false);
    expect(candidateShare(atStage(ROLLOUT_LADDER_TOP, { candidate: c }))).toBe(0);
  });

  it("fails closed when a ceiling is configured but never measured", () => {
    const c = candidate({
      qualityPolicy: { minimumScore: 0.99, maxErrorRate: 0.02, minimumSamples: 200 },
      evidence: { quality: passingQuality, sampleSize: 500 }, // no errorRate measured
    });
    expect(selector.select(c).qualified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Default minimum-samples floor
// ---------------------------------------------------------------------------

describe("default minimum-samples floor", () => {
  const selector = new CandidateSelector();

  it("exposes a floor above one or two examples", () => {
    expect(DEFAULT_MINIMUM_SAMPLES).toBeGreaterThan(2);
  });

  it("refuses a candidate that omits minimumSamples and rests on too few examples", () => {
    const c = candidate({
      qualityPolicy: { minimumScore: 0.99 }, // no minimumSamples -> floor applies
      evidence: { quality: passingQuality, sampleSize: 3 },
    });
    expect(selector.select(c)).toMatchObject({ qualified: false, reason: "insufficient_samples" });
  });

  it("qualifies once the floor is cleared", () => {
    const c = candidate({
      qualityPolicy: { minimumScore: 0.99 },
      evidence: { quality: passingQuality, sampleSize: DEFAULT_MINIMUM_SAMPLES },
    });
    expect(selector.select(c).qualified).toBe(true);
  });

  it("EscalationManager holds on a sub-floor signal by default", () => {
    const manager = new EscalationManager();
    const decision = manager.evaluate(atStage(1), { quality: passingQuality, sampleSize: 3 });
    expect(decision.action).toBe("hold");
  });
});

// ---------------------------------------------------------------------------
// Rollback dwell guard (anti-flapping)
// ---------------------------------------------------------------------------

describe("RollbackManager dwell guard", () => {
  const regressing = { ...passingQuality, passed: false, score: 0.3 };

  it("does not roll back on a breach measured on too few samples", () => {
    const manager = new RollbackManager("halt");
    const decision = manager.decide(atStage(4), { quality: regressing, sampleSize: 2 });
    expect(decision).toMatchObject({ triggered: false, reason: "insufficient_samples" });
  });

  it("rolls back on a breach once the sample floor is cleared", () => {
    const manager = new RollbackManager("halt");
    const decision = manager.decide(atStage(4), { quality: regressing, sampleSize: DEFAULT_MINIMUM_SAMPLES });
    expect(decision.triggered).toBe(true);
    expect(decision.rollout.status).toBe("halted");
  });

  it("honours a custom rollback dwell threshold", () => {
    const manager = new RollbackManager("halt", new RolloutManager(), { minimumSamples: 100 });
    expect(manager.decide(atStage(4), { quality: regressing, sampleSize: 50 }).triggered).toBe(false);
    expect(manager.decide(atStage(4), { quality: regressing, sampleSize: 150 }).triggered).toBe(true);
  });
});
