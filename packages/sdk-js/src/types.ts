import type { LedgerGateVerdict } from "../../core/dist/src/savings-ledger.js";
import type { PriceCatalogue } from "../../core/dist/src/price-catalogue.js";
import type { MeshReductionSummary, MeshTokenReductionConfig } from "./reduce-request.js";
export type MeshTelemetryConfig = {
  /**
   * Where to POST usage metadata. Unset (the default) means telemetry is OFF
   * and nothing is ever sent anywhere. There is no mode that sends content:
   * events carry usage numbers and lever names, never prompts, and provider
   * error text is masked before send.
   */
  endpoint?: string;
};

export type MeshRequestEvent = {
  /** What reduction removed from this request, when reduction is configured. */
  reduction?: MeshReductionSummary;
  requestId: string;
  applicationId: string;
  provider: string;
  model: string;
  requestedModel?: string;
  taskClass?: string;
  workflow?: string;
  difficulty?: "low" | "medium" | "high";
  riskLevel?: "low" | "medium" | "high";
  contextProfileId?: string;
  contextProfileVersion?: string;
  routePolicyId?: string;
  routeReason?: string;
  estimatedCostSavingsPercent?: number;
  modelsAttempted?: string[];
  fallbackUsed?: boolean;
  fallbackReason?: "quality_rejected" | "quality_check_error" | "candidate_error" | "context_transform_unavailable" | "context_transform_error" | "context_profile_mismatch";
  qualityCheckPassed?: boolean;
  cacheHit?: boolean;
  tokensAvoided?: number;
  costAvoidedUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  uncachedInputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** Output-waste metering: re-emission of request context in the completion (tokens only, never billed). */
  outputDiagnostics?: {
    inspectedOutputTokens: number;
    reEmittedOutputTokens: number;
    reEmittedCodeTokens: number;
  };
  /** This request was byte-identical to an earlier one from the same app. */
  duplicateOfRequestId?: string;
  /**
   * Provider-reported TTL split of the cache writes (Anthropic
   * usage.cache_creation). Present as a PAIR only when the provider reported
   * the split; absent means unknown, and billing uses MESH's stamped TTL when
   * available (otherwise the 1h premium, dispute-safe), never assumes 5m.
   */
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
  costUsd?: number;
  /**
   * service_tier as reported on the final RESPONSE, never the requested one: a
   * flex request that 429s and falls back to standard bills standard and earns
   * zero tier savings. Absent when the provider reports none.
   */
  responseServiceTier?: string;
  /** Response service_tier per attempt, aligned with modelsAttempted; null where unreported. */
  attemptServiceTiers?: Array<string | null>;
  latencyMs: number;
  status: "succeeded" | "failed";
  error?: string;
  timestamp: string;
};

export type MeshRoutingEvidence = {
  baselineModel: string;
  candidateModel: string;
  eligibleForReview: boolean;
  sampleSize: number;
  candidateAccuracyLower95: number;
  accuracyDrop: number;
  baselineCostUsd: number;
  candidateCostUsd: number;
};

export type MeshRoutingCandidate = {
  model: string;
  /** Share of requests assigned to this candidate, from 0 to 1. */
  trafficShare: number;
  /** Explicit human approval after reviewing the offline replay report. */
  approved: boolean;
  evidence: MeshRoutingEvidence;
  /** Optional lower output-token cap for this candidate. The baseline request is unchanged on fallback. */
  maxOutputTokens?: number;
  /** Versioned deterministic context-reduction transform evaluated in replay. */
  contextProfileId?: string;
};

export type MeshRoutingPolicy = {
  id: string;
  taskClass: string;
  workflow?: string;
  difficulty?: "low" | "medium" | "high";
  riskLevel?: "low" | "medium" | "high";
  baselineModel: string;
  minimumSamples: number;
  minimumCandidateAccuracyLower95: number;
  maximumAccuracyDrop: number;
  candidates: MeshRoutingCandidate[];
};

