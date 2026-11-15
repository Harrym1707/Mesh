import { createHash } from "node:crypto";
import { applyQualityPolicy } from "./evaluator.js";
import type {
  InferenceEvent,
  ModelTarget,
  QualityPolicy,
  QualityResult,
  RoutingDecision,
} from "./types.js";

/**
 * Stage 6 --- the Router.
 *
 * The control plane decides, per task class, whether a request is served by the
 * baseline model or by an approved cheaper candidate, and advances or reverts
 * that candidate along a staged rollout ladder. This module is the engine
 * behind those decisions, built from the six components the spec names:
 *
 *   PolicyLoader       -- holds the active staged policy per task class.
 *   CandidateSelector  -- the quality gate: may this candidate take traffic?
 *   Router             -- the deterministic per-request decision.
 *   RolloutManager     -- the pure 1% -> 100% ladder state machine.
 *   EscalationManager  -- promotes a candidate up the ladder on good signal.
 *   RollbackManager    -- reverts a candidate on a quality regression.
 *
 * Two invariants hold throughout:
 *
 *   1. Determinism. Once a policy is selected, `Router.route(request, policy)`
 *      is a pure function of the request and that policy: the same pair always
 *      yields the same `RoutingDecision`. No clocks, no `Math.random`. A
 *      request's cohort position is a stable hash, so it also never flip-flops
 *      as the rollout widens -- a request served by the candidate at 10% is
 *      still served by it at 25%.
 *
 *   2. Quality first. A cheaper candidate is activated ONLY when its quality
 *      policy (Stage 5) requirements are met on enough samples and a human has
 *      approved it; otherwise the request falls back to baseline. Cost is never
 *      reduced by silently reducing customer-defined output quality.
 */

/** The staged rollout ladder: the fraction of traffic the candidate may take at each rung. */
export const ROLLOUT_LADDER = [0.01, 0.05, 0.1, 0.25, 0.5, 1] as const;

/** Index of the final (100%) rung. */
export const ROLLOUT_LADDER_TOP = ROLLOUT_LADDER.length - 1;

/** `stageIndex` for a halted rollout: no candidate traffic, baseline only. */
export const ROLLOUT_HALTED_STAGE = -1;

/**
 * Default floor for evaluation/observation sample sizes when a policy omits its
 * own. A candidate is never qualified, escalated, or rolled back on one or two
 * examples (Technical Architecture §6); 30 is the smallest sample that carries
 * any statistical signal.
 */
export const DEFAULT_MINIMUM_SAMPLES = 30;

/**
 * Where a candidate sits on the ladder right now. `stageIndex` is an index into
 * `ROLLOUT_LADDER` while `status` is `"active"`; a `"halted"` rollout sends no
 * candidate traffic regardless of the index.
 */
export type RolloutState = {
  stageIndex: number;
  status: "active" | "halted";
  /** Trace of the transition that produced this state. */
  lastReason?: string;
};

/** Stage 5 evaluation evidence standing behind a candidate. */
export type CandidateEvidence = {
  /** Measured quality of the candidate from offline evaluation. */
  quality: QualityResult;
  /** How many evaluation samples the measurement rests on. */
  sampleSize: number;
};

/** A cheaper model a policy may route to, with the bar it must clear first. */
export type RolloutCandidate = {
  target: ModelTarget;
  /** Fraction of baseline cost avoided, 0..1 (0.71 == 71% cheaper). */
  estimatedCostReduction: number;
  /** The quality bar this candidate must clear before any traffic (Stage 5). */
  qualityPolicy: QualityPolicy;
  /** Explicit human sign-off after reviewing the offline evaluation. */
  approved: boolean;
  /** Measured quality evidence from Stage 5. */
  evidence: CandidateEvidence;
};

/**
 * A compiled, runtime policy for one task class: the baseline, the single
 * candidate under rollout, and where that candidate currently sits on the
 * ladder. One candidate per policy keeps the cohort interval unambiguous; a
 * second cheaper model is a new policy version.
 */
