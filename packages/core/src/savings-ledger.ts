import { createHash } from "node:crypto";
import {
  canonicalJson,
  catalogueVersion,
  priceUsage,
  resolveModelId,
  type PriceCatalogue,
} from "./price-catalogue.js";

/**
 * The savings ledger: the append-only record MESH bills from, and the pure
 * functions that turn it back into an invoice.
 *
 * MESH charges a percentage of VERIFIED savings, so the ledger is designed to
 * be recomputed by the customer, not trusted:
 *
 * - Every event carries the provider-verbatim token usage and the content hash
 *   of the price catalogue it was priced against. Anyone holding the same
 *   catalogue can re-derive every USD figure with zero tolerance.
 * - Events are hash-chained (seq, prevHash, eventHash), so a perturbed or
 *   removed event is detectable, and the exact position is named.
 * - `recomputeInvoice` is deterministic and idempotent by requestId: replaying
 *   the same spool twice, late, or shuffled yields a byte-identical invoice.
 * - Only verified components bill: price-mode deltas on actual tokens, MESH's
 *   own exact-cache avoidance at the originally measured cost, provider-cache
 *   economics on prefixes MESH itself placed, and lossy levers whose replay
 *   gate verdict is "approved". Savings the customer already had (provider
 *   cache on appended history they placed or got by default, gateway caches)
 *   are recorded for transparency and never billed. Token-reduction levers may
 *   bill from an estimated baseline anchored to provider-verbatim usage, and
 *   every such figure is labelled "estimated-baseline" on the lever and the
 *   invoice line item — an estimate is never passed off as a measurement.
 * - Negative components are netted, never clamped: a 1h cache-write surcharge
 *   that never earned its reads shows up AGAINST MESH on the invoice, and a
 *   net-non-positive period produces the "do_not_charge" verdict.
 */

export type LedgerExecutionMode = "standard" | "flex" | "batch";

export type LedgerLeverKind =
  /** Transform that cannot change the answer (schema compaction, dedupe). */
  | "lossless"
  /** Behaviour-changing lever; bills only with an approved replay-gate verdict. */
  | "lossy"
  /** Execution-tier price delta (flex/batch) on actual tokens. */
  | "tier"
  /** MESH's own exact response cache: a request never sent. */
  | "exact_cache"
  /** Provider prompt-cache economics on cache_control MESH itself placed. */
  | "provider_cache";

/** Reference to the replay-gate run that approved or rejected a lossy lever. */
export type LedgerGateVerdict = {
  ref: string;
  verdict: "approved" | "rejected";
};

export type LedgerLever = {
  leverId: string;
  kind: LedgerLeverKind;
  /**
   * Verified USD this lever saved on THIS request. MAY be negative (netted on
   * the invoice, never clamped). Omitted means the lever was applied but has no
   * per-request verified measurement; it is then recorded and never billed.
   */
  savedUsd?: number;
  /**
   * How savedUsd was derived. "measured" (the default when absent) means it
   * came entirely from provider-verbatim deltas. "estimated-baseline" means
   * the tokens this lever removed were counted BEFORE send by MESH's own
   * counter, anchored to the provider-verbatim input total by ratio, and
   * valued at this event's realized blended input rate — a conservative
   * under-claim on cache-heavy traffic, labelled as an estimate everywhere
   * it appears, including the invoice line item.
   */
  basis?: "measured" | "estimated-baseline";
  gateVerdict?: LedgerGateVerdict;
  detail?: string;
};

export type LedgerUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** TOTAL cache writes, inclusive of any TTL-split share below. */
  cacheWriteInputTokens: number;
  /**
   * Provider-reported TTL split of the cache writes, present as a PAIR only
   * when the provider reported one (Anthropic usage.cache_creation). The two
   * buckets must sum exactly to cacheWriteInputTokens or the event is unpriced.
   * Absent means the split is UNKNOWN: writes on a MESH-placed cache_control
   * use the TTL stamped by MESH when it is recorded (otherwise the 1h premium,
   * dispute-safe and counted against MESH), never assumed to be 5m writes.
   */
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
};