export type MeshRoutingConfig = {
  policies: MeshRoutingPolicy[];
  /** Return a stable, non-sensitive key such as tenant/user or job ID. */
  getRequestKey: (request: unknown) => string | undefined;
};

export type MeshExactCacheConfig = {
  /** Maximum completed responses retained in this client process. */
  maxEntries: number;
  /** Cache entry lifetime in milliseconds. */
  ttlMs: number;
  /** Return an isolation scope such as tenant ID; returning undefined disables caching for that request. */
  getScopeKey: (request: unknown) => string | undefined;
};

export type MeshEvaluationCaptureAttempt = {
  model: string;
  contextProfileId?: string;
  maxOutputTokens?: number;
  request: unknown;
  response?: unknown;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  score?: number;
};

/** Content-bearing local evaluation record. Enable only with an explicit redactor. */
export type MeshEvaluationCaptureRecord = {
  schemaVersion: 1;
  id: string;
  caseId: string;
  /** Optional stable, non-sensitive group ID used to keep related prompts in one split. */
  groupId?: string;
  applicationId: string;
  requestedModel: string;
  finalModel: string;
  taskClass?: string;
  workflow?: string;
  difficulty?: "low" | "medium" | "high";
  riskLevel?: "low" | "medium" | "high";
  request: unknown;
  expected?: unknown;
  attempts: MeshEvaluationCaptureAttempt[];
  cacheHit?: boolean;
  routeReason?: string;
  status: "succeeded" | "failed";
  timestamp: string;
};

export type MeshEvaluationCaptureConfig = {
  /** Stable ID across deliberate replays of the same application test case. */
  getCaseId?: (request: unknown) => string | undefined;
  /** Optional stable group key, ideally a one-way hash of the normalized input. */
  getGroupId?: (request: unknown) => string | undefined;
  /** Optional trusted answer/label from a test fixture or application outcome. */
  getExpected?: (request: unknown) => unknown;
  /** Task-specific scorer returning a normalized value in [0, 1]. */
  score?: (expected: unknown, response: unknown, meta: { model: string; workflow?: string; taskClass?: string }) => number;
  /** Required privacy boundary: return a sanitized copy, or undefined to discard the record. */
  redact: (record: MeshEvaluationCaptureRecord) => MeshEvaluationCaptureRecord | undefined;
  /** Write sanitized records locally or to an explicitly chosen sink. */
  write: (record: MeshEvaluationCaptureRecord) => void | Promise<void>;
};

/**
 * Opt-in savings ledger: an append-only, hash-chained JSONL spool of billable
 * events, one per request, written synchronously from the event path. Off by
 * default; every write is wrapped so a full disk or bad path can never throw
 * into the request path. The spool is the billing source of truth a customer
 * recomputes themselves with `recomputeInvoice`.
 */
/**
 * Mirror appended ledger records to a Mesh metering API. When present, each
 * record is pushed fire-and-forget (with retry) to `${apiUrl}/v1/ledger/events`
 * AFTER the local append, authenticated by the Mesh account key. The push never
 * blocks or throws into the request path, and the local spool is always kept so
 * the customer can still recompute every figure themselves.
 *
 * The account key is NOT the provider API key — it only identifies the Mesh
 * account. The provider key never reaches the Mesh API.
 */
export type MeshLedgerMirrorConfig = {
  /** Mesh API base URL, e.g. https://www.mesh-technology.com. */
  apiUrl: string;
  /** Mesh account key (mesh_sk_…). */
  accountKey: string;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Retry attempts per flush before the batch waits for the next append. Default 3. */
  maxRetries?: number;
  /** Max unconfirmed records buffered before the mirror quietly stops (local spool is unaffected). Default 5000. */
  maxPending?: number;
};