export type StagedRoutingPolicy = {
  id: string;
  version: number;
  taskClass: string;
  baseline: ModelTarget;
  candidate: RolloutCandidate;
  rollout: RolloutState;
  enabled: boolean;
};

/**
 * The minimum a request must carry for a routing decision. `requestId` is any
 * stable, non-sensitive identity (request id, tenant+user, job id); it is the
 * only thing the cohort hash reads, so the same identity always lands in the
 * same cohort.
 */
export type RouterRequest = {
  requestId: string;
  taskClass?: string;
};

/** A live production quality signal observed at the current rollout stage. */
export type RolloutSignal = {
  /** Measured quality of candidate traffic at the current stage. */
  quality: QualityResult;
  /** Observations gathered at the current stage. */
  sampleSize: number;
};

// ---------------------------------------------------------------------------
// Deterministic cohort bucketing
// ---------------------------------------------------------------------------

/**
 * Map a policy and a request identity to a stable position in [0, 1). Same
 * inputs, same position, forever -- this is what makes routing deterministic
 * and monotonic across rollout stages. The policy version is part of the key so
 * a new policy version reshuffles cohorts (a fresh rollout), while every stage
 * of one version shares one cohort assignment.
 */
export function cohortPosition(policy: Pick<StagedRoutingPolicy, "id" | "version">, requestId: string): number {
  const firstWord = createHash("sha256")
    .update(`${policy.id}:${policy.version}:${requestId}`)
    .digest()
    .readUInt32BE(0);
  return firstWord / 0x1_0000_0000;
}

function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1)}%`;
}

/**
 * The human-readable `routeReason` (Technical Architecture §5). Carries the task
 * class, the candidate, the quality evidence against its threshold, the
 * estimated cost reduction, and the rollout percentage the decision was made at.
 */
export function formatRouteReason(
  policy: StagedRoutingPolicy,
  quality: QualityResult,
  rolloutFraction: number,
): string {
  const { candidate } = policy;
  const parts = [
    `task_class=${policy.taskClass}`,
    `candidate=${candidate.target.model}`,
  ];
  if (quality.score !== undefined) parts.push(`quality_evidence=${formatPercent(quality.score)}`);
  if (candidate.qualityPolicy.minimumScore !== undefined) {
    parts.push(`threshold=${formatPercent(candidate.qualityPolicy.minimumScore)}`);
  }
  parts.push(`estimated_cost_reduction=${formatPercent(candidate.estimatedCostReduction)}`);
  parts.push(`rollout=${formatPercent(rolloutFraction)}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// CandidateSelector -- the quality gate
// ---------------------------------------------------------------------------

export type CandidateVerdict =
  | { qualified: true; quality: QualityResult }
  | { qualified: false; reason: string; quality: QualityResult };

/**
 * Decides whether a candidate is allowed to take ANY traffic, independent of
 * the rollout percentage. This is the enforcement point for the core invariant:
 * a candidate qualifies only with human approval, enough samples, and a quality
 * measurement that clears its own quality policy.
 */
export class CandidateSelector {
  select(candidate: RolloutCandidate): CandidateVerdict {
    const { evidence, qualityPolicy } = candidate;
    if (!candidate.approved) {
      return { qualified: false, reason: "candidate_not_approved", quality: evidence.quality };
    }
    const minimumSamples = qualityPolicy.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES;
    if (!Number.isInteger(evidence.sampleSize) || evidence.sampleSize < minimumSamples) {
      return { qualified: false, reason: "insufficient_samples", quality: evidence.quality };
    }
    const evaluated = applyQualityPolicy(evidence.quality, qualityPolicy);
    if (!evaluated.passed) {
      return { qualified: false, reason: "quality_gate_failed", quality: evaluated };
    }
    return { qualified: true, quality: evaluated };
  }
}

// ---------------------------------------------------------------------------
// Router -- the deterministic per-request decision
// ---------------------------------------------------------------------------

/**
 * The Router from the architecture spec: `route(request, policy)` returns a
 * `RoutingDecision` and is a pure function of its inputs. Every path that does
 * not route to the candidate falls back to baseline with a reason naming why.
 */
export class Router {
  constructor(private readonly selector: CandidateSelector = new CandidateSelector()) {}