/** One append-only billable event, written once per completed request. */
export type BillableEvent = {
  schemaVersion: 1;
  /** End-to-end idempotency key; duplicates are ignored at invoice time. */
  requestId: string;
  applicationId: string;
  /** Correlation to a multi-turn task, so a failed task's turns can be excluded. */
  taskId?: string;
  turnIndex?: number;
  /** YYYY-MM, fixed from `timestamp` at write time so late replays land in the same period. */
  invoicePeriod: string;
  timestamp: string;
  provider: string;
  model: string;
  /** Taken from the provider RESPONSE (service_tier / batch), never the request. */
  executionMode: LedgerExecutionMode;
  pricingStatus: "priced" | "unpriced";
  pricingReason?: string;
  /** Content hash of the catalogue the USD figures were computed against. */
  catalogueVersion?: string;
  /** Provider-verbatim normalised token usage. */
  usage?: LedgerUsage;
  /** Catalogue-priced cost of this request at its actual execution mode. */
  actualUsd?: number;
  /** Measured counterfactual (standard tier, no levers), when a measurement path supplies one. */
  baselineUsd?: number;
  /** The caller's own pricing of the request, informational only. */
  reportedCostUsd?: number;
  levers: LedgerLever[];
  /**
   * Evidence behind any estimated-baseline lever on this event: MESH's own
   * pre-send token counts. Informational — the invoice never reads it; it
   * exists so an auditor can re-derive every estimated savedUsd from the
   * event alone (removedFraction = removed / before, baseline input =
   * usage.inputTokens / (1 - removedFraction), valued at actual input cost
   * divided by actual input tokens).
   */
  estimatedReduction?: {
    estimatedInputTokensBefore: number;
    estimatedInputTokensRemoved: number;
  };
  /**
   * Output-side waste metering (never billed, never mutated): how much of
   * this completion was verbatim re-emission of lines already in the request
   * context, and whether this request byte-duplicated an earlier one. Pure
   * diagnostics for the statement's waste view; token counts only.
   */
  outputDiagnostics?: {
    inspectedOutputTokens: number;
    reEmittedOutputTokens: number;
    reEmittedCodeTokens: number;
  };
  /** This request was byte-identical to an earlier one from the same app. */
  duplicateOfRequestId?: string;
  /** Savings the customer already had. Recorded for transparency, NEVER billed. */
  excluded?: {
    providerCacheAlreadyOwnedUsd?: number;
    gatewayCacheUsd?: number;
  };
  status: "succeeded" | "failed";
};

// ---------------------------------------------------------------------------
// Hash chain
// ---------------------------------------------------------------------------

export const LEDGER_GENESIS_HASH = "0".repeat(64);

export type LedgerRecord = {
  seq: number;
  prevHash: string;
  eventHash: string;
  event: BillableEvent;
};

/** Hash of one chained event; covers its position, its predecessor and its content. */
export function ledgerEventHash(seq: number, prevHash: string, event: BillableEvent): string {
  return createHash("sha256").update(`${seq}\n${prevHash}\n${canonicalJson(event)}`).digest("hex");
}

/** Chain one event onto the previous record (or onto genesis). */
export function chainLedgerRecord(event: BillableEvent, previous?: LedgerRecord): LedgerRecord {
  const seq = previous ? previous.seq + 1 : 0;
  const prevHash = previous ? previous.eventHash : LEDGER_GENESIS_HASH;
  return { seq, prevHash, eventHash: ledgerEventHash(seq, prevHash, event), event };
}

export type LedgerChainVerification =
  | { ok: true; length: number }
  | { ok: false; seq: number; reason: string };

/**
 * Verify a spool end to end. A perturbed usage field, a reordered record, or a
 * missing record is reported with the exact sequence number where the chain breaks.
 */
export function verifyLedgerChain(records: readonly LedgerRecord[]): LedgerChainVerification {
  let prevHash = LEDGER_GENESIS_HASH;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.seq !== index) {
      return { ok: false, seq: record.seq, reason: `Expected seq ${index}, found ${record.seq}.` };
    }
    if (record.prevHash !== prevHash) {
      return { ok: false, seq: record.seq, reason: "prevHash does not match the preceding record." };
    }
    const expected = ledgerEventHash(record.seq, record.prevHash, record.event);
    if (record.eventHash !== expected) {
      return { ok: false, seq: record.seq, reason: "eventHash does not match the event content." };
    }
    prevHash = record.eventHash;
  }
  return { ok: true, length: records.length };
}

// ---------------------------------------------------------------------------
// Pricing one event's usage against the catalogue
// ---------------------------------------------------------------------------