export type MeshSavingsLedgerConfig = {
  /** Append-only JSONL file; parent directories are created on first write. */
  path: string;
  /** Optional mirror of each appended record to the Mesh metering API. */
  mirror?: MeshLedgerMirrorConfig;
  /** Provider key used to resolve rates in the catalogue. Default "openai". */
  provider?: string;
  /** Rates to pin event pricing against. Default: the published catalogue. */
  catalogue?: PriceCatalogue;
  /**
   * Replay-gate verdict reference per lossy lever id. A lossy lever's savings
   * bill only when its verdict here is "approved"; unknown lossy levers are
   * recorded and never billed.
   */
  gateVerdicts?: Record<string, LedgerGateVerdict>;
  /** Optional task correlation so a failed task's turns are excluded from the invoice. */
  getCorrelation?: (event: MeshRequestEvent) => { taskId?: string; turnIndex?: number } | undefined;
  /**
   * Optional measured counterfactual cost (standard tier, no levers) in USD for
   * this request, from a replay/counterfactual measurement path. Stored on the
   * event; the measured token-reduction delta bills only when it is present.
   */
  getBaselineUsd?: (event: MeshRequestEvent) => number | undefined;
};

export type MeshRequestContext = {
  taskClass?: string;
  workflow?: string;
  difficulty?: "low" | "medium" | "high";
  riskLevel?: "low" | "medium" | "high";
};

/** A deterministic, versioned context transformation that can be replayed before rollout. */
export type MeshContextProfile = {
  id: string;
  version: string;
  /** Optional guard; every supplied field must exactly match the request's trusted context. */
  match?: Partial<Pick<MeshRequestContext, "taskClass" | "workflow" | "difficulty" | "riskLevel">>;
  /** Transform synchronously to avoid adding another model call to the inference path. */
  transform: (request: unknown, context: MeshRequestContext) => unknown;
};

export type MeshOptions = {
  applicationId: string;
  pricing?: {
    inputPerMillion: number;
    cachedInputPerMillion?: number;
    cacheWriteInputPerMillion?: number;
    /** 1h-TTL cache writes bill at their own premium (Anthropic: 2x base input). */
    cacheWrite1hInputPerMillion?: number;
    outputPerMillion: number;
  };
  pricingByModel?: Record<string, {
    inputPerMillion: number;
    cachedInputPerMillion?: number;
    cacheWriteInputPerMillion?: number;
    /** 1h-TTL cache writes bill at their own premium (Anthropic: 2x base input). */
    cacheWrite1hInputPerMillion?: number;
    outputPerMillion: number;
  }>;
  telemetry?: MeshTelemetryConfig;
  classify?: (request: unknown) => string | undefined;
  getContext?: (request: unknown) => MeshRequestContext;
  /**
   * Token reduction applied to every request, independent of routing. Omit to
   * leave requests untouched.
   */
  tokenReduction?: MeshTokenReductionConfig;
  contextProfiles?: readonly MeshContextProfile[];
  /** @deprecated Use versioned contextProfiles for replayable context transformations. */
  contextTransforms?: Record<string, (request: unknown, context: MeshRequestContext) => unknown>;
  routing?: MeshRoutingConfig;
  /** Return false or throw to retry a routed candidate request on the baseline model. */
  qualityCheck?: (input: {
    request: unknown;
    response: unknown;
    taskClass?: string;
    context?: MeshRequestContext;
    candidateModel: string;
  }) => boolean | Promise<boolean>;
  /** Opt-in, in-memory exact response cache. Tool/conversation/streaming requests are bypassed. */
  exactCache?: MeshExactCacheConfig;
  /** Off by default. Captures request/response content only when explicitly configured. */
  evaluationCapture?: MeshEvaluationCaptureConfig;
  /** Off by default. Appends hash-chained billable events to a local JSONL spool. */
  ledger?: MeshSavingsLedgerConfig;
  onEvent?: (event: MeshRequestEvent) => void;
};
