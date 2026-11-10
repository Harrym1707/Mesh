// Mesh Token Engineering Lab — structured types.
//
// The Lab is an INTERNAL autonomous R&D team that continuously researches,
// tests and promotes new ways to reduce token usage in Mesh/Theo itself. It is
// distinct from Theo, who optimises Mesh's configuration inside a customer's
// environment. Every type here is content-blind by construction: an experiment
// may only ever declare blind-feature inputs (see BlindFeatureKind), never raw
// customer prompts, responses or source.

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/** Where an optimisation sits in the research portfolio. */
export type OptimisationCategory =
  | "compaction"
  | "deduplication"
  | "cache-placement"
  | "routing"
  | "output-caps"
  | "rag-efficiency"
  | "other";

/**
 * Research-effort buckets. The lab spends 50% on core, 30% on adjacent, 20% on
 * exploratory (docs/rnd/rnd-doctrine.md — the three verticals, re-cast for the
 * internal lab's own research allocation).
 */
export type ResearchBucket = "core" | "adjacent" | "exploratory";

/**
 * The traffic shape a lever targets (docs/rnd/rnd-doctrine.md's three
 * verticals, in priority order). Always-on and autonomous agents are where the
 * compounding token spend sits — re-sent growing history, tool schemas, stale
 * tool results — so the lab weights discovery toward them over one-shot prompts.
 */
export type WorkloadShape = "always-on-agent" | "autonomous-agent" | "one-shot";

/**
 * The Mesh control surfaces an optimisation is permitted to act on. Anything
 * that would rewrite or restructure the CUSTOMER's application is not a valid
 * control surface and is rejected by the Research agent.
 */
export type ControlSurface =
  | "context-compaction"
  | "deduplication"
  | "cache-placement"
  | "model-tier-routing"
  | "output-caps"
  | "other-proxy-side";

/**
 * The only inputs an experiment may read. Mesh's privacy architecture is
 * load-bearing: optimisation works through irreversible blind features,
 * aggregated telemetry and the optimisation ledger — never raw content.
 */
export type BlindFeatureKind =
  | "keyed-prefix-hash"
  | "structural-counts"
  | "token-counts"
  | "aggregated-telemetry"
  | "optimisation-ledger"
  | "inter-arrival-timing"
  | "model-id"
  | "route-id";

/** Inputs that are forbidden — their presence fails the content-blind gate. */
export type ForbiddenInput =
  | "raw-prompt"
  | "raw-response"
  | "source-code"
  | "customer-pii"
  | "decrypted-content";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * The lifecycle of an optimisation idea. `status` names the stage the record is
 * currently resting at / queued for; the orchestrator maps each non-terminal
 * status to exactly one responsible agent (see lab/orchestrator.ts).
 *
 *   discovered  -> Research  -> designed | rejected
 *   designed    -> Design    -> building
 *   building    -> Builder   -> red_team
 *   red_team    -> RedTeam   -> evaluating | failed
 *   evaluating  -> Evaluation-> maintaining
 *   maintaining -> Maintainer-> promoted | failed | inconclusive
 *
 * Terminal: rejected, promoted, failed, inconclusive.
 */
export type LeadStatus =
  | "discovered"
  | "researching"
  | "rejected"
  | "designed"
  | "building"
  | "red_team"
  | "evaluating"
  | "maintaining"
  | "promoted"
  | "failed"
  | "inconclusive";

export const TERMINAL_STATUSES: readonly LeadStatus[] = [
  "rejected",
  "promoted",
  "failed",
  "inconclusive",
];