export type LedgerPricingInput = {
  provider: string;
  /** Raw API model identifier, resolved against the catalogue. */
  model: string;
  /** ISO calendar date the request was billed on. */
  at: string;
  executionMode: LedgerExecutionMode;
  usage: LedgerUsage;
  /**
   * True when MESH itself placed the cache_control (the cache-ttl lever applies
   * only when the caller had none), so the request's cache economics -- reads
   * at the cached rate MINUS the write surcharge -- attribute to MESH. False
   * means the customer already owned those economics; they are then excluded.
   */
  meshPlacedCacheControl: boolean;
  /**
   * The TTL MESH stamped, when meshPlacedCacheControl is true. Decides how an
   * ABSENT provider TTL split prices the writes: a "5m" stamp can only have
   * produced 5m writes (1.25x), while "1h" or unspecified prices every write
   * at the 1h premium (2x) — the dispute-safe reading for an hour-long stamp.
   */
  meshPlacedTtl?: "5m" | "1h";
};

export type LedgerPricing =
  | {
      pricingStatus: "priced";
      actualUsd: number;
      /** Input-side share of actualUsd (actual mode, cache usage included, output excluded). */
      inputUsd: number;
      /** Standard-mode minus actual-mode cost on the same tokens; set only when the mode differs. */
      tierSavedUsd?: number;
      /** Cache economics attributable to MESH; MAY be negative (write surcharge unearned by reads). */
      cacheAttributedUsd?: number;
      /** Cache economics the customer already had; informational, never billed. */
      providerCacheAlreadyOwnedUsd?: number;
    }
  | { pricingStatus: "unpriced"; reason: string };

/**
 * Decompose one request's catalogue cost into auditable parts:
 *
 *   actualUsd = fullRateStandardUsd - cacheDeltaUsd - tierSavedUsd
 *
 * where fullRateStandardUsd prices every input token at the standard full rate,
 * cacheDeltaUsd is what the prompt cache changed (negative when writes outweigh
 * reads), and tierSavedUsd is the flex/batch price delta on the actual tokens.
 * Unpriced is returned rather than zero whenever a needed rate is missing.
 */
export function priceLedgerUsage(catalogue: PriceCatalogue, input: LedgerPricingInput): LedgerPricing {
  const resolution = resolveModelId(catalogue, input.provider, input.model);
  if (resolution.status === "unresolved") {
    return { pricingStatus: "unpriced", reason: resolution.reason };
  }

  // The cache-write TTL split decides which write rate bills. The cases:
  // a reported split must sum exactly (a mismatched event is unpriced, never
  // repaired); an absent split on a MESH-placed 1h stamp prices EVERY write
  // at the 1h premium, because MESH stamped the 1h TTL and the benefit of the
  // doubt belongs to the customer (dispute-safe); an absent split on a
  // MESH-placed 5m stamp prices writes at the default 5m rate, because a 5m
  // stamp can only have produced 5m writes; an absent split on
  // customer-placed caching keeps the default write rate, exactly as before.
  const split5m = input.usage.cacheWrite5mInputTokens;
  const split1h = input.usage.cacheWrite1hInputTokens;
  const splitReported = split5m !== undefined || split1h !== undefined;
  if (splitReported && (split5m ?? 0) + (split1h ?? 0) !== input.usage.cacheWriteInputTokens) {
    return {
      pricingStatus: "unpriced",
      reason: `Cache-write TTL split (5m ${split5m ?? 0} + 1h ${split1h ?? 0}) does not sum to ` +
        `cacheWriteInputTokens ${input.usage.cacheWriteInputTokens}.`,
    };
  }
  const write1hForPricing = splitReported
    ? (split1h ?? 0)
    : input.meshPlacedCacheControl && input.meshPlacedTtl !== "5m"
      ? input.usage.cacheWriteInputTokens
      : 0;
  const pricingUsage = {
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cachedInputTokens: input.usage.cachedInputTokens,
    cacheWriteInputTokens: input.usage.cacheWriteInputTokens,
    cacheWrite1hInputTokens: write1hForPricing,
  };

  const query = { provider: input.provider, model: resolution.model, at: input.at };
  const actual = priceUsage(catalogue, { ...query, mode: input.executionMode }, pricingUsage);
  if (actual.status === "unpriced") return { pricingStatus: "unpriced", reason: actual.reason };
  const actualInputOnly = priceUsage(catalogue, { ...query, mode: input.executionMode }, {
    ...pricingUsage,
    outputTokens: 0,
  });
  if (actualInputOnly.status === "unpriced") {
    return { pricingStatus: "unpriced", reason: actualInputOnly.reason };
  }

  const standardWithCache = input.executionMode === "standard"
    ? actual
    : priceUsage(catalogue, { ...query, mode: "standard" }, pricingUsage);
  if (standardWithCache.status === "unpriced") {
    return { pricingStatus: "unpriced", reason: standardWithCache.reason };
  }

  const fullRateStandard = priceUsage(catalogue, { ...query, mode: "standard" }, {
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
  });
  if (fullRateStandard.status === "unpriced") {
    return { pricingStatus: "unpriced", reason: fullRateStandard.reason };
  }

  const cacheDeltaUsd = fullRateStandard.costUsd - standardWithCache.costUsd;
  const hasCacheTraffic = input.usage.cachedInputTokens > 0 || input.usage.cacheWriteInputTokens > 0;
  return {
    pricingStatus: "priced",
    actualUsd: actual.costUsd,
    inputUsd: actualInputOnly.costUsd,
    ...(input.executionMode === "standard"
      ? {}
      : { tierSavedUsd: standardWithCache.costUsd - actual.costUsd }),
    ...(hasCacheTraffic
      ? input.meshPlacedCacheControl
        ? { cacheAttributedUsd: cacheDeltaUsd }
        : { providerCacheAlreadyOwnedUsd: cacheDeltaUsd }
      : {}),
  };
}

