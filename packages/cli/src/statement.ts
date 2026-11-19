/**
 * `mesh statement` — the customer's own statement for one billing period.
 *
 * It reads the same ledger `mesh verify` reads, verifies every spool's hash
 * chain, and recomputes the period with the SAME pure functions the bill uses
 * (scripts/mesh-bill.ts): `verifyLedgerChain` → `recomputeInvoice` →
 * `buildStripeInvoicePlan`, at the same fee rate. Nothing here re-implements
 * the billing arithmetic: every billed figure is read off the recomputed
 * invoice, and the verdict is the bill's own decision.
 *
 * A statement is NOT an invoice. MESH issues the invoice separately, from the
 * same ledger; if the customer's recomputation disagrees with ours, theirs wins.
 *
 * The shareable file carries numbers, lever names, model ids and hashes only.
 * Request ids, application ids, task ids, free-text reasons and anything else
 * a ledger event may carry are never copied into it (see statement.test.ts).
 * No network calls.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Direct module imports, not the package barrels (see start.ts).
import { DEFAULT_FEE_PERCENT } from "../../core/src/accounts.js";
import { publishedModelPrices } from "../../core/src/model-prices.js";
import { canonicalJson, catalogueVersion } from "../../core/src/price-catalogue.js";
import {
  auditEventPricing,
  recomputeInvoice,
  selectBillableEvents,
  verifyLedgerChain,
  type BillableEvent,
  type LedgerRecord,
} from "../../core/src/savings-ledger.js";
import { buildStripeInvoicePlan } from "../../core/src/stripe-billing.js";
import { VERSION } from "./diag.js";
import { BUILD_COMMIT, MESH_HOME } from "./start.js";

export const STATEMENT_SCHEMA = "mesh-statement/1";

export const STATEMENT_NOTICE =
  "This is a statement of verified savings that you can recompute from your own ledger. " +
  "It is not an invoice: MESH issues the invoice separately, from this same ledger. " +
  "If your recomputation disagrees with ours, yours wins.";

export const PERIOD_RULE =
  "A request belongs to the period stamped on its ledger event (invoicePeriod), which is the " +
  "UTC calendar month of the time the request started. The bill selects events by the same stamp.";

/**
 * buildStripeInvoicePlan needs a customer id to describe a charge. A statement
 * charges nobody; only the plan's decision (bill or not, the amount, the
 * reason) is read, never this id.
 */
const PLAN_PREVIEW_CUSTOMER = "cus_statement_preview";

const USAGE = `Usage: mesh statement --period YYYY-MM [options] [spool.jsonl ...]

Print your statement for one billing period, recomputed from your own ledger,
and write it to a file you can share with MESH. It is a statement you can
recompute, not an invoice: the invoice is issued separately, and if your
recomputation disagrees with ours, yours wins.

  --period YYYY-MM   The billing period: a calendar month in UTC. Required.
  --ledger <dir>     Ledger directory to read. Default ~/.mesh/ledger.
  --out <file>       Where to write the statement file.
                     Default ./mesh-statement-YYYY-MM.json.
  --json             Print the statement as JSON instead of text.
  --check <file>     Check that a statement file has not been edited since it
                     was written (its sha256 seal), then exit.
  --help             Show this message.

Pass spool files to read exactly those instead of a ledger directory.
Amounts are US dollars. The file holds numbers, lever names, model ids and
hashes only: no prompts, no request content, no keys. No network calls.`;

// ---------------------------------------------------------------------------
// Reading spools
// ---------------------------------------------------------------------------

export type SpoolInput = {
  /** File name only. Shown on screen, never written to the statement file. */
  name: string;
  records: LedgerRecord[];
  /** 1-based line number of the first line that is not a readable ledger record, if any. */
  unreadableLine?: number;
};