  route(request: RouterRequest, policy: StagedRoutingPolicy): RoutingDecision {
    const baseline = (reason: string): RoutingDecision => ({
      target: policy.baseline,
      reason,
      policyId: policy.id,
      policyVersion: policy.version,
      isBaseline: true,
    });

    if (!policy.enabled) return baseline("policy_disabled");
    if (policy.rollout.status === "halted" || policy.rollout.stageIndex < 0) {
      return baseline("rolled_back");
    }
    if (request.taskClass !== policy.taskClass) return baseline("task_class_mismatch");

    // Quality first: an unqualified candidate never takes traffic.
    const verdict = this.selector.select(policy.candidate);
    if (!verdict.qualified) return baseline(verdict.reason);

    const rolloutFraction = ROLLOUT_LADDER[policy.rollout.stageIndex];
    if (rolloutFraction === undefined) return baseline("invalid_rollout_stage");

    // Deterministic cohort assignment: stable position, stable decision.
    const position = cohortPosition(policy, request.requestId);
    if (position >= rolloutFraction) return baseline("rollout_not_selected");

    return {
      target: policy.candidate.target,
      reason: formatRouteReason(policy, verdict.quality, rolloutFraction),
      policyId: policy.id,
      policyVersion: policy.version,
      isBaseline: false,
    };
  }
}

// ---------------------------------------------------------------------------
// RolloutManager -- the ladder state machine
// ---------------------------------------------------------------------------

/**
 * The pure ladder state machine. Every transition returns a NEW state; nothing
 * is mutated in place, so a caller can keep the prior state to revert to.
 */
export class RolloutManager {
  readonly ladder = ROLLOUT_LADDER;

  /** A fresh rollout: active at the first rung (1%). */
  initial(): RolloutState {
    return { stageIndex: 0, status: "active", lastReason: "rollout_started" };
  }

  /** The traffic fraction this state grants the candidate (0 when halted). */
  percentage(state: RolloutState): number {
    if (state.status === "halted" || state.stageIndex < 0) return 0;
    return this.ladder[state.stageIndex] ?? 0;
  }

  /** True once the candidate is active at the final (100%) rung. */
  isComplete(state: RolloutState): boolean {
    return state.status === "active" && state.stageIndex >= ROLLOUT_LADDER_TOP;
  }

  /**
   * Promote one rung. A halted rollout cannot advance (resume it first); the top
   * rung is a no-op. Returns the input state unchanged when neither applies.
   */
  advance(state: RolloutState, reason = "escalated"): RolloutState {
    if (state.status === "halted" || state.stageIndex < 0) return state;
    if (state.stageIndex >= ROLLOUT_LADDER_TOP) {
      return { ...state, lastReason: "rollout_complete" };
    }
    return { stageIndex: state.stageIndex + 1, status: "active", lastReason: reason };
  }

  /**
   * Revert one rung. Stepping down from the first rung halts the rollout (no
   * candidate traffic). This is the graduated rollback path.
   */
  stepDown(state: RolloutState, reason = "rolled_back"): RolloutState {
    if (state.stageIndex <= 0) return this.halt(state, reason);
    return { stageIndex: state.stageIndex - 1, status: "active", lastReason: reason };
  }

  /** Full stop: no candidate traffic, baseline only, until resumed. */
  halt(_state: RolloutState, reason = "rolled_back"): RolloutState {
    return { stageIndex: ROLLOUT_HALTED_STAGE, status: "halted", lastReason: reason };
  }

  /** Resume a halted rollout back at the first rung. */
  resume(_state: RolloutState, reason = "resumed"): RolloutState {
    return { stageIndex: 0, status: "active", lastReason: reason };
  }
}

// ---------------------------------------------------------------------------
// RollbackManager -- the revert path
// ---------------------------------------------------------------------------

/** How a rollback reverts: a full stop to baseline, or one rung down the ladder. */
export type RollbackMode = "halt" | "step_down";

export type RollbackDecision = {
  triggered: boolean;
  rollout: RolloutState;
  reason: string;
};

