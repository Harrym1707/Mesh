export type ModelTarget = {
  provider: string;
  model: string;
};

export type QualityResult = {
  passed: boolean;
  score?: number;
  checks: Record<string, boolean | number | string>;
  reason?: string;
  /** Measured error rate (0..1) behind this result, checked against `maxErrorRate`. */
  errorRate?: number;
  /** Measured latency in ms behind this result, checked against `maxLatencyMs`. */
  latencyMs?: number;
};

export type QualityPolicy = {
  minimumScore?: number;
  requiredChecks?: string[];
  maxErrorRate?: number;
  maxLatencyMs?: number;
  /**
   * Minimum number of evaluation samples the quality measurement must rest on
   * before a candidate may take any traffic. A policy is never activated on one
   * or two examples (Technical Architecture §6). Defaults to
   * `DEFAULT_MINIMUM_SAMPLES` when omitted.
   */
  minimumSamples?: number;
};

export type RoutingCandidate = {
  target: ModelTarget;
  estimatedCostMultiplier: number;
  rolloutPercentage: number;
  qualityPolicy: QualityPolicy;
};

export type RoutingPolicy = {
  id: string;
  version: number;
  taskClass: string;
  baseline: ModelTarget;
  candidates: RoutingCandidate[];
  enabled: boolean;
};

export type RoutingDecision = {
  target: ModelTarget;
  reason: string;
  policyId?: string;
  policyVersion?: number;
  isBaseline: boolean;
};

export type InferenceEvent = {
  requestId: string;
  applicationId: string;
  taskClass?: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  policyId?: string;
  policyVersion?: number;
  routeReason?: string;
  timestamp: string;
};

export type EvaluationInput = {
  baseline: unknown;
  candidate: unknown;
  metadata?: Record<string, unknown>;
};

export type Evaluator = {
  name: string;
  evaluate(input: EvaluationInput): Promise<QualityResult>;
};

export type ReplayRecord = {
  id: string;
  expected: unknown;
  baseline: unknown;
  candidate: unknown;
  baselineCostUsd?: number;
  candidateCostUsd?: number;
  baselineError?: boolean;
  candidateError?: boolean;
};

export type ReplayInputCase = {
  id: string;
  expected: unknown;
  input: string;
  /** Candidate-side prompt/context after the configured reduction profile. */
  candidateInput?: string;
  mockOutputs?: {
    baseline: unknown;
    candidate: unknown;
    inputTokens: number;
    baselineOutputTokens: number;
    candidateOutputTokens: number;
  };
};

export type ReplayTarget = {
  provider: string;
  model: string;
  maxOutputTokens?: number;
  contextProfileId?: string;
  pricing?: {
    inputPerMillion: number;
    cachedInputPerMillion?: number;
    cacheWriteInputPerMillion?: number;
    outputPerMillion: number;
  };
};

export type ReplayInvocation = {
  output?: unknown;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  error?: string;
};

export type ReplayAdapter = {
  invoke(inputCase: ReplayInputCase, target: ReplayTarget): Promise<ReplayInvocation>;
};

export type ReplayPolicy = {
  evaluator: "exact_match" | "classification";
  minimumSamples: number;
  minimumCandidateAccuracy: number;
  maximumAccuracyDrop?: number;
  maximumCandidateErrorRate?: number;
  minimumCostSavingsPercent?: number;
};

export type ReplayGate = {
  name: string;
  passed: boolean;
  observed: number | null;
  required: number;
};

export type ReplayReport = {
  sampleSize: number;
  baselineAccuracy: number;
  candidateAccuracy: number;
  accuracyDrop: number;
  candidateAccuracyLower95: number;
  candidateErrorRate: number;
  baselineCostUsd: number | null;
  candidateCostUsd: number | null;
  costSavingsPercent: number | null;
  candidateFailureIds: string[];
  regressionIds: string[];
  improvementIds: string[];
  gates: ReplayGate[];
  eligibleForReview: boolean;
};
