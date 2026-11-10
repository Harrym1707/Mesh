export { serviceTierOf, withMesh } from "./openai.js";
export * from "./types.js";
export { chooseRoute } from "./routing.js";
export { ExactResponseCache } from "./exact-cache.js";
export { createLocalJsonlCapture } from "./evaluation-capture.js";
export { billableEventFromRequest, createSavingsLedger } from "./savings-ledger.js";
export type { SavingsLedger } from "./savings-ledger.js";
export { startMeshProxy, usageFromSse } from "./proxy.js";
export type { MeshProxy, MeshProxyOptions } from "./proxy.js";
// The customer-side audit surface: everything needed to verify a ledger spool
// and recompute the invoice locally, without the MESH workspace.
// The pre-contract quote pipeline, so the packaged mesh-quote CLI (and any
// design partner) can triage a gateway export without the MESH workspace.
export { buildQuoteReport, parseGatewayExport, renderQuoteReport } from "../../core/dist/src/index.js";
export type { QuoteExportFormat, QuoteReport, QuoteStreamReport } from "../../core/dist/src/index.js";
export {
  auditEventPricing,
  canonicalJson,
  catalogueVersion,
  chainLedgerRecord,
  ledgerEventHash,
  LEDGER_GENESIS_HASH,
  priceLedgerUsage,
  publishedModelPrices,
  recomputeInvoice,
  verifyLedgerChain,
} from "../../core/dist/src/index.js";
export type {
  BillableEvent,
  Invoice,
  InvoiceLineItem,
  InvoiceOptions,
  InvoiceUnbilledItem,
  LedgerChainVerification,
  LedgerExecutionMode,
  LedgerGateVerdict,
  LedgerLever,
  LedgerLeverKind,
  LedgerPricing,
  LedgerPricingAudit,
  LedgerPricingInput,
  LedgerRecord,
  LedgerUsage,
  PriceCatalogue,
} from "../../core/dist/src/index.js";
export { capToolResultBody, digestStaleBody, reduceRequest } from "./reduce-request.js";
export {
  wrapMesh,
  type WrapMeshOptions,
  type MeshSavingsSummary,
  type MeshHandle,
} from "./wrap.js";
export { extractBlindFeatures, type BlindFeatures } from "./blind-features.js";
export {
  policyToReductionConfig,
  leverToReductionConfig,
  withheldLevers,
  publishLever,
  defaultPolicy,
  knownLeverIds,
  routeMatches,
  isPolicyBundle,
  asBundle,
  policyForRoute,
  bundleToReductionConfig,
  upsertRoutePolicy,
  mergePolicyIntoBundle,
  type TheoPolicy,
  type TheoPolicyBundle,
  type TheoLever,
  type TheoGateProof,
  type TheoLeverClass,
  type WithheldLever,
} from "./theo-policy.js";
export {
  createTheoMemory,
  observeWorkload,
  renderTheoReport,
  runTheoCycle,
  type TheoAutonomyLevel,
  type TheoMemory,
  type TheoHypothesis,
  type TheoFrontierOpportunity,
  type TheoExperiment,
  type TheoProposal,
  type TheoObservation,
  type TheoProof,
  type TheoAction,
  type TheoCycleResult,
} from "./theo-agent.js";
export {
  defaultTheoMemoryPath,
  loadTheoMemory,
  saveTheoMemory,
  realisedFromSpoolDir,
} from "./theo-agent-store.js";
export {
  proveCandidates,
  type ProveCandidatesOptions,
  type ProveCandidatesResult,
} from "./theo-gate.js";
export { compactStaleContext, reduceRequestAsync } from "./semantic-compaction.js";
export type {
  SemanticCompactionConfig,
  SemanticCompactionResult,
  SemanticCompactor,
} from "./semantic-compaction.js";
export { CachePrefixVolatilityGuard, type CacheStampDecision } from "./cache-volatility-guard.js";
export { renderLedgerReport, type LedgerReportOptions, type LedgerReportSpool } from "./report.js";
export {
  MESH_SIGNUP_URL,
  formatSavingsCta,
  savingsBadge,
  savingsPercent,
  type SavingsBadge,
  type SavingsCtaOptions,
  type SavingsSnapshot,
} from "./cta.js";
export {
  savingsSnapshotFromEvents,
  savingsSnapshotFromSpoolDir,
} from "./savings-snapshot.js";
export type {
  MeshHistoryCompactionConfig,
  MeshReductionChange,
  MeshReductionSummary,
  MeshTokenReductionConfig,
} from "./reduce-request.js";
export {
  exactTextGrader,
  replayGate,
  replayUsage,
  responseText,
  responseToolCalls,
  toolNameGrader,
  toolSelectionGrader,
} from "./replay-gate.js";
export type {
  ReplayCandidate,
  ReplayCandidateResult,
  ReplayComparison,
  ReplayGateOptions,
  ReplayGateResult,
  ReplayGrader,
  ReplayUsage,
  ToolCall,
} from "./replay-gate.js";
export {
  agentGrader,
  compositeGrader,
  textSimilarityGrader,
  truncationAwareGrader,
} from "./graders.js";
export type { TruncationOptions, WeightedGrader } from "./graders.js";