export function isTerminal(status: LeadStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Stage artifacts
// ---------------------------------------------------------------------------

/** A discovery produced by a Scout. */
export type OptimisationLead = {
  title: string;
  description: string;
  category: OptimisationCategory;
  bucket: ResearchBucket;
  /** Stable key used for duplicate / failed-experiment awareness. */
  techniqueKey: string;
  source: {
    kind: string;
    reference: string;
    discoveredBy: string;
    discoveredAt: string;
  };
  hypothesis: string;
  /** Which traffic vertical this lever targets. Defaults to one-shot. */
  shape?: WorkloadShape;
  controlSurface: ControlSurface;
  featureInputs: BlindFeatureKind[];
  /** Declared forbidden inputs, if any — a non-empty list fails research. */
  declaredForbiddenInputs?: ForbiddenInput[];
  /** Whether the idea would require changing the customer's own application. */
  changesCustomerApplication: boolean;
  expectedTokenReductionPercent: number;
  /** Registry technique id, if a runnable implementation exists. */
  techniqueId?: string;
  defaultParams?: Record<string, unknown>;
  /** Fixture the experiment will be measured against, if any. */
  datasetFixtureId?: string;
};

/** Research agent output — the six-criteria compatibility assessment. */
export type CompatibilityAssessment = {
  contentBlind: boolean;
  meshSideOnly: boolean;
  avoidsCustomerAppChanges: boolean;
  objectivelyTestable: boolean;
  meaningfulSaving: boolean;
  acceptableRisk: boolean;
  notes: string[];
  verdict: "validated" | "rejected";
  rejectionReasons: string[];
};

/** Quality gates an experiment must clear. Strict by default. */
export type QualityGates = {
  /** Max permitted quality degradation (accuracy drop). Default 0.02 (2%). */
  maxQualityDegradation: number;
  minimumSamples: number;
  minimumCostSavingsPercent: number;
  /**
   * One-sided 95% Wilson lower bound the candidate accuracy must clear. This is
   * a sample-size sanity floor (small n cannot prove high accuracy), separate
   * from the 2% drop ceiling that enforces the actual quality guarantee.
   */
  minimumCandidateAccuracy: number;
  evaluator: "exact_match" | "classification";
};

/** Design agent output — the smallest experiment that tests the hypothesis. */
export type ExperimentSpec = {
  hypothesis: string;
  proposedOptimisation: string;
  expectedTokenReductionPercent: number;
  expectedCostReductionPercent: number;
  risks: string[];
  requiredTests: string[];
  qualityGates: QualityGates;
  successCriteria: string[];
  failureCriteria: string[];
  rollbackCriteria: string[];
  /** The smallest viable implementation: a registry technique + params. */
  implementation: { techniqueId?: string; params: Record<string, unknown> };
  datasetFixtureId?: string;
};

/** Builder agent output — an isolated implementation artifact. */
export type BuildArtifact = {
  workspaceDir: string;
  techniqueId?: string;
  runnable: boolean;
  params: Record<string, unknown>;
  implementationNotes: string[];
  /** Path to the replay dataset the builder produced (if runnable). */
  datasetPath?: string;
  decisionsLog: string[];
};

export type RedTeamFinding = {
  severity: "critical" | "major" | "minor";
  category:
    | "hidden-quality"
    | "privacy"
    | "token-increase"
    | "reliability"
    | "invalid-assumption"
    | "content-blind-violation"
    | "regression";
  description: string;
  evidence: string;
  resolved: boolean;
};

export type RedTeamReport = {
  findings: RedTeamFinding[];
  unresolvedCritical: number;
  verdict: "clear" | "blocked";
};

export type StageMetrics = {
  tokens: number;
  costUsd: number;
  accuracy: number;
};

/** Evaluation agent output — independent measurement vs the baseline. */
export type EvaluationResult = {
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  baseline: StageMetrics;
  candidate: StageMetrics;
  tokenReductionPercent: number;
  costReductionPercent: number;
  /** accuracy(baseline) - accuracy(candidate); negative means candidate better. */
  qualityDelta: number;
  latencyDeltaMs: number | null;
  reliability: { candidateErrorRate: number };
  gates: { name: string; passed: boolean; observed: number | null; required: number }[];
  reasons: string[];
};

/** Maintainer agent output — the final promotion decision. */
export type PromotionDecision = {
  decision: "PROMOTED" | "REJECTED";
  checkedGates: { name: string; passed: boolean; detail: string }[];
  reason: string;
  reversible: boolean;
  codeLinks: string[];
  decidedAt: string;
};

// ---------------------------------------------------------------------------
// The ledger record (one optimisation's full lifecycle)
// ---------------------------------------------------------------------------

export type StatusChange = {
  at: string;
  from: LeadStatus | null;
  to: LeadStatus;
  by: string;
  note: string;
};

export type OptimisationRecord = {
  id: string;
  title: string;
  description: string;
  category: OptimisationCategory;
  bucket: ResearchBucket;
  status: LeadStatus;
  /** Duplicate / failed-experiment awareness key. */
  fingerprint: string;
  techniqueKey: string;
  source: OptimisationLead["source"];
  hypothesis: string;

  lead?: OptimisationLead;
  compatibility?: CompatibilityAssessment;
  spec?: ExperimentSpec;
  build?: BuildArtifact;
  redTeam?: RedTeamReport;
  evaluation?: EvaluationResult;
  promotion?: PromotionDecision;

  expectedSavingPercent?: number;
  actualSavingPercent?: number;
  qualityImpact?: number;

  finalDecision?: string;
  decisionReason?: string;
  codeLinks: string[];

  createdAt: string;
  updatedAt: string;
  history: StatusChange[];
};

// ---------------------------------------------------------------------------
// The hash-chained event log (append-only audit trail)
// ---------------------------------------------------------------------------

export type LedgerEvent = {
  at: string;
  recordId: string;
  actor: string;
  type:
    | "discovered"
    | "status-change"
    | "assessment"
    | "spec"
    | "build"
    | "red-team"
    | "evaluation"
    | "promotion"
    | "note";
  from?: LeadStatus | null;
  to?: LeadStatus;
  detail: Record<string, unknown>;
};

export type LedgerEventRecord = {
  seq: number;
  prevHash: string;
  eventHash: string;
  event: LedgerEvent;
};

// ---------------------------------------------------------------------------
// Portfolio of promoted levers (the live, self-documenting set)
// ---------------------------------------------------------------------------

export type PromotedLever = {
  id: string;
  title: string;
  category: OptimisationCategory;
  controlSurface: ControlSurface;
  techniqueId?: string;
  params: Record<string, unknown>;
  measuredTokenReductionPercent: number;
  measuredCostReductionPercent: number;
  measuredQualityDelta: number;
  promotedAt: string;
  /** Why it is on — the evidence that justified promotion. */
  justification: string;
  codeLinks: string[];
};