/**
 * The authority on quality regressions during rollout. It decides when a live
 * signal breaches the candidate's quality bar and produces the reverted state.
 */
export class RollbackManager {
  private readonly minimumSamples: number;

  constructor(
    private readonly mode: RollbackMode = "halt",
    private readonly rolloutManager: RolloutManager = new RolloutManager(),
    options: { minimumSamples?: number } = {},
  ) {
    this.minimumSamples = options.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES;
  }

  /** True when live candidate quality no longer clears the candidate's policy. */
  shouldRollback(candidate: RolloutCandidate, signal: RolloutSignal): boolean {
    return !applyQualityPolicy(signal.quality, candidate.qualityPolicy).passed;
  }

  /** Revert the policy's rollout (halt or step down, per the configured mode). */
  rollback(policy: StagedRoutingPolicy, reason = "quality_regression"): StagedRoutingPolicy {
    const rollout = this.mode === "halt"
      ? this.rolloutManager.halt(policy.rollout, reason)
      : this.rolloutManager.stepDown(policy.rollout, reason);
    return { ...policy, rollout };
  }

  /**
   * Inspect a signal and, if it breaches quality on enough samples, produce the
   * reverted state. A breach measured on fewer than `minimumSamples` is held,
   * not acted on, so the ladder does not flap on one or two bad examples.
   */
  decide(policy: StagedRoutingPolicy, signal: RolloutSignal): RollbackDecision {
    if (!Number.isInteger(signal.sampleSize) || signal.sampleSize < this.minimumSamples) {
      return { triggered: false, rollout: policy.rollout, reason: "insufficient_samples" };
    }
    if (!this.shouldRollback(policy.candidate, signal)) {
      return { triggered: false, rollout: policy.rollout, reason: "quality_holding" };
    }
    const reason = "quality_regression";
    const rollout = this.mode === "halt"
      ? this.rolloutManager.halt(policy.rollout, reason)
      : this.rolloutManager.stepDown(policy.rollout, reason);
    return { triggered: true, rollout, reason };
  }
}

// ---------------------------------------------------------------------------
// EscalationManager -- the promotion path
// ---------------------------------------------------------------------------

export type EscalationAction = "advance" | "hold" | "rollback";

export type EscalationDecision = {
  action: EscalationAction;
  rollout: RolloutState;
  reason: string;
};

/**
 * Drives a candidate up the ladder from a live production quality signal. A
 * regression always rolls back first (delegated to the RollbackManager); a
 * healthy signal advances one rung once enough traffic has been observed at the
 * current stage; otherwise it holds. Advancement itself never relaxes the
 * quality gate -- the Router still re-checks quality on every request.
 */
export class EscalationManager {
  private readonly minimumSamplesPerStage: number;

  constructor(
    options: { minimumSamplesPerStage?: number } = {},
    private readonly rolloutManager: RolloutManager = new RolloutManager(),
    private readonly rollbackManager: RollbackManager = new RollbackManager(),
  ) {
    this.minimumSamplesPerStage = options.minimumSamplesPerStage ?? DEFAULT_MINIMUM_SAMPLES;
  }

  evaluate(policy: StagedRoutingPolicy, signal: RolloutSignal): EscalationDecision {
    if (policy.rollout.status === "halted" || policy.rollout.stageIndex < 0) {
      return { action: "hold", rollout: policy.rollout, reason: "rollout_halted" };
    }

    const rollback = this.rollbackManager.decide(policy, signal);
    if (rollback.triggered) {
      return { action: "rollback", rollout: rollback.rollout, reason: rollback.reason };
    }

    if (!Number.isInteger(signal.sampleSize) || signal.sampleSize < this.minimumSamplesPerStage) {
      return { action: "hold", rollout: policy.rollout, reason: "insufficient_dwell" };
    }

    if (this.rolloutManager.isComplete(policy.rollout)) {
      return { action: "hold", rollout: policy.rollout, reason: "rollout_complete" };
    }

    return {
      action: "advance",
      rollout: this.rolloutManager.advance(policy.rollout, "escalated"),
      reason: "quality_holding_advance",
    };
  }
}