/** Parse one spool. A line that is not a ledger record makes the spool unverifiable, as it stops the bill. */
export function parseSpool(name: string, text: string): SpoolInput {
  const records: LedgerRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { name, records, unreadableLine: index + 1 };
    }
    const event = (parsed as { event?: unknown } | null)?.event;
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return { name, records, unreadableLine: index + 1 };
    }
    records.push(parsed as LedgerRecord);
  }
  return { name, records };
}

/** The spools `mesh verify` reads: every .jsonl in the ledger directory except the feature spools. */
export function listSpools(ledgerDir: string): string[] {
  if (!existsSync(ledgerDir)) return [];
  return readdirSync(ledgerDir)
    .filter((file) => file.endsWith(".jsonl") && !file.endsWith(".features.jsonl"))
    .sort()
    .map((file) => join(ledgerDir, file));
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_VERSION = /^[0-9a-f]{8,64}$/;
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const WITHHELD = "(withheld)";

/**
 * The allow-list gate. The only strings copied from a ledger event into a
 * statement are provider names, model ids, lever names, hashes and timestamps,
 * and each must look like one: anything else (spaces, quotes, a path, prose)
 * is withheld rather than shared.
 */
function plainId(value: unknown): string {
  return typeof value === "string" && PLAIN_ID.test(value) ? value : WITHHELD;
}
function hash64(value: unknown): string {
  return typeof value === "string" && HEX_64.test(value) ? value : WITHHELD;
}
function isoTime(value: unknown): string {
  return typeof value === "string" && ISO_TIME.test(value) ? value : WITHHELD;
}

export type StatementSpool = {
  /** Records in the spool, all periods. */
  records: number;
  recordsInPeriod: number;
  chainVerified: boolean;
  /** Where and why the chain stops verifying. Fixed wording, never event content. */
  brokenAtSeq?: number;
  brokenReason?: string;
  /** Sequence number and hash of the spool's last record. */
  headSeq?: number;
  headHash?: string;
  firstPeriodEventHash?: string;
  lastPeriodEventHash?: string;
};

export type StatementLedger = {
  chainVerified: boolean;
  spools: StatementSpool[];
  records: number;
  recordsInPeriod: number;
  /** sha256 over the sorted hashes of every record in the period: names exactly the events counted. */
  periodEventsDigest: string;
  firstPeriodEventAt?: string;
  lastPeriodEventAt?: string;
};

export type StatementLever = {
  lever: string;
  kind: string;
  /** Requests this lever fired on and was billed for. */
  requests: number;
  savedUsd: number;
  /** Present when the saving is anchored to an estimated baseline rather than fully measured. */
  basis?: "estimated-baseline";
};

export type StatementBody = {
  schema: typeof STATEMENT_SCHEMA;
  kind: "statement";
  notice: string;
  generatedAt: string;
  mesh: { version: string; build: string };
  period: {
    id: string;
    timezone: "UTC";
    startsAt: string;
    endsBefore: string;
    /** False while the period is still running: the figures can still change. */
    closed: boolean;
    rule: string;
  };
  currency: "USD";
  validForBilling: true;
  ledger: StatementLedger;
  requests: {
    inPeriod: number;
    /** Records repeating a request already counted (all periods); ignored before anything is summed. */
    duplicatesIgnored: number;
    excludedFailedTask: number;
    /** Not priced, so no cost and no saving is claimed for them. Never priced at zero. */
    unpriced: number;
    unpricedByModel: { provider: string; model: string; requests: number }[];
    /** Requests carrying a saving you already had before MESH; that saving is not counted. */
    withSavingsAlreadyYours: number;
    withBilledSaving: number;
  };
  levers: StatementLever[];
  /** Levers that ran but are not billed, and why. */
  recordedNotBilled: { lever: string; kind: string; requests: number; reason: string }[];
  alreadyYoursUsd: { providerCache: number; gatewayCache: number };
  totals: {
    /** Actual cost plus net verified savings: what the priced requests would have cost without them. */
    baselineCostUsd: number;
    /** Price-list cost of the period's priced requests, from the provider's own reported usage. */
    actualCostUsd: number;
    netVerifiedSavingsUsd: number;
    netVerifiedSavingsCents: number;
  };
  fee: {
    ratePercent: number;
    /** The fee as billed: whole cents. Zero whenever the verdict is do_not_charge. */
    amountUsd: number;
    amountCents: number;
    /**
     * The recompute's fee before rounding to cents. Zero when the recompute
     * itself says do_not_charge (net savings that round to zero cents or less).
     */
    unroundedUsd: number;
  };
  /** What the bill does with this period: the plan's decision, not a separate rule. */
  verdict: "charge" | "do_not_charge";
  /** The invoice recompute's own verdict, before the fee is rounded to whole cents. */
  recomputeVerdict: "charge" | "do_not_charge";
  verdictReason?: string;
  /** A shortfall this period that offsets fees in later periods. Zero when there is none. */
  deficitCarriedForwardUsd: number;
  priceCatalogue: {
    /** Catalogue hashes the period's events were priced against when written. */
    ledgerVersions: string[];
    thisBuildVersion: string;
    /** Most recent date a published price in this build's catalogue was captured. */
    thisBuildCapturedOn: string;
    matchesThisBuild: boolean;
    /** Each billable event's stored cost re-derived from its usage with this build's catalogue. */
    repricing: { matched: number; differentCatalogue: number; mismatched: number };
  };
};

export type Statement = StatementBody & { sha256: string; sha256Of: string };

export type StatementResult =
  | { valid: true; statement: Statement; spoolNames: string[] }
  | { valid: false; period: string; ledger: StatementLedger; spoolNames: string[]; reason: string };

export const SEAL_RULE = "sha256 of this document as canonical JSON (keys sorted, no whitespace) without the sha256 and sha256Of fields";

/** The seal over a statement's content. */
export function statementSeal(body: Record<string, unknown>): string {
  const { sha256: _sha256, sha256Of: _sha256Of, ...content } = body;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

/** True when a statement file's content still matches its seal. */
export function checkStatementSeal(document: unknown): boolean {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return false;
  const record = document as Record<string, unknown>;
  return typeof record.sha256 === "string" && record.sha256 === statementSeal(record);
}

export function isPeriod(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function periodBounds(period: string): { startsAt: string; endsBefore: string } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return {
    startsAt: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    endsBefore: new Date(Date.UTC(year, month, 1)).toISOString(),
  };
}

function ledgerSection(spools: readonly SpoolInput[], period: string): StatementLedger {
  const periodHashes: string[] = [];
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  const sections = spools.map((spool): StatementSpool => {
    // The bill verifies each spool on its own (scripts/mesh-bill.ts); so does this.
    const chain = spool.unreadableLine === undefined
      ? verifyLedgerChain(spool.records)
      : { ok: false as const, seq: spool.records.length, reason: `Line ${spool.unreadableLine} is not a readable ledger record.` };
    const inPeriod = spool.records.filter((record) => record.event.invoicePeriod === period);
    for (const record of inPeriod) {
      periodHashes.push(hash64(record.eventHash));
      const at = isoTime(record.event.timestamp);
      if (at === WITHHELD) continue;
      if (firstAt === undefined || at < firstAt) firstAt = at;
      if (lastAt === undefined || at > lastAt) lastAt = at;
    }
    const head = spool.records.at(-1);
    return {
      records: spool.records.length,
      recordsInPeriod: inPeriod.length,
      chainVerified: chain.ok,
      ...(chain.ok ? {} : { brokenAtSeq: chain.seq, brokenReason: chain.reason }),
      ...(head === undefined ? {} : { headSeq: Number(head.seq), headHash: hash64(head.eventHash) }),
      ...(inPeriod.length === 0 ? {} : {
        firstPeriodEventHash: hash64(inPeriod[0]!.eventHash),
        lastPeriodEventHash: hash64(inPeriod.at(-1)!.eventHash),
      }),
    };
  });
  return {
    chainVerified: sections.every((section) => section.chainVerified),
    spools: sections,
    records: sections.reduce((sum, section) => sum + section.records, 0),
    recordsInPeriod: sections.reduce((sum, section) => sum + section.recordsInPeriod, 0),
    periodEventsDigest: createHash("sha256").update([...periodHashes].sort().join("\n")).digest("hex"),
    ...(firstAt === undefined ? {} : { firstPeriodEventAt: firstAt }),
    ...(lastAt === undefined ? {} : { lastPeriodEventAt: lastAt }),
  };
}

export type BuildStatementInput = {
  spools: readonly SpoolInput[];
  period: string;
  /** Injected so a test can pin it; defaults to the clock. */
  now?: Date;
  version?: string;
  build?: string;
};

/**
 * Build the statement for one period. Pure apart from the default clock.
 *
 * A ledger whose chain does not verify yields no figures at all: a statement
 * over an unverifiable ledger is not valid for billing, and the bill refuses
 * the same ledger.
 */
export function buildStatement(input: BuildStatementInput): StatementResult {
  const { spools, period } = input;
  if (!isPeriod(period)) throw new Error("--period must be a calendar month written YYYY-MM, for example 2026-11.");
  const spoolNames = spools.map((spool) => spool.name);
  const ledger = ledgerSection(spools, period);
  if (!ledger.chainVerified) {
    return {
      valid: false,
      period,
      ledger,
      spoolNames,
      reason: "The ledger's hash chain does not verify, so this statement is not valid for billing.",
    };
  }

  // The bill's own sequence (scripts/mesh-bill.ts): every spool's events into
  // one recompute for the period at the contracted fee, then the plan.
  const events: BillableEvent[] = spools.flatMap((spool) => spool.records.map((record) => record.event));
  const invoice = recomputeInvoice(events, { period, feePercent: DEFAULT_FEE_PERCENT });
  const plan = buildStripeInvoicePlan(invoice, true, { stripeCustomerId: PLAN_PREVIEW_CUSTOMER });

  // Descriptive counts only, from the selection the invoice itself applies.
  const selection = selectBillableEvents(events, { period });
  const unpriced = new Map<string, { provider: string; model: string; requests: number }>();
  let withSavingsAlreadyYours = 0;
  const repricing = { matched: 0, differentCatalogue: 0, mismatched: 0 };
  for (const event of selection.billableEvents) {
    if (event.pricingStatus === "unpriced") {
      const provider = plainId(event.provider);
      const model = plainId(event.model);
      const key = `${provider}\n${model}`;
      const row = unpriced.get(key) ?? { provider, model, requests: 0 };
      row.requests += 1;
      unpriced.set(key, row);
    }
    if ((event.excluded?.providerCacheAlreadyOwnedUsd ?? 0) !== 0 || (event.excluded?.gatewayCacheUsd ?? 0) !== 0) {
      withSavingsAlreadyYours += 1;
    }
    const audit = auditEventPricing(event, publishedModelPrices);
    if (audit.status === "verified") repricing.matched += 1;
    else if (audit.status === "catalogue_version_mismatch") repricing.differentCatalogue += 1;
    else repricing.mismatched += 1;
  }
  const actualCostUsd = selection.consideredEvents.reduce(
    (sum, event) => sum + (event.pricingStatus === "priced" && Number.isFinite(event.actualUsd) ? event.actualUsd! : 0),
    0,
  );

  const now = input.now ?? new Date();
  const bounds = periodBounds(period);
  const thisBuildVersion = catalogueVersion(publishedModelPrices);
  const ledgerVersions = invoice.catalogueVersions.map((version) =>
    (HEX_VERSION.test(version) ? version : WITHHELD));
  const charge = plan.action === "bill";
  // The reason is the bill's own sentence, with one correction: for savings
  // above zero that round to zero cents the plan says they "were not positive".
  // They were; they are too small to bill. Say that instead.
  const net = invoice.netVerifiedSavingsUsd;
  const verdictReason = charge
    ? undefined
    : net > 0 && invoice.verdict === "do_not_charge" && (invoice.carryForwardDeficitOutUsd ?? 0) === 0
      ? `net verified savings of ${usd(net)} round to zero cents, so nothing is billed.`
      : plan.reason.replace(/^do_not_charge:\s*/, "");

  const body: StatementBody = {
    schema: STATEMENT_SCHEMA,
    kind: "statement",
    notice: STATEMENT_NOTICE,
    generatedAt: now.toISOString(),
    mesh: { version: input.version ?? VERSION, build: input.build ?? BUILD_COMMIT },
    period: {
      id: period,
      timezone: "UTC",
      startsAt: bounds.startsAt,
      endsBefore: bounds.endsBefore,
      closed: now.toISOString() >= bounds.endsBefore,
      rule: PERIOD_RULE,
    },
    currency: "USD",
    validForBilling: true,
    ledger,
    requests: {
      inPeriod: invoice.eventsConsidered,
      duplicatesIgnored: selection.duplicatesIgnored,
      excludedFailedTask: invoice.eventsExcludedForFailedTasks,
      unpriced: invoice.unpricedEvents,
      unpricedByModel: [...unpriced.values()].sort((left, right) =>
        (`${left.provider}/${left.model}` < `${right.provider}/${right.model}` ? -1 : 1)),
      withSavingsAlreadyYours,
      withBilledSaving: invoice.eventsBilled,
    },
    levers: invoice.lineItems.map((line) => ({
      lever: plainId(line.leverId),
      kind: line.kind,
      requests: line.events,
      savedUsd: line.savedUsd,
      ...(line.basis === undefined ? {} : { basis: line.basis }),
    })),
    recordedNotBilled: invoice.recordedUnbilled.map((item) => ({
      lever: plainId(item.leverId),
      kind: item.kind,
      requests: item.events,
      reason: item.reason,
    })),
    alreadyYoursUsd: {
      providerCache: invoice.excludedAlreadyOwned.providerCacheOnAppendedHistoryUsd,
      gatewayCache: invoice.excludedAlreadyOwned.gatewayCacheUsd,
    },
    totals: {
      baselineCostUsd: actualCostUsd + invoice.netVerifiedSavingsUsd,
      actualCostUsd,
      netVerifiedSavingsUsd: invoice.netVerifiedSavingsUsd,
      netVerifiedSavingsCents: invoice.netVerifiedSavingsCents,
    },
    fee: {
      ratePercent: invoice.feePercent ?? DEFAULT_FEE_PERCENT,
      amountUsd: charge ? plan.amountCents / 100 : 0,
      amountCents: charge ? plan.amountCents : 0,
      unroundedUsd: invoice.amountDueUsd ?? 0,
    },
    verdict: charge ? "charge" : "do_not_charge",
    recomputeVerdict: invoice.verdict,
    ...(verdictReason === undefined ? {} : { verdictReason }),
    deficitCarriedForwardUsd: invoice.carryForwardDeficitOutUsd ?? 0,
    priceCatalogue: {
      ledgerVersions,
      thisBuildVersion,
      thisBuildCapturedOn: publishedModelPrices.entries.reduce(
        (latest, entry) => (entry.provenance.capturedOn > latest ? entry.provenance.capturedOn : latest),
        "",
      ),
      matchesThisBuild: ledgerVersions.every((version) => version === thisBuildVersion),
      repricing,
    },
  };
  return { valid: true, statement: { ...body, sha256Of: SEAL_RULE, sha256: statementSeal(body) }, spoolNames };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** US dollars, labelled, to four places: ledger amounts are often fractions of a cent. */
export function usd(amount: number, places = 4): string {
  const text = Math.abs(amount).toFixed(places);
  return `${amount < 0 && Number(text) !== 0 ? "-" : ""}US$${text}`;
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

function ledgerLines(ledger: StatementLedger, spoolNames: readonly string[]): string[] {
  const lines: string[] = [];
  lines.push("  LEDGER");
  lines.push(
    ledger.chainVerified
      ? `    ✓ hash chain verified: ${plural(ledger.spools.length, "spool")}, ${plural(ledger.records, "record")}, ${ledger.recordsInPeriod} in this period`
      : `    ✗ HASH CHAIN BROKEN: ${plural(ledger.spools.length, "spool")}, ${plural(ledger.records, "record")}`,
  );
  ledger.spools.forEach((spool, index) => {
    lines.push(`    spool ${index + 1}  ${spoolNames[index] ?? ""}  (${plural(spool.records, "record")}, ${spool.recordsInPeriod} in this period)`);
    if (!spool.chainVerified) {
      // No hashes for a spool that does not verify: they would vouch for nothing.
      lines.push(`      ✗ broken at seq ${spool.brokenAtSeq}: ${spool.brokenReason}`);
      return;
    }
    if (spool.headHash !== undefined) lines.push(`      head hash (seq ${spool.headSeq})`.padEnd(34) + spool.headHash);
    if (spool.firstPeriodEventHash !== undefined) {
      lines.push("      first event in period".padEnd(34) + spool.firstPeriodEventHash);
      lines.push("      last event in period".padEnd(34) + spool.lastPeriodEventHash);
    }
  });
  if (ledger.firstPeriodEventAt !== undefined) {
    lines.push("    first and last request".padEnd(34) + `${ledger.firstPeriodEventAt} to ${ledger.lastPeriodEventAt}`);
  }
  lines.push("    digest of period events".padEnd(34) + ledger.periodEventsDigest);
  return lines;
}

/** The statement as plain text. `spoolNames` are for the screen only. */
export function renderStatement(statement: Statement, spoolNames: readonly string[] = []): string {
  const s = statement;
  const row = (label: string, value: string, note = ""): string =>
    `    ${label.padEnd(42)}${value}${note === "" ? "" : `  ${note}`}`;
  const lines: string[] = [];
  lines.push("");
  lines.push(`  mesh statement — period ${s.period.id}`);
  lines.push(`  MESH ${s.mesh.version} (build ${s.mesh.build}) · generated ${s.generatedAt}`);
  lines.push("");
  lines.push("  This is a statement you can recompute from your own ledger. It is not an");
  lines.push("  invoice: MESH issues the invoice separately, from this same ledger. If your");
  lines.push("  recomputation disagrees with ours, yours wins.");
  lines.push("");
  lines.push(`  Period   ${s.period.id}: ${s.period.startsAt} up to, not including, ${s.period.endsBefore} (UTC).`);
  lines.push("           A request counts in the UTC calendar month it started in.");
  if (!s.period.closed) {
    lines.push("           THIS PERIOD HAS NOT ENDED YET: these figures can still change.");
  }
  lines.push("  Amounts  US dollars (USD).");
  lines.push("");
  lines.push(...ledgerLines(s.ledger, spoolNames));
  lines.push("");
  lines.push("  REQUESTS");
  lines.push(row("Requests in this period", String(s.requests.inPeriod)));
  if (s.requests.duplicatesIgnored > 0) {
    lines.push(row("Repeated records ignored", String(s.requests.duplicatesIgnored), "(the same request recorded twice counts once)"));
  }
  lines.push(row("Excluded: part of a failed task", String(s.requests.excludedFailedTask), "(savings on failed work are never billed)"));
  lines.push(row("Excluded: model not in the price list", String(s.requests.unpriced), "(not priced, so no saving is claimed)"));
  for (const item of s.requests.unpricedByModel) {
    lines.push(`        ${item.provider}/${item.model}: ${plural(item.requests, "request")}`);
  }
  const alreadyYours = s.alreadyYoursUsd.providerCache + s.alreadyYoursUsd.gatewayCache;
  lines.push(row(
    "Savings you already had, not counted",
    usd(alreadyYours),
    `(your own caching, on ${plural(s.requests.withSavingsAlreadyYours, "request")})`,
  ));
  lines.push(row("Requests with a billed saving", String(s.requests.withBilledSaving)));
  lines.push("");
  lines.push("  VERIFIED SAVINGS BY LEVER");
  if (s.levers.length === 0) {
    lines.push("    No lever produced a billable saving in this period.");
  } else {
    lines.push(`    ${"Lever".padEnd(30)}${"Kind".padEnd(16)}${"Requests".padStart(8)}  ${"Verified saving".padStart(16)}`);
    for (const lever of s.levers) {
      lines.push(
        `    ${lever.lever.padEnd(30)}${lever.kind.padEnd(16)}${String(lever.requests).padStart(8)}  ${usd(lever.savedUsd).padStart(16)}` +
        `${lever.basis === "estimated-baseline" ? "  (estimated baseline)" : ""}`,
      );
    }
    if (s.levers.some((lever) => lever.savedUsd < 0)) {
      lines.push("    A negative row is a lever that cost more than it saved. It counts against MESH.");
    }
  }
  if (s.recordedNotBilled.length > 0) {
    lines.push("    Recorded but not billed:");
    for (const item of s.recordedNotBilled) {
      lines.push(`    ${item.lever.padEnd(30)}${item.kind.padEnd(16)}${String(item.requests).padStart(8)}  ${item.reason}`);
    }
  }
  lines.push("");
  lines.push("  TOTALS");
  lines.push(row("Baseline cost (without these savings)", usd(s.totals.baselineCostUsd)));
  lines.push(row("Actual cost", usd(s.totals.actualCostUsd), "(priced requests, from your provider's reported usage)"));
  lines.push(row("Net verified savings", usd(s.totals.netVerifiedSavingsUsd)));
  lines.push(row(
    `Fee at ${s.fee.ratePercent}% of net verified savings`,
    usd(s.fee.amountUsd, 2),
    s.fee.unroundedUsd > 0
      ? `(${plural(s.fee.amountCents, "cent")}; ${usd(s.fee.unroundedUsd, 6)} before rounding to the nearest cent)`
      : `(${plural(s.fee.amountCents, "cent")})`,
  ));
  lines.push(row("Verdict", s.verdict));
  if (s.verdictReason !== undefined) lines.push(`      ${s.verdictReason}`);
  if (s.deficitCarriedForwardUsd > 0) {
    lines.push(row("Deficit carried forward", usd(s.deficitCarriedForwardUsd), "(offsets fees in later periods)"));
  }
  lines.push("    Amounts are shown rounded; totals are worked out from the unrounded figures,");
  lines.push("    which are in the statement file.");
  lines.push("");
  lines.push("  PRICE LIST");
  lines.push(row(
    "Catalogue the ledger was priced against",
    s.priceCatalogue.ledgerVersions.length === 0 ? "none recorded" : s.priceCatalogue.ledgerVersions.join(", "),
  ));
  lines.push(row(
    "Catalogue in this build",
    s.priceCatalogue.thisBuildVersion,
    `(prices captured up to ${s.priceCatalogue.thisBuildCapturedOn})`,
  ));
  const r = s.priceCatalogue.repricing;
  const repriceNotes = [
    ...(r.differentCatalogue > 0 ? [`${r.differentCatalogue} priced with a different catalogue version, not re-derived`] : []),
    ...(r.mismatched > 0 ? [`${r.mismatched} DO NOT MATCH`] : []),
  ];
  lines.push(row(
    "Costs re-derived from reported usage",
    `${r.matched} matched`,
    repriceNotes.length === 0 ? "" : `(${repriceNotes.join("; ")})`,
  ));
  if (r.mismatched > 0) {
    lines.push("    Some stored costs do not match their recorded usage. Tell MESH before any invoice is issued.");
  }
  lines.push("");
  return lines.join("\n");
}

/** What is printed when the chain does not verify: the break, and no figures. */
export function renderInvalid(result: Extract<StatementResult, { valid: false }>): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  mesh statement — period ${result.period}`);
  lines.push("");
  lines.push(...ledgerLines(result.ledger, result.spoolNames));
  lines.push("");
  lines.push("  NOT VALID FOR BILLING");
  lines.push(`  ${result.reason}`);
  lines.push("  No figures are shown and no statement file was written. MESH does not bill");
  lines.push("  from a ledger whose chain is broken. Keep the ledger files as they are and");
  lines.push("  contact MESH.");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

type Args = { period?: string; ledgerDir: string; out?: string; json: boolean; check?: string; spools: string[] };

function parse(argv: string[]): Args {
  const args: Args = { ledgerDir: join(MESH_HOME, "ledger"), json: false, spools: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--help" || key === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (key === "--json") { args.json = true; continue; }
    if (!key.startsWith("--")) { args.spools.push(resolve(key)); continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value.`);
    index += 1;
    switch (key) {
      case "--period": args.period = value; break;
      case "--ledger": args.ledgerDir = resolve(value); break;
      case "--out": args.out = resolve(value); break;
      case "--check": args.check = resolve(value); break;
      default: throw new Error(`Unknown option: ${key}`);
    }
  }
  return args;
}

function runCheck(file: string): void {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} could not be read as a statement file.`);
  }
  if (!checkStatementSeal(document)) {
    console.log(`  ✗ ${file} does NOT match its sha256 seal: it was edited or damaged after it was written.`);
    process.exit(1);
  }
  const statement = document as Statement;
  console.log(`  ✓ ${file} matches its sha256 seal (${statement.sha256}).`);
  console.log("    The seal shows the file was not altered by accident. The proof of the figures is");
  console.log("    recomputing them from the ledger itself.");
}

export async function runStatement(argv: string[]): Promise<void> {
  const args = parse(argv);
  if (args.check !== undefined) { runCheck(args.check); return; }
  if (args.period === undefined) throw new Error(`--period YYYY-MM is required.\n\n${USAGE}`);
  if (!isPeriod(args.period)) throw new Error("--period must be a calendar month written YYYY-MM, for example 2026-11.");

  const paths = args.spools.length > 0 ? args.spools : listSpools(args.ledgerDir);
  if (paths.length === 0) {
    throw new Error(
      `No ledger found in ${args.ledgerDir}. Run MESH on some traffic first, or pass --ledger <dir> or the spool files.`,
    );
  }
  const spools = paths.map((path) => parseSpool(basename(path), readFileSync(path, "utf8")));
  const result = buildStatement({ spools, period: args.period });

  if (!result.valid) {
    if (args.json) {
      console.log(JSON.stringify({
        schema: STATEMENT_SCHEMA,
        kind: "statement",
        period: { id: result.period },
        validForBilling: false,
        reason: result.reason,
        ledger: result.ledger,
      }, null, 2));
    } else {
      console.log(renderInvalid(result));
    }
    process.exit(1);
  }

  const out = args.out ?? resolve(`mesh-statement-${args.period}.json`);
  const file = `${JSON.stringify(result.statement, null, 2)}\n`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, file);

  if (args.json) {
    process.stdout.write(file);
    return;
  }
  console.log(renderStatement(result.statement, result.spoolNames));
  console.log(`  Statement file  ${out}`);
  console.log(`  sha256 seal     ${result.statement.sha256}`);
  console.log("  It holds numbers, lever names, model ids and hashes only. Send it to MESH with");
  console.log("  your ledger files; check it later with: mesh statement --check <file>");
  console.log("");
}
