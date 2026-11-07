import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { catalogueVersion, type PriceCatalogue } from "../../core/dist/src/price-catalogue.js";
import { publishedModelPrices } from "../../core/dist/src/model-prices.js";
import {
  chainLedgerRecord,
  priceLedgerUsage,
  type BillableEvent,
  type LedgerExecutionMode,
  type LedgerLever,
  type LedgerRecord,
  type LedgerUsage,
} from "../../core/dist/src/savings-ledger.js";
import type { MeshRequestEvent, MeshSavingsLedgerConfig } from "./types.js";
import { LedgerMirror } from "./ledger-mirror.js";

/**
 * The opt-in savings meter: turns each MeshRequestEvent into one append-only
 * BillableEvent and writes it as a hash-chained JSONL record.
 *
 * Honesty properties, enforced here rather than promised:
 * - Every USD figure on an event is recomputable from what the event itself
 *   carries: provider-verbatim usage plus the pinned catalogue version for
 *   measured figures, plus the recorded `estimatedReduction` counts for
 *   estimated-baseline ones. An estimate is always labelled (`basis`) on the
 *   lever and on the invoice line item, never passed off as a measurement.
 * - executionMode comes from the RESPONSE service_tier, never the requested
 *   one, so a flex request that fell back to standard earns zero tier savings.
 * - Provider-cache economics bill only on cache_control MESH itself placed
 *   (the cache-ttl lever applies only when the caller had none); a customer's
 *   own cache discounts land in `excluded`, visible and never billed. The
 *   attributed figure MAY be negative: a 1h write surcharge with no reads to
 *   earn it counts against MESH on the invoice.
 * - Token-reduction levers bill from the estimated baseline above when no
 *   measured counterfactual (`getBaselineUsd`) is supplied — lossless levers
 *   unconditionally, lossy levers only with an approved replay-gate verdict.
 *   A supplied measured counterfactual replaces the estimate entirely.
 * - Writes are synchronous (the record exists before the caller sees the
 *   response) and totally silent on failure: a bad path, full disk, or corrupt
 *   tail disables the meter rather than ever throwing into the request path.
 */

const EXECUTION_TIER_LEVERS = new Set(["execution-tier-flex"]);
const CACHE_TTL_LEVERS = new Map<string, "5m" | "1h">([["cache-ttl-5m", "5m"], ["cache-ttl-1h", "1h"]]);
const MEASURED_COMPOSITE_LEVER = "token-reduction-measured";
const EXACT_CACHE_LEVER = "exact-response-cache";

function executionModeOf(responseServiceTier: string | undefined): LedgerExecutionMode {
  if (responseServiceTier === "flex") return "flex";
  if (responseServiceTier === "batch") return "batch";
  return "standard";
}

function usageOf(event: MeshRequestEvent): LedgerUsage | undefined {
  const { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens } = event;
  if ([inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens]
    .some((count) => typeof count !== "number" || !Number.isFinite(count) || count < 0)) {
    return undefined;
  }
  // The TTL split is recorded verbatim when the provider reported one; pricing
  // sum-checks it (a mismatched event is unpriced) and an ABSENT split on a
  // MESH-placed cache_control prices every write at the stamped TTL's premium
  // (1h stamp: 2x on every write, dispute-safe; 5m stamp: the 5m rate).
  const validCount = (count: unknown): count is number =>
    typeof count === "number" && Number.isFinite(count) && count >= 0;
  const splitReported = event.cacheWrite5mInputTokens !== undefined || event.cacheWrite1hInputTokens !== undefined;
  const splitValid = splitReported &&
    validCount(event.cacheWrite5mInputTokens ?? 0) && validCount(event.cacheWrite1hInputTokens ?? 0);
  if (splitReported && !splitValid) return undefined;
  return {
    inputTokens: inputTokens!,
    outputTokens: outputTokens!,
    cachedInputTokens: cachedInputTokens!,
    cacheWriteInputTokens: cacheWriteInputTokens!,
    ...(splitValid
      ? {
          cacheWrite5mInputTokens: event.cacheWrite5mInputTokens ?? 0,
          cacheWrite1hInputTokens: event.cacheWrite1hInputTokens ?? 0,
        }
      : {}),
  };
}