export type LedgerPricingAudit =
  | { status: "verified" }
  | { status: "catalogue_version_mismatch"; eventVersion?: string; catalogueVersion: string }
  | { status: "unpriced"; reason: string }
  | { status: "mismatch"; field: "actualUsd"; storedUsd?: number; recomputedUsd: number };

/**
 * Recompute one event's stored cost from its provider-verbatim usage and the
 * given catalogue, with zero tolerance. The catalogue must be the exact version
 * the event was priced against; auditing against a bumped catalogue is reported
 * as a version mismatch rather than a false pricing error.
 */
export function auditEventPricing(event: BillableEvent, catalogue: PriceCatalogue): LedgerPricingAudit {
  const version = catalogueVersion(catalogue);
  if (event.catalogueVersion !== undefined && event.catalogueVersion !== version) {
    return { status: "catalogue_version_mismatch", eventVersion: event.catalogueVersion, catalogueVersion: version };
  }
  if (!event.usage) {
    return event.actualUsd === undefined
      ? { status: "verified" }
      : { status: "mismatch", field: "actualUsd", storedUsd: event.actualUsd, recomputedUsd: Number.NaN };
  }
  const cacheLever = event.levers.find((lever) => lever.kind === "provider_cache");
  const meshPlacedCacheControl = cacheLever !== undefined;
  const meshPlacedTtl = cacheLever?.leverId === "cache-ttl-5m"
    ? "5m"
    : cacheLever?.leverId === "cache-ttl-1h"
      ? "1h"
      : undefined;
  const priced = priceLedgerUsage(catalogue, {
    provider: event.provider,
    model: event.model,
    at: event.timestamp.slice(0, 10),
    executionMode: event.executionMode,
    usage: event.usage,
    meshPlacedCacheControl,
    ...(meshPlacedTtl === undefined ? {} : { meshPlacedTtl }),
  });
  if (priced.pricingStatus === "unpriced") {
    return event.pricingStatus === "unpriced"
      ? { status: "verified" }
      : { status: "unpriced", reason: priced.reason };
  }
  if (priced.actualUsd !== event.actualUsd) {
    return { status: "mismatch", field: "actualUsd", storedUsd: event.actualUsd, recomputedUsd: priced.actualUsd };
  }
  return { status: "verified" };
}

/**
 * The catalogue-derived input to {@link priceLedgerUsage} for one event: the
 * same derivation {@link auditEventPricing} uses, so a re-derivation prices an
 * event exactly the way it was priced when written.
 */
function pricingInputForEvent(event: BillableEvent): LedgerPricingInput | undefined {
  if (!event.usage) return undefined;
  const cacheLever = event.levers.find((lever) => lever.kind === "provider_cache");
  const meshPlacedCacheControl = cacheLever !== undefined;
  const meshPlacedTtl = cacheLever?.leverId === "cache-ttl-5m"
    ? "5m"
    : cacheLever?.leverId === "cache-ttl-1h"
      ? "1h"
      : undefined;
  return {
    provider: event.provider,
    model: event.model,
    at: event.timestamp.slice(0, 10),
    executionMode: event.executionMode,
    usage: event.usage,
    meshPlacedCacheControl,
    ...(meshPlacedTtl === undefined ? {} : { meshPlacedTtl }),
  };
}