// ---------------------------------------------------------------------------
// PolicyLoader -- the active-policy registry
// ---------------------------------------------------------------------------

/**
 * Holds the active staged policy per task class. In production this is a
 * local/Redis-backed cache the data plane reads on the hot path (Technical
 * Architecture §2); here it is an in-memory registry with the same contract:
 * lookups are cheap and deterministic, disabled policies are not served, and
 * the latest version wins for a task class.
 *
 * Lifecycle updates from the EscalationManager / RollbackManager are persisted
 * with `update`, which bumps nothing but the stored rollout state -- the policy
 * id and version are stable across ladder movements within one version.
 */
export class PolicyLoader {
  private readonly byId = new Map<string, StagedRoutingPolicy>();
  private readonly byTaskClass = new Map<string, string>();

  constructor(policies: readonly StagedRoutingPolicy[] = []) {
    for (const policy of policies) this.register(policy);
  }

  register(policy: StagedRoutingPolicy): void {
    this.byId.set(policy.id, policy);
    const current = this.byTaskClass.get(policy.taskClass);
    const incumbent = current ? this.byId.get(current) : undefined;
    if (!incumbent || policy.version >= incumbent.version) {
      this.byTaskClass.set(policy.taskClass, policy.id);
    }
  }

  /** The active policy for a task class, or undefined when none is enabled. */
  load(taskClass: string | undefined): StagedRoutingPolicy | undefined {
    if (taskClass === undefined) return undefined;
    const id = this.byTaskClass.get(taskClass);
    const policy = id ? this.byId.get(id) : undefined;
    return policy?.enabled ? policy : undefined;
  }

  loadById(id: string): StagedRoutingPolicy | undefined {
    return this.byId.get(id);
  }

  /** Persist a lifecycle transition (new rollout state) for an existing policy. */
  update(policy: StagedRoutingPolicy): void {
    this.register(policy);
  }

  all(): StagedRoutingPolicy[] {
    return [...this.byId.values()];
  }
}

// ---------------------------------------------------------------------------
// Telemetry -- recording decisions through the inference-event path
// ---------------------------------------------------------------------------

/** Sink for the InferenceEvent stream (Technical Architecture §9). */
export type RoutingTelemetrySink = {
  record(event: InferenceEvent): void | Promise<void>;
};

/**
 * Turn a routing decision into the InferenceEvent the telemetry path carries.
 * The decision's `reason` becomes `routeReason`, and the chosen target's
 * provider/model are recorded so downstream pricing and the savings ledger see
 * exactly where the request went.
 */
export function routingDecisionEvent(
  request: RouterRequest,
  decision: RoutingDecision,
  extra: {
    applicationId: string;
    timestamp: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    latencyMs?: number;
  },
): InferenceEvent {
  return {
    requestId: request.requestId,
    applicationId: extra.applicationId,
    taskClass: request.taskClass,
    provider: decision.target.provider,
    model: decision.target.model,
    inputTokens: extra.inputTokens,
    outputTokens: extra.outputTokens,
    costUsd: extra.costUsd,
    latencyMs: extra.latencyMs,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    routeReason: decision.reason,
    timestamp: extra.timestamp,
  };
}

/**
 * Convenience wiring for the data plane: load the policy for a request's task
 * class, route deterministically, and record the decision through the telemetry
 * sink. Returns the decision. When no policy is active the request still routes
 * to baseline (via a synthesised decision) and is still recorded, so every
 * served request produces one inference event.
 */
export class RoutingService {
  constructor(
    private readonly loader: PolicyLoader,
    private readonly sink: RoutingTelemetrySink,
    private readonly router: Router = new Router(),
  ) {}

  async route(
    request: RouterRequest,
    baseline: ModelTarget,
    telemetry: { applicationId: string; timestamp: string },
  ): Promise<RoutingDecision> {
    const policy = this.loader.load(request.taskClass);
    const decision: RoutingDecision = policy
      ? this.router.route(request, policy)
      : { target: baseline, reason: "no_active_policy", isBaseline: true };
    await this.sink.record(routingDecisionEvent(request, decision, telemetry));
    return decision;
  }
}