/** Build the append-only billable record for one completed request. Pure. */
export function billableEventFromRequest(
  event: MeshRequestEvent,
  config: MeshSavingsLedgerConfig,
  catalogue: PriceCatalogue,
  pinnedCatalogueVersion: string,
): BillableEvent {
  const provider = config.provider ?? "openai";
  const changes = event.reduction && !event.reduction.skipped ? event.reduction.changes : [];
  const ttlChange = changes.find((change) => CACHE_TTL_LEVERS.has(change.lever));
  const meshPlacedCacheControl = ttlChange !== undefined;
  const meshPlacedTtl = ttlChange === undefined ? undefined : CACHE_TTL_LEVERS.get(ttlChange.lever);
  const executionMode = executionModeOf(event.responseServiceTier);
  const usage = usageOf(event);

  const pricing = usage === undefined
    ? { pricingStatus: "unpriced" as const, reason: "The event carries no complete, valid provider-verbatim usage." }
    : priceLedgerUsage(catalogue, {
        provider,
        model: event.model,
        at: event.timestamp.slice(0, 10),
        executionMode,
        usage,
        meshPlacedCacheControl,
        ...(meshPlacedTtl === undefined ? {} : { meshPlacedTtl }),
      });
  const priced = pricing.pricingStatus === "priced" ? pricing : undefined;

  const levers: LedgerLever[] = [];
  const excluded: NonNullable<BillableEvent["excluded"]> = {};

  // MESH's own exact response cache: the measured cost of the request never sent.
  if (event.cacheHit) {
    levers.push({
      leverId: EXACT_CACHE_LEVER,
      kind: "exact_cache",
      ...(event.costAvoidedUsd === undefined ? {} : { savedUsd: event.costAvoidedUsd }),
    });
  }

  // Execution-tier price delta on actual tokens, from the RESPONSE mode.
  if (priced?.tierSavedUsd !== undefined) {
    levers.push({
      leverId: `execution-tier-${executionMode}`,
      kind: "tier",
      savedUsd: priced.tierSavedUsd,
    });
  }

  // Provider-cache economics on cache_control MESH itself placed; may be negative.
  if (priced?.cacheAttributedUsd !== undefined && ttlChange !== undefined) {
    levers.push({
      leverId: ttlChange.lever,
      kind: "provider_cache",
      savedUsd: priced.cacheAttributedUsd,
    });
  }
  if (priced?.providerCacheAlreadyOwnedUsd !== undefined) {
    excluded.providerCacheAlreadyOwnedUsd = priced.providerCacheAlreadyOwnedUsd;
  }

  // A customer-supplied measured counterfactual takes precedence over the
  // estimated path below: when it exists, token savings bill through the
  // measured composite and the per-change levers stay record-only, so the
  // same removed tokens can never bill twice.
  let baselineUsd: number | undefined;
  try {
    const supplied = config.getBaselineUsd?.(event);
    if (typeof supplied === "number" && Number.isFinite(supplied) && supplied >= 0) baselineUsd = supplied;
  } catch {
    baselineUsd = undefined;
  }

  // Token-reduction changes bill from an ESTIMATED baseline anchored to
  // provider-verbatim usage: MESH's own counter gives the fraction of the
  // request it removed before send; the provider's input total is what
  // actually remained, so baseline input = actual / (1 - fraction). Saved
  // tokens are valued at this event's realized blended input rate (actual
  // input cost / actual input tokens) — an under-claim whenever the removed
  // tokens would have billed fresh while the surviving prompt is largely
  // cached, which is the dispute-safe direction. An implausible fraction
  // (>= 0.95) voids the estimate and the levers stay record-only.
  const tokenChanges = changes.filter((change) =>
    !EXECUTION_TIER_LEVERS.has(change.lever) &&
    !(CACHE_TTL_LEVERS.has(change.lever) && priced?.cacheAttributedUsd !== undefined));
  const summary = event.reduction && !event.reduction.skipped ? event.reduction : undefined;
  const estimatedBefore = summary?.estimatedTokensBefore ?? 0;
  const estimatedRemoved = tokenChanges.reduce((sum, change) =>
    sum + (Number.isFinite(change.estimatedTokensSaved) && change.estimatedTokensSaved > 0
      ? change.estimatedTokensSaved
      : 0), 0);
  const removedFraction = estimatedBefore > 0 ? estimatedRemoved / estimatedBefore : 0;
  const estimateUsable = baselineUsd === undefined && priced !== undefined && usage !== undefined &&
    usage.inputTokens > 0 && estimatedRemoved > 0 && removedFraction > 0 && removedFraction < 0.95;
  const estimatedSavedUsdTotal = estimateUsable
    ? (usage!.inputTokens / (1 - removedFraction) - usage!.inputTokens) * (priced!.inputUsd / usage!.inputTokens)
    : 0;
  for (const change of tokenChanges) {
    const share = estimateUsable && change.estimatedTokensSaved > 0
      ? estimatedSavedUsdTotal * (change.estimatedTokensSaved / estimatedRemoved)
      : undefined;
    levers.push({
      leverId: change.lever,
      kind: change.lossless ? "lossless" : "lossy",
      ...(share === undefined ? {} : { savedUsd: share, basis: "estimated-baseline" as const }),
      ...(config.gateVerdicts?.[change.lever] === undefined
        ? {}
        : { gateVerdict: config.gateVerdicts[change.lever] }),
    });
  }
  // A flex stamp the response did not honour is recorded, unbilled, so the
  // 429-fallback case is visible on the spool rather than silently absent.
  for (const change of changes) {
    if (EXECUTION_TIER_LEVERS.has(change.lever) && priced?.tierSavedUsd === undefined) {
      levers.push({ leverId: change.lever, kind: "lossless" });
    }
  }

  // Rate levers (tier, cache TTL) bill through their own priced components
  // above; the measured composite covers only the token-removing changes.
  const measuredTokenChanges = changes.filter((change) =>
    !EXECUTION_TIER_LEVERS.has(change.lever) && !CACHE_TTL_LEVERS.has(change.lever));
  if (baselineUsd !== undefined && priced !== undefined && measuredTokenChanges.length > 0) {
    const lossy = measuredTokenChanges.filter((change) => !change.lossless);
    const verdicts = lossy.map((change) => config.gateVerdicts?.[change.lever]);
    const allApproved = verdicts.every((verdict) => verdict?.verdict === "approved");
    const savedUsd = baselineUsd - priced.actualUsd - (priced.tierSavedUsd ?? 0) - (priced.cacheAttributedUsd ?? 0);
    levers.push({
      leverId: MEASURED_COMPOSITE_LEVER,
      kind: lossy.length > 0 ? "lossy" : "lossless",
      savedUsd,
      ...(lossy.length > 0 && allApproved
        ? {
            gateVerdict: {
              ref: verdicts.map((verdict) => verdict!.ref).sort().join("+"),
              verdict: "approved" as const,
            },
          }
        : {}),
      detail: "baselineUsd minus actual catalogue cost, net of tier and cache components",
    });
  }

  let correlation: { taskId?: string; turnIndex?: number } | undefined;
  try {
    correlation = config.getCorrelation?.(event);
  } catch {
    correlation = undefined;
  }

  return {
    schemaVersion: 1,
    requestId: event.requestId,
    applicationId: event.applicationId,
    ...(correlation?.taskId === undefined ? {} : { taskId: correlation.taskId }),
    ...(correlation?.turnIndex === undefined ? {} : { turnIndex: correlation.turnIndex }),
    invoicePeriod: event.timestamp.slice(0, 7),
    timestamp: event.timestamp,
    provider,
    model: event.model,
    executionMode,
    pricingStatus: pricing.pricingStatus,
    ...(pricing.pricingStatus === "unpriced" ? { pricingReason: pricing.reason } : {}),
    catalogueVersion: pinnedCatalogueVersion,
    ...(usage === undefined ? {} : { usage }),
    ...(priced === undefined ? {} : { actualUsd: priced.actualUsd }),
    ...(baselineUsd === undefined ? {} : { baselineUsd }),
    ...(event.costUsd === undefined ? {} : { reportedCostUsd: event.costUsd }),
    levers,
    ...(estimateUsable
      ? {
          estimatedReduction: {
            estimatedInputTokensBefore: estimatedBefore,
            estimatedInputTokensRemoved: estimatedRemoved,
          },
        }
      : {}),
    ...(Object.keys(excluded).length === 0 ? {} : { excluded }),
    ...(event.outputDiagnostics === undefined ? {} : { outputDiagnostics: event.outputDiagnostics }),
    ...(event.duplicateOfRequestId === undefined ? {} : { duplicateOfRequestId: event.duplicateOfRequestId }),
    status: event.status,
  };
}