/**
 * The catalogue-derived expected savedUsd for one lever, re-computed from the
 * event's provider-verbatim usage, or undefined when the lever's basis is not
 * deterministically derivable from usage × catalogue alone (exact_cache, and
 * the measured lossless/lossy levers, whose savings come from a measurement
 * path the usage does not by itself reconstruct — those are integrity-checked
 * via {@link auditEventPricing} but their stored figure is accepted).
 */
function expectedLeverSavedUsd(lever: LedgerLever, priced: LedgerPricing): number | undefined {
  if (priced.pricingStatus !== "priced") return undefined;
  switch (lever.kind) {
    case "tier":
      return priced.tierSavedUsd ?? 0;
    case "provider_cache":
      return priced.cacheAttributedUsd ?? 0;
    default:
      return undefined;
  }
}

export type SavingsReconciliation = {
  /** True when every re-derivable lever's stored savedUsd is within tolerance. */
  ok: boolean;
  /** Levers whose savedUsd could be re-derived and were therefore checked. */
  leversChecked: number;
  /** The largest amount by which a stored savedUsd EXCEEDED its re-derived value. */
  maxOverstatementUsd: number;
  /** The first failing lever's human-readable reason, when ok is false. */
  reason?: string;
};

/**
 * Server-side savings re-derivation — the guard that stops the invoice trusting
 * a stored `savedUsd` it cannot reproduce.
 *
 * At bill time we do NOT take the ledger's word for how much each lever saved.
 * For every lever whose savings are a deterministic function of the event's
 * provider-verbatim usage and the price catalogue (execution-tier deltas and
 * MESH-placed provider-cache economics), we re-derive the figure and reconcile
 * it against what is stored. A stored figure that EXCEEDS its re-derived value
 * by more than a tiny tolerance is an overstatement: the caller must withhold
 * the charge rather than bill the inflated amount. A stored figure at or below
 * the re-derived value is a conservative under-claim and is allowed.
 *
 * The event's own pricing integrity is checked first: a `usage`/`actualUsd`
 * that no longer prices to the stored cost (a tampered measurement) fails the
 * reconciliation outright. Levers priced against a different catalogue version,
 * or whose savings are not usage-derivable, are integrity-checked but their
 * stored figure is accepted (and counted separately so callers can see how much
 * of the bill was NOT independently re-derived).
 */
export function reconcileInvoiceSavings(
  events: readonly BillableEvent[],
  catalogue: PriceCatalogue,
  options: Pick<InvoiceOptions, "period" | "failedTaskIds" | "gateVerdictOverrides"> & { toleranceUsd?: number } = {},
): SavingsReconciliation {
  const tolerance = options.toleranceUsd ?? 1e-6;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error("toleranceUsd must be a non-negative, finite USD amount.");
  }
  const { billableEvents } = selectBillableEvents(events, options);

  let leversChecked = 0;
  let maxOverstatementUsd = 0;
  let reason: string | undefined;

  for (const event of billableEvents) {
    // Re-derivation needs provider-verbatim usage. An event carrying none is
    // outside this guard (its savings came from a measurement path usage does
    // not reconstruct); its stored figure is accepted and left to the event's
    // own pricingStatus, never flagged as fraud for being un-reconstructable.
    if (!event.usage) continue;

    // Integrity: a stored actualUsd that no longer prices from the stored usage
    // is a tampered measurement — fail before trusting any lever on the event.
    const audit = auditEventPricing(event, catalogue);
    if (audit.status === "mismatch") {
      return {
        ok: false,
        leversChecked,
        maxOverstatementUsd,
        reason: `event ${event.requestId}: stored actualUsd ${audit.storedUsd ?? "∅"} does not re-derive from usage (recomputed ${audit.recomputedUsd}).`,
      };
    }
    // A version mismatch or an unpriced recompute means we cannot re-derive
    // against THIS catalogue; the stored, version-pinned figure stands.
    if (audit.status !== "verified") continue;

    const pricingInput = pricingInputForEvent(event);
    const priced = pricingInput === undefined
      ? ({ pricingStatus: "unpriced", reason: "no usage" } as LedgerPricing)
      : priceLedgerUsage(catalogue, pricingInput);

    for (const lever of event.levers) {
      if (leverUnbilledReason(lever, options.gateVerdictOverrides) !== undefined) continue;
      const expected = expectedLeverSavedUsd(lever, priced);
      if (expected === undefined) continue; // not usage-derivable; accepted
      leversChecked += 1;
      const overstatement = lever.savedUsd! - expected;
      if (overstatement > maxOverstatementUsd) maxOverstatementUsd = overstatement;
      if (overstatement > tolerance && reason === undefined) {
        reason = `event ${event.requestId} lever ${lever.leverId}: stored savedUsd ${lever.savedUsd} exceeds re-derived ${expected} by ${overstatement.toFixed(6)}.`;
      }
    }
  }

  return { ok: reason === undefined, leversChecked, maxOverstatementUsd, ...(reason === undefined ? {} : { reason }) };
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

export type InvoiceOptions = {
  /** Restrict to one invoice period (YYYY-MM), matched against each event's own stamp. */
  period?: string;
  /**
   * Override gate verdicts by lever id WITHOUT mutating any event: flipping a
   * lever to "rejected" drops its savings from the invoice on the next recompute.
   */
  gateVerdictOverrides?: Record<string, "approved" | "rejected">;
  /** Tasks known to have failed quality out-of-band; all their turns' savings are excluded. */
  failedTaskIds?: readonly string[];
  /** MESH's contracted share of net verified savings, 0-100. Omitted: no fee line. */
  feePercent?: number;
  /**
   * Verified-savings deficit carried in from prior periods (the ESPC G.5
   * mechanic): a period that lost money does not just bill zero — its
   * deficit offsets future fees, so aggregate fees can never exceed
   * aggregate verified savings. Non-negative USD.
   */
  carryForwardDeficitUsd?: number;
};

export type InvoiceLineItem = {
  leverId: string;
  kind: LedgerLeverKind;
  events: number;
  savedUsd: number;
  savedCents: number;
  /** Present when ANY contributing lever's savedUsd was estimated-baseline rather than fully measured. */
  basis?: "estimated-baseline";
  gateVerdictRefs: string[];
};

export type InvoiceUnbilledItem = {
  leverId: string;
  kind: LedgerLeverKind;
  events: number;
  reason: string;
};

export type Invoice = {
  schemaVersion: 1;
  period: string | null;
  catalogueVersions: string[];
  eventsConsidered: number;
  eventsBilled: number;
  failedTaskIds: string[];
  eventsExcludedForFailedTasks: number;
  unpricedEvents: number;
  lineItems: InvoiceLineItem[];
  /** Levers that were applied but carry no billable per-request measurement. */
  recordedUnbilled: InvoiceUnbilledItem[];
  /** Savings the customer already had; shown so the exclusion is checkable, never billed. */
  excludedAlreadyOwned: {
    providerCacheOnAppendedHistoryUsd: number;
    gatewayCacheUsd: number;
  };
  /** Sum of billable components; negatives are netted, never clamped. */
  netVerifiedSavingsUsd: number;
  netVerifiedSavingsCents: number;
  /** Deficit applied from prior periods, when the option was supplied. */
  carryForwardDeficitInUsd?: number;
  /** Deficit to carry into the NEXT period (this period's shortfall after netting). */
  carryForwardDeficitOutUsd?: number;
  verdict: "charge" | "do_not_charge";
  feePercent?: number;
  amountDueUsd?: number;
  amountDueCents?: number;
};

function compareEvents(left: BillableEvent, right: BillableEvent): number {
  if (left.timestamp !== right.timestamp) return left.timestamp < right.timestamp ? -1 : 1;
  if (left.requestId !== right.requestId) return left.requestId < right.requestId ? -1 : 1;
  return 0;
}

/**
 * Why one lever's savings may NOT bill, or undefined when they may. The single
 * rule the invoice and every projection of it (for example the Stripe meter
 * sink) share, so no downstream artifact can ever bill a lever the invoice
 * would refuse: unmeasured levers never bill, and lossy levers bill only with
 * an approved replay-gate verdict.
 */
export function leverUnbilledReason(
  lever: LedgerLever,
  gateVerdictOverrides?: Record<string, "approved" | "rejected">,
): string | undefined {
  const verdict = gateVerdictOverrides?.[lever.leverId] ?? lever.gateVerdict?.verdict;
  if (lever.savedUsd === undefined || !Number.isFinite(lever.savedUsd)) {
    return "no per-request verified measurement";
  }
  if (lever.kind === "lossy" && verdict !== "approved") {
    return verdict === "rejected" ? "replay gate verdict rejected" : "no approved replay gate verdict";
  }
  return undefined;
}