export type SavingsLedger = {
  /** Synchronously appends one chained record. Never throws. */
  emit: (event: MeshRequestEvent) => void;
  readonly path: string;
};

function resumeChainTail(path: string): { previous?: LedgerRecord; disabled: boolean } {
  try {
    if (!existsSync(path)) return { disabled: false };
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) return { disabled: false };
    const tail = JSON.parse(lines[lines.length - 1]!) as LedgerRecord;
    if (typeof tail.seq !== "number" || typeof tail.eventHash !== "string") return { disabled: true };
    return { previous: tail, disabled: false };
  } catch {
    // A spool whose tail cannot be read must not be extended with a broken
    // chain; the meter goes quiet instead of corrupting the billing record.
    return { disabled: true };
  }
}

/** Create the opt-in JSONL savings meter. Construction never throws on I/O. */
export function createSavingsLedger(config: MeshSavingsLedgerConfig): SavingsLedger {
  if (typeof config.path !== "string" || config.path.trim() === "") {
    throw new Error("The savings ledger needs a file path for its append-only JSONL spool.");
  }
  const catalogue = config.catalogue ?? publishedModelPrices;
  const pinnedCatalogueVersion = catalogueVersion(catalogue);
  const tail = resumeChainTail(config.path);
  let previous = tail.previous;
  let disabled = tail.disabled;
  // Optional mirror to the Mesh metering API; best-effort and fully detached
  // from the request path. The local spool above stays authoritative.
  const mirror = config.mirror ? new LedgerMirror(config.mirror) : undefined;

  return {
    path: config.path,
    emit(event: MeshRequestEvent): void {
      if (disabled) return;
      try {
        const billable = billableEventFromRequest(event, config, catalogue, pinnedCatalogueVersion);
        const record = chainLedgerRecord(billable, previous);
        mkdirSync(dirname(config.path), { recursive: true, mode: 0o700 });
        appendFileSync(config.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
        previous = record;
        // Only mirror AFTER the authoritative local append succeeds.
        mirror?.enqueue(record);
      } catch {
        // The meter must never throw into the request path; a failed append
        // disables it so the on-disk chain stays internally consistent.
        disabled = true;
      }
    },
  };
}