/**
 * The shared selection pipeline: validate, sort, dedupe by requestId, filter
 * to one period, and void every turn of a failed task. Extracted so the
 * invoice and its projections apply IDENTICAL filters; recomputeInvoice's
 * output bytes are unchanged by the extraction.
 */
export function selectBillableEvents(
  events: readonly BillableEvent[],
  options: Pick<InvoiceOptions, "period" | "failedTaskIds"> = {},
): {
  /** Deduplicated events inside the period, before task-failure exclusion. */
  consideredEvents: BillableEvent[];
  /** Events whose levers may bill: succeeded, on no failed task. */
  billableEvents: BillableEvent[];
  failedTaskIds: Set<string>;
  eventsExcludedForFailedTasks: number;
  duplicatesIgnored: number;
} {
  for (const event of events) {
    if (event.schemaVersion !== 1) {
      throw new Error(`Unsupported billable event schemaVersion ${JSON.stringify((event as { schemaVersion: unknown }).schemaVersion)}.`);
    }
    if (typeof event.requestId !== "string" || event.requestId === "") {
      throw new Error("Billable events need a non-empty requestId idempotency key.");
    }
  }

  const sorted = [...events].sort(compareEvents);
  const seen = new Set<string>();
  let duplicatesIgnored = 0;
  const deduped: BillableEvent[] = [];
  for (const event of sorted) {
    if (seen.has(event.requestId)) {
      duplicatesIgnored += 1;
      continue;
    }
    seen.add(event.requestId);
    deduped.push(event);
  }

  const consideredEvents = options.period === undefined
    ? deduped
    : deduped.filter((event) => event.invoicePeriod === options.period);

  // Savings bill per COMPLETED task: one failed turn poisons the whole task,
  // including savings its earlier turns appeared to earn.
  const failedTaskIds = new Set<string>(options.failedTaskIds ?? []);
  for (const event of consideredEvents) {
    if (event.status === "failed" && event.taskId !== undefined) failedTaskIds.add(event.taskId);
  }
  let eventsExcludedForFailedTasks = 0;
  const billableEvents: BillableEvent[] = [];
  for (const event of consideredEvents) {
    const taskFailed = event.taskId !== undefined && failedTaskIds.has(event.taskId);
    if (taskFailed || event.status === "failed") {
      eventsExcludedForFailedTasks += 1;
      continue;
    }
    billableEvents.push(event);
  }
  return { consideredEvents, billableEvents, failedTaskIds, eventsExcludedForFailedTasks, duplicatesIgnored };
}

/**
 * Recompute the invoice from raw events. Pure and deterministic: events are
 * sorted and deduplicated by requestId before anything is summed, so the same
 * spool replayed twice, a day late, or shuffled produces byte-identical output.
 */
export type LedgerAudit = {
  /** Events dropped as requestId replays before anything was summed. */
  duplicatesIgnored: number;
};

/**
 * The canonical, customer-recomputable invoice. Deliberately does NOT include
 * replay metadata: whether a spool was transmitted once or three times must not
 * change a single byte of the billing artifact, or "recompute it yourself"
 * stops being a guarantee and becomes a dispute. Replay counts are audit
 * telemetry and come back separately from recomputeInvoiceWithAudit.
 */
export function recomputeInvoice(events: readonly BillableEvent[], options: InvoiceOptions = {}): Invoice {
  return recomputeInvoiceWithAudit(events, options).invoice;
}

export function recomputeInvoiceWithAudit(
  events: readonly BillableEvent[],
  options: InvoiceOptions = {},
): { invoice: Invoice; audit: LedgerAudit } {
  if (options.feePercent !== undefined &&
      (!Number.isFinite(options.feePercent) || options.feePercent < 0 || options.feePercent > 100)) {
    throw new Error("feePercent must be between 0 and 100.");
  }

  const {
    consideredEvents: inPeriod,
    billableEvents,
    failedTaskIds,
    eventsExcludedForFailedTasks,
    duplicatesIgnored,
  } = selectBillableEvents(events, options);

  const lineMap = new Map<string, { leverId: string; kind: LedgerLeverKind; events: number; savedUsd: number; estimated: boolean; refs: Set<string> }>();
  const unbilledMap = new Map<string, InvoiceUnbilledItem>();
  const catalogueVersions = new Set<string>();
  let unpricedEvents = 0;
  let providerCacheOnAppendedHistoryUsd = 0;
  let gatewayCacheUsd = 0;
  let eventsBilled = 0;

  for (const event of billableEvents) {
    if (event.catalogueVersion !== undefined) catalogueVersions.add(event.catalogueVersion);
    if (event.pricingStatus === "unpriced") unpricedEvents += 1;
    providerCacheOnAppendedHistoryUsd += event.excluded?.providerCacheAlreadyOwnedUsd ?? 0;
    gatewayCacheUsd += event.excluded?.gatewayCacheUsd ?? 0;
    let billedAny = false;
    for (const lever of event.levers) {
      const unbilledReason = leverUnbilledReason(lever, options.gateVerdictOverrides);
      if (unbilledReason !== undefined) {
        const key = `${lever.kind}\n${lever.leverId}\n${unbilledReason}`;
        const existing = unbilledMap.get(key);
        if (existing) existing.events += 1;
        else unbilledMap.set(key, { leverId: lever.leverId, kind: lever.kind, events: 1, reason: unbilledReason });
        continue;
      }
      const key = `${lever.kind}\n${lever.leverId}`;
      const line = lineMap.get(key) ?? { leverId: lever.leverId, kind: lever.kind, events: 0, savedUsd: 0, estimated: false, refs: new Set<string>() };
      line.events += 1;
      line.savedUsd += lever.savedUsd!;
      if (lever.basis === "estimated-baseline") line.estimated = true;
      if (lever.gateVerdict?.ref) line.refs.add(lever.gateVerdict.ref);
      lineMap.set(key, line);
      billedAny = true;
    }
    if (billedAny) eventsBilled += 1;
  }

  const lineItems: InvoiceLineItem[] = [...lineMap.values()]
    .sort((left, right) => (left.leverId < right.leverId ? -1 : left.leverId > right.leverId ? 1 : 0))
    .map((line) => ({
      leverId: line.leverId,
      kind: line.kind,
      events: line.events,
      savedUsd: line.savedUsd,
      savedCents: Math.round(line.savedUsd * 100),
      ...(line.estimated ? { basis: "estimated-baseline" as const } : {}),
      gateVerdictRefs: [...line.refs].sort(),
    }));
  const recordedUnbilled = [...unbilledMap.values()]
    .sort((left, right) => (left.leverId < right.leverId ? -1 : left.leverId > right.leverId ? 1 : 0));

  const netVerifiedSavingsUsd = lineItems.reduce((sum, line) => sum + line.savedUsd, 0);
  const netVerifiedSavingsCents = Math.round(netVerifiedSavingsUsd * 100);
  // Carry-forward netting (G.5 mechanic): the fee applies to this period's
  // net MINUS any deficit carried from prior periods, and a shortfall rolls
  // forward — aggregate fees can never exceed aggregate verified savings.
  const carryIn = options.carryForwardDeficitUsd ?? 0;
  if (carryIn < 0 || !Number.isFinite(carryIn)) {
    throw new Error("carryForwardDeficitUsd must be a non-negative, finite USD amount.");
  }
  const netAfterCarryUsd = netVerifiedSavingsUsd - carryIn;
  const carryOutUsd = Math.max(0, -netAfterCarryUsd);
  const billableCents = Math.round(netAfterCarryUsd * 100);
  const verdict: Invoice["verdict"] = billableCents > 0 ? "charge" : "do_not_charge";
  const amountDueUsd = options.feePercent === undefined
    ? undefined
    : verdict === "charge"
      ? (netAfterCarryUsd * options.feePercent) / 100
      : 0;

  const invoice: Invoice = {
    schemaVersion: 1,
    period: options.period ?? null,
    catalogueVersions: [...catalogueVersions].sort(),
    eventsConsidered: inPeriod.length,
    eventsBilled,
    failedTaskIds: [...failedTaskIds].sort(),
    eventsExcludedForFailedTasks,
    unpricedEvents,
    lineItems,
    recordedUnbilled,
    excludedAlreadyOwned: {
      providerCacheOnAppendedHistoryUsd,
      gatewayCacheUsd,
    },
    netVerifiedSavingsUsd,
    netVerifiedSavingsCents,
    ...(options.carryForwardDeficitUsd === undefined ? {} : { carryForwardDeficitInUsd: carryIn }),
    ...(carryOutUsd > 0 ? { carryForwardDeficitOutUsd: carryOutUsd } : {}),
    verdict,
    ...(options.feePercent === undefined ? {} : {
      feePercent: options.feePercent,
      amountDueUsd,
      amountDueCents: Math.round((amountDueUsd ?? 0) * 100),
    }),
  };
  return { invoice, audit: { duplicatesIgnored } };
}
