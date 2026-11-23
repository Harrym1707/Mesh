/**
 * The weekly report: what Mesh did for this user, in money, in words anyone
 * can read in five seconds.
 *
 * This module is the DATA and the WORDS. It returns values and never prints,
 * exits, writes a file or makes a network call:
 *
 *   buildWeeklyReport(input)   Report   one local week, Monday to Monday
 *   buildMonthReport(input)    Report   one billing month (UTC), same style
 *   monthToDate(spools, now)   MonthToDate | null   "this month so far"
 *   reportHeadline(report)     string[]  the first screen, one sentence a line
 *   reportOneLine(report)      string    for a notification or a banner
 *   renderReport(report)       string    the whole text report
 *
 * The command (`mesh report`), the HTML page and the weekly delivery are thin
 * layers over these: report-command.ts, report-html.ts, report-delivery.ts.
 *
 * WHERE THE FIGURES COME FROM. Nothing here decides what a billable saving
 * is. A week's events are selected by their timestamp and then put through
 * the same functions `mesh statement` runs (`recomputePeriod` in statement.ts:
 * `recomputeInvoice` at the contracted fee, `buildStripeInvoicePlan`, and
 * `selectBillableEvents` for the counts and the actual cost). Failed tasks
 * are voided, savings the user already had are excluded, unpriced models are
 * not priced and negative components are netted, because the bill does all
 * of that and this calls the bill.
 *
 * RECONCILIATION. A week is cut into the parts that fall in each billing
 * month (the UTC calendar month stamped on each event), and each part is
 * recomputed as that month's statement would count it: the same duplicate
 * rule over the whole ledger, and the same failed-task set (a task that
 * failed anywhere in the month voids its turns in every week of that month).
 * So the parts of every week that fall in a month add up to that month's
 * statement, to within floating-point noise, and a week that spans two
 * months is the sum of its two parts. The weekly FEE lines are a different
 * matter: each is 1% of that week's saving rounded down to the cent, while
 * the invoice rounds down once on the month's total and nets a losing week
 * against the others. The invoice is the monthly statement, not this report.
 *
 * PRIVACY. A report holds money, counts, dates, lever names and model ids
 * (the last two only in the detail, and only when they look like an id).
 * Never a prompt, a tool argument, a request id, an application name, a
 * spool file name or a key (report-no-leak.test.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

// Direct module imports, not the package barrels (see start.ts).
import { DEFAULT_FEE_PERCENT } from "../../core/src/accounts.js";
import {
  feeCents as coreFeeCents,
  selectBillableEvents,
  verifyLedgerChain,
  type BillableEvent,
} from "../../core/src/savings-ledger.js";
import { isPeriod, listSpools, parseSpool, plainId, recomputePeriod, type SpoolInput } from "./statement.js";
import { summariseTheo, type ReportTheo, type TheoRecords } from "./report-theo.js";

export type { ReportTheo, TheoRecords };

// ---------------------------------------------------------------------------
// Time: local weeks, in a named time zone, with an injected clock
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** This machine's time zone as an IANA name, or UTC when the system gives none. */
export function localTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone !== "" ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock reading in `timeZone` at one instant. Throws a RangeError for an unknown zone. */
function wallClock(instantMs: number, timeZone: string): WallClock {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  const read: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") read[part.type] = Number(part.value);
  }
  return {
    year: read.year ?? 1970,
    month: read.month ?? 1,
    day: read.day ?? 1,
    hour: (read.hour ?? 0) % 24,
    minute: read.minute ?? 0,
    second: read.second ?? 0,
  };
}

const pad2 = (value: number): string => String(value).padStart(2, "0");
const dateText = (year: number, month: number, day: number): string => `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;

/** The calendar date (YYYY-MM-DD) in `timeZone` at one instant. */
export function localDate(instantMs: number, timeZone: string): string {
  const wall = wallClock(instantMs, timeZone);
  return dateText(wall.year, wall.month, wall.day);
}

/** The hour of the day (0 to 23) in `timeZone` at one instant. */
export function localHour(instantMs: number, timeZone: string): number {
  return wallClock(instantMs, timeZone).hour;
}

/** Minutes-precise offset of `timeZone` from UTC at one instant, in milliseconds. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const wall = wallClock(instantMs, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isCalendarDate(value: string | undefined): value is string {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

/** Calendar arithmetic on a YYYY-MM-DD date: no time zone is involved. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return dateText(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/** The Monday of the week a calendar date falls in. */
export function mondayOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 Sunday .. 6 Saturday
  return addDays(date, -((weekday + 6) % 7));
}

/**
 * The first instant of a calendar date in `timeZone`, as UTC milliseconds.
 *
 * Usually that is local midnight. On a day the clocks skip midnight (a few
 * zones change at 00:00) it is the first moment that exists, and on a day
 * midnight happens twice it is the first of the two that starts the date for
 * good. The offsets tried are the ones in force a day either side, so a
 * change of clocks at the boundary is always among them.
 */
export function localDayStartUtc(date: string, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day);
  const offsets = new Set([
    zoneOffsetMs(wall - DAY_MS, timeZone),
    zoneOffsetMs(wall, timeZone),
    zoneOffsetMs(wall + DAY_MS, timeZone),
  ]);
  const candidates = [...offsets].map((offset) => wall - offset).sort((left, right) => left - right);
  for (const candidate of candidates) {
    if (localDate(candidate, timeZone) === date && localDate(candidate - 1, timeZone) !== date) return candidate;
  }
  for (const candidate of candidates) {
    if (localDate(candidate, timeZone) === date) return candidate;
  }
  return wall - zoneOffsetMs(wall, timeZone);
}

/** The span a report covers. A week is local; a month is the billing month, in UTC. */
export type ReportPeriod = {
  kind: "week" | "month";
  /** A week: the Monday it starts on, YYYY-MM-DD. A month: YYYY-MM. Names the report. */
  id: string;
  /** First and last calendar day of the span, in `timeZone`. */
  startDate: string;
  endDate: string;
  /** The IANA zone a week's days are counted in; "UTC" for a month. */
  timeZone: string;
  /** The exact instants: from `startsAt` up to, not including, `endsBefore` (ISO 8601, UTC). */
  startsAt: string;
  endsBefore: string;
  /** False while the span is still running: the figures can still change. */
  finished: boolean;
  /** Where the span sits relative to the clock: the one running now, the one just before it, or an older one. */
  relative: "current" | "last" | "earlier";
  /** "16 to 22 Nov", "30 Nov to 6 Dec", "November 2026". */
  label: string;
};

function dayAndMonth(date: string): { day: number; month: number; year: number } {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return { day, month, year };
}

/** "16 to 22 Nov" within one month, "30 Nov to 6 Dec" across two. */
export function weekLabel(startDate: string, endDate: string): string {
  const start = dayAndMonth(startDate);
  const end = dayAndMonth(endDate);
  return start.month === end.month
    ? `${start.day} to ${end.day} ${MONTHS_SHORT[end.month - 1]}`
    : `${start.day} ${MONTHS_SHORT[start.month - 1]} to ${end.day} ${MONTHS_SHORT[end.month - 1]}`;
}

/** "Mon 16 Nov 2026" for the detail view. */
function longDate(date: string): string {
  const { day, month, year } = dayAndMonth(date);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${MONTHS_SHORT[month - 1]} ${year}`;
}

/** "16 Nov" for a sentence. */
export function shortDate(date: string): string {
  const { day, month } = dayAndMonth(date);
  return `${day} ${MONTHS_SHORT[month - 1]}`;
}

/** Which week a caller wants: the last full one, the one running now, or the one a date falls in. */
export type WeekChoice = "last" | "this" | { date: string };

/**
 * One local week, Monday 00:00 to the next Monday 00:00 in `timeZone`.
 * Pure: the clock and the zone are arguments.
 */
export function weekPeriod(choice: WeekChoice, now: Date, timeZone: string): ReportPeriod {
  const thisMonday = mondayOf(localDate(now.getTime(), timeZone));
  const monday = choice === "this" ? thisMonday : choice === "last" ? addDays(thisMonday, -7) : mondayOf(choice.date);
  const startMs = localDayStartUtc(monday, timeZone);
  const endMs = localDayStartUtc(addDays(monday, 7), timeZone);
  const sunday = addDays(monday, 6);
  return {
    kind: "week",
    id: monday,
    startDate: monday,
    endDate: sunday,
    timeZone,
    startsAt: new Date(startMs).toISOString(),
    endsBefore: new Date(endMs).toISOString(),
    finished: now.getTime() >= endMs,
    relative: monday === thisMonday ? "current" : monday === addDays(thisMonday, -7) ? "last" : "earlier",
    label: weekLabel(monday, sunday),
  };
}

/** One billing month: a calendar month in UTC, as `mesh statement` counts it. */
export function monthPeriod(period: string, now: Date): ReportPeriod {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const startMs = Date.UTC(year, month - 1, 1);
  const endMs = Date.UTC(year, month, 1);
  const current = now.toISOString().slice(0, 7);
  const previous = new Date(Date.UTC(Number(current.slice(0, 4)), Number(current.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  return {
    kind: "month",
    id: period,
    startDate: `${period}-01`,
    endDate: new Date(endMs - DAY_MS).toISOString().slice(0, 10),
    timeZone: "UTC",
    startsAt: new Date(startMs).toISOString(),
    endsBefore: new Date(endMs).toISOString(),
    finished: now.getTime() >= endMs,
    relative: period === current ? "current" : period === previous ? "last" : "earlier",
    label: `${MONTHS_LONG[month - 1]} ${year}`,
  };
}

// ---------------------------------------------------------------------------
// The figures: the bill's own arithmetic over one span
// ---------------------------------------------------------------------------

export type ReportCase = "saved" | "saved_nothing" | "cost_more" | "no_requests" | "not_verified";

export type ReportLever = {
  lever: string;
  kind: string;
  /** Requests this lever was billed on. */
  requests: number;
  savedUsd: number;
  /** Present when the saving is anchored to an estimated baseline rather than fully measured. */
  basis?: "estimated-baseline";
  /** True when the ledger records a proof from Theo's replay gate against this lever. */
  provenByTheo?: true;
};

export type ReportModel = {
  provider: string;
  model: string;
  requests: number;
  paidProviderUsd: number;
  savedUsd: number;
};

/** The part of a span that falls in one billing month. The parts add up to the span. */
export type ReportPiece = {
  /** The billing month, YYYY-MM (UTC), stamped on the events. */
  billingMonth: string;
  requests: number;
  paidProviderUsd: number;
  savedUsd: number;
};

export type ReportDetail = {
  levers: ReportLever[];
  models: ReportModel[];
  requests: {
    /** Every request recorded in the span, counted once. */
    counted: number;
    /** Part of a task that failed: their savings are not counted. */
    excludedFailedTask: number;
    /** On a model that is not in the price list: no cost and no saving is counted for them. */
    unpriced: number;
    unpricedByModel: { provider: string; model: string; requests: number }[];
    withBilledSaving: number;
  };
  /** Savings the user already had before Mesh (their own caching). Shown, never counted. */
  alreadyYoursUsd: number;
  pieces: ReportPiece[];
  notes: string[];
};

/** "This month so far": the current billing month, from the statement's own recompute. */
export type MonthToDate = {
  label: "this month so far";
  /** The billing month, YYYY-MM (UTC). */
  period: string;
  monthName: string;
  requests: number;
  /** Net verified savings so far: the statement's figure for the month. */
  savedUsd: number;
  feePercent: number;
  /** The fee so far as the invoice would round it: whole cents, rounded down on the month's total. */
  feeCents: number;
  feeUsd: number;
  /** The bill's own verdict for the month so far. */
  verdict: "charge" | "do_not_charge";
};

type ReportCommon = {
  kind: "week" | "month";
  period: ReportPeriod;
  generatedAt: string;
  currency: "USD";
  feePercent: number;
  /** One or two plain lines about Theo, or null when there is nothing to say. Never part of a money figure. */
  theo: ReportTheo | null;
};

export type VerifiedReport = ReportCommon & {
  case: Exclude<ReportCase, "not_verified">;
  ledgerVerified: true;
  /** Requests Mesh handled in the span. */
  requests: number;
  /** What the span's priced requests cost, from the provider's own reported usage. */
  paidProviderUsd: number;
  /**
   * What they would have cost without Mesh. DERIVED, not measured: paid plus
   * net verified savings, exactly as `mesh statement` derives its baseline.
   */
  withoutMeshUsd: number;
  /** Net verified savings: the bill's own figure for these events. */
  savedUsd: number;
  /** 1% of the span's savings through core `feeCents`: whole cents, rounded down. */
  feeCents: number;
  feeUsd: number;
  /** Savings are positive but the fee on them is under one cent, so nothing is owed for them. */
  feeBelowOneCent: boolean;
  /** Saved minus fee. */
  keepUsd: number;
  /** Requests on models not in the price list: not in the cost lines. */
  unpricedRequests: number;
  monthToDate: MonthToDate;
  detail: ReportDetail;
};

/** A ledger whose chain does not verify yields no figure at all. */
export type UnverifiedReport = ReportCommon & {
  case: "not_verified";
  ledgerVerified: false;
  requests: null;
  paidProviderUsd: null;
  withoutMeshUsd: null;
  savedUsd: null;
  feeCents: null;
  feeUsd: null;
  feeBelowOneCent: null;
  keepUsd: null;
  unpricedRequests: null;
  monthToDate: null;
  detail: null;
};

export type Report = VerifiedReport | UnverifiedReport;

/** True when every spool's hash chain verifies, checked spool by spool as the bill does. */
export function ledgerVerifies(spools: readonly SpoolInput[]): boolean {
  return spools.every((spool) => spool.unreadableLine === undefined && verifyLedgerChain(spool.records).ok);
}

/**
 * When a request started, in UTC milliseconds. A timestamp that cannot be
 * read falls back to the first instant of the billing month stamped on the
 * event, so every event the statement counts lands in exactly one week.
 */
function eventInstant(event: BillableEvent): number {
  const parsed = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  return Date.UTC(Number(event.invoicePeriod.slice(0, 4)), Number(event.invoicePeriod.slice(5, 7)) - 1, 1);
}

/**
 * The ledger's events as the statement sees them before it picks a period:
 * each request once (the bill's duplicate rule, over every spool), and only
 * events stamped with a billing month, since no statement counts any other.
 */
function countedEvents(spools: readonly SpoolInput[]): BillableEvent[] {
  const all = spools.flatMap((spool) => spool.records.map((record) => record.event));
  return selectBillableEvents(all).consideredEvents.filter((event) => isPeriod(event.invoicePeriod));
}

type Totals = {
  requests: number;
  paidProviderUsd: number;
  savedUsd: number;
  unpriced: number;
  excludedFailedTask: number;
  withBilledSaving: number;
  alreadyYoursUsd: number;
  levers: Map<string, ReportLever>;
  models: Map<string, ReportModel>;
  unpricedByModel: Map<string, { provider: string; model: string; requests: number }>;
  pieces: ReportPiece[];
};

/**
 * Recompute the events `inSpan` selects, one billing month at a time, each as
 * that month's statement counts it. `counted` is the whole ledger (see
 * `countedEvents`); the month's failed-task set comes from all of it.
 */
function recomputeSpan(counted: readonly BillableEvent[], inSpan: (event: BillableEvent) => boolean): Totals {
  const byMonth = new Map<string, BillableEvent[]>();
  for (const event of counted) {
    if (!inSpan(event)) continue;
    const list = byMonth.get(event.invoicePeriod);
    if (list === undefined) byMonth.set(event.invoicePeriod, [event]);
    else list.push(event);
  }
  const totals: Totals = {
    requests: 0,
    paidProviderUsd: 0,
    savedUsd: 0,
    unpriced: 0,
    excludedFailedTask: 0,
    withBilledSaving: 0,
    alreadyYoursUsd: 0,
    levers: new Map(),
    models: new Map(),
    unpricedByModel: new Map(),
    pieces: [],
  };
  for (const billingMonth of [...byMonth.keys()].sort()) {
    const events = byMonth.get(billingMonth)!;
    // The tasks the month's statement voids: any task with a failed turn
    // anywhere in the month, not only in this week's part of it.
    const failedTaskIds = [...selectBillableEvents(counted, { period: billingMonth }).failedTaskIds];
    const piece = recomputePeriod(events, billingMonth, { failedTaskIds });
    const { invoice, selection } = piece;

    totals.requests += invoice.eventsConsidered;
    totals.paidProviderUsd += piece.actualCostUsd;
    totals.savedUsd += invoice.netVerifiedSavingsUsd;
    totals.unpriced += invoice.unpricedEvents;
    totals.excludedFailedTask += invoice.eventsExcludedForFailedTasks;
    totals.withBilledSaving += invoice.eventsBilled;
    totals.alreadyYoursUsd += invoice.excludedAlreadyOwned.providerCacheOnAppendedHistoryUsd +
      invoice.excludedAlreadyOwned.gatewayCacheUsd;
    totals.pieces.push({
      billingMonth,
      requests: invoice.eventsConsidered,
      paidProviderUsd: piece.actualCostUsd,
      savedUsd: invoice.netVerifiedSavingsUsd,
    });

    for (const line of invoice.lineItems) {
      const lever = plainId(line.leverId);
      const key = `${line.kind}\n${lever}`;
      const row = totals.levers.get(key) ?? { lever, kind: line.kind, requests: 0, savedUsd: 0 };
      row.requests += line.events;
      row.savedUsd += line.savedUsd;
      if (line.basis === "estimated-baseline") row.basis = "estimated-baseline";
      if (line.gateVerdictRefs.some((ref) => ref.startsWith("theo-gate:"))) row.provenByTheo = true;
      totals.levers.set(key, row);
    }

    // Per model: the same recompute over that model's events alone, so a
    // model's saving is the bill's figure for it, not a second sum.
    const byModel = new Map<string, { provider: string; model: string; events: BillableEvent[] }>();
    for (const event of selection.consideredEvents) {
      const provider = plainId(event.provider);
      const model = plainId(event.model);
      const key = `${provider}\n${model}`;
      const group = byModel.get(key) ?? { provider, model, events: [] };
      group.events.push(event);
      byModel.set(key, group);
    }
    for (const [key, group] of byModel) {
      const own = recomputePeriod(group.events, billingMonth, { failedTaskIds });
      const row = totals.models.get(key) ?? { provider: group.provider, model: group.model, requests: 0, paidProviderUsd: 0, savedUsd: 0 };
      row.requests += own.invoice.eventsConsidered;
      row.paidProviderUsd += own.actualCostUsd;
      row.savedUsd += own.invoice.netVerifiedSavingsUsd;
      totals.models.set(key, row);
      if (own.invoice.unpricedEvents > 0) {
        const unpriced = totals.unpricedByModel.get(key) ?? { provider: group.provider, model: group.model, requests: 0 };
        unpriced.requests += own.invoice.unpricedEvents;
        totals.unpricedByModel.set(key, unpriced);
      }
    }
  }
  return totals;
}

/** The current billing month from the statement's own recompute. Null when the ledger does not verify. */
export function monthToDate(spools: readonly SpoolInput[], now: Date): MonthToDate | null {
  if (!ledgerVerifies(spools)) return null;
  return monthToDateOf(countedEvents(spools), now);
}

function monthToDateOf(counted: readonly BillableEvent[], now: Date): MonthToDate {
  const period = now.toISOString().slice(0, 7);
  const { invoice, plan } = recomputePeriod(counted, period);
  const charge = plan.action === "bill";
  const cents = charge ? plan.amountCents : 0;
  return {
    label: "this month so far",
    period,
    monthName: MONTHS_LONG[Number(period.slice(5, 7)) - 1]!,
    requests: invoice.eventsConsidered,
    savedUsd: invoice.netVerifiedSavingsUsd,
    feePercent: invoice.feePercent ?? DEFAULT_FEE_PERCENT,
    feeCents: cents,
    feeUsd: cents / 100,
    verdict: charge ? "charge" : "do_not_charge",
  };
}

const byName = <T extends { provider?: string; model?: string; lever?: string }>(left: T, right: T): number => {
  const a = left.lever ?? `${left.provider}/${left.model}`;
  const b = right.lever ?? `${right.provider}/${right.model}`;
  return a < b ? -1 : a > b ? 1 : 0;
};

function detailNotes(period: ReportPeriod, feePercent: number, totals: Totals): string[] {
  const span = period.kind;
  const notes: string[] = [];
  notes.push(
    `"Without Mesh" is worked out, not measured: what you paid plus the verified saving, the same way mesh statement works it out.`,
  );
  if (span === "week") {
    notes.push(
      `The fee shown is ${feePercent}% of this week's saving, rounded down to the cent. It is a guide, not a bill. ` +
      "Your invoice is the monthly statement (mesh statement), which rounds down once on the month's total, so the " +
      "weekly fees can differ from it by a few cents.",
    );
    notes.push(
      "A week where Mesh cost you money counts against the same month's savings, so the invoice can come to less than the weekly fees added up. It never comes to more than 1% of the month's verified saving.",
    );
    notes.push(
      "A billing month is a calendar month in UTC. A week that crosses a month end is counted in two parts, one for each month, and they add up to the week.",
    );
  } else {
    notes.push(
      `The fee is ${feePercent}% of the month's verified saving, rounded down to the cent, as mesh statement works it out. The invoice is issued separately, from the same ledger.`,
    );
  }
  notes.push(
    "If a task fails, the savings on all its requests in that billing month stop counting, so an earlier week's figure can go down later.",
  );
  if (totals.unpriced > 0) {
    notes.push("Requests on models that are not in the price list are not in the cost lines, and no saving is claimed for them.");
  }
  if (!period.finished) notes.push(`This ${span} has not finished, so these figures can still change.`);
  return notes;
}

/** Records about Theo that a report may read. Injected so the builders stay pure. */
export type ReportExtras = { theo?: TheoRecords };

function buildReport(
  kind: "week" | "month",
  period: ReportPeriod,
  spools: readonly SpoolInput[],
  now: Date,
  inSpan: (event: BillableEvent) => boolean,
  extras: ReportExtras,
): Report {
  const common = {
    kind,
    period,
    generatedAt: now.toISOString(),
    currency: "USD" as const,
    feePercent: DEFAULT_FEE_PERCENT,
  };
  // The chain is verified before anything is added up. No chain, no figure.
  if (!ledgerVerifies(spools)) {
    return {
      ...common,
      theo: null,
      case: "not_verified",
      ledgerVerified: false,
      requests: null,
      paidProviderUsd: null,
      withoutMeshUsd: null,
      savedUsd: null,
      feeCents: null,
      feeUsd: null,
      feeBelowOneCent: null,
      keepUsd: null,
      unpricedRequests: null,
      monthToDate: null,
      detail: null,
    };
  }
  const counted = countedEvents(spools);
  const totals = recomputeSpan(counted, inSpan);
  const savedUsd = totals.savedUsd;
  // The fee rule lives in core (`feeCents`): whole cents, rounded down.
  const cents = coreFeeCents(savedUsd, DEFAULT_FEE_PERCENT);
  const feeUsd = cents / 100;
  // The case follows the figure as it is printed, to the cent.
  const shownCents = Math.round(savedUsd * 100);
  const reportCase: VerifiedReport["case"] = totals.requests === 0
    ? "no_requests"
    : shownCents > 0 ? "saved" : shownCents < 0 ? "cost_more" : "saved_nothing";
  const levers = [...totals.levers.values()].sort(byName);
  return {
    ...common,
    // Theo's lines are words beside the figures. Nothing he proposes is added to any of them.
    theo: totals.requests === 0 || extras.theo === undefined
      ? null
      : summariseTheo(extras.theo, { period, levers, now }),
    case: reportCase,
    ledgerVerified: true,
    requests: totals.requests,
    paidProviderUsd: totals.paidProviderUsd,
    withoutMeshUsd: totals.paidProviderUsd + savedUsd,
    savedUsd,
    feeCents: cents,
    feeUsd,
    feeBelowOneCent: reportCase === "saved" && cents === 0,
    keepUsd: savedUsd - feeUsd,
    unpricedRequests: totals.unpriced,
    monthToDate: monthToDateOf(counted, now),
    detail: {
      levers,
      models: [...totals.models.values()].sort(byName),
      requests: {
        counted: totals.requests,
        excludedFailedTask: totals.excludedFailedTask,
        unpriced: totals.unpriced,
        unpricedByModel: [...totals.unpricedByModel.values()].sort(byName),
        withBilledSaving: totals.withBilledSaving,
      },
      alreadyYoursUsd: totals.alreadyYoursUsd,
      pieces: totals.pieces,
      notes: detailNotes(period, DEFAULT_FEE_PERCENT, totals),
    },
  };
}

export type WeeklyReportInput = ReportExtras & {
  spools: readonly SpoolInput[];
  /** The clock. Injected: nothing here reads the time itself. */
  now: Date;
  /** The IANA zone the week's days are counted in (the user's own). */
  timeZone: string;
  /** Default: the last full week. */
  week?: WeekChoice;
};

/** The report for one local week. Pure: the ledger, the clock and the zone are all arguments. */
export function buildWeeklyReport(input: WeeklyReportInput): Report {
  const period = weekPeriod(input.week ?? "last", input.now, input.timeZone);
  const startMs = Date.parse(period.startsAt);
  const endMs = Date.parse(period.endsBefore);
  return buildReport("week", period, input.spools, input.now, (event) => {
    const at = eventInstant(event);
    return at >= startMs && at < endMs;
  }, input);
}

export type MonthReportInput = ReportExtras & {
  spools: readonly SpoolInput[];
  now: Date;
  /** The billing month, YYYY-MM. Default: the current one (UTC). */
  period?: string;
};

/** The same report for one billing month: the events `mesh statement --period` counts. */
export function buildMonthReport(input: MonthReportInput): Report {
  const id = input.period ?? input.now.toISOString().slice(0, 7);
  if (!isPeriod(id)) throw new Error("--month must be a calendar month written YYYY-MM, for example 2026-11.");
  const period = monthPeriod(id, input.now);
  return buildReport("month", period, input.spools, input.now, (event) => event.invoicePeriod === id, input);
}

// ---------------------------------------------------------------------------
// Reading the ledger
// ---------------------------------------------------------------------------

/**
 * Read every spool in a ledger directory. A last line that is cut short (the
 * proxy is part-way through writing it) is left out and the spool is read up
 * to there; an unreadable line anywhere else makes the spool unverifiable, as
 * it does for the statement.
 */
export function readReportSpools(ledgerDir: string): SpoolInput[] {
  if (!existsSync(ledgerDir)) return [];
  return listSpools(ledgerDir).map((path) => {
    const text = readFileSync(path, "utf8");
    const spool = parseSpool(basename(path), text);
    if (spool.unreadableLine === undefined || text.endsWith("\n")) return spool;
    const lastLine = text.split(/\r?\n/).length;
    return spool.unreadableLine === lastLine ? { name: spool.name, records: spool.records } : spool;
  });
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/** "$1,204.50". A negative amount is written "-$1.20". US dollars, as the ledger records them. */
export function money(amount: number, places = 2): string {
  const text = Math.abs(amount).toFixed(places);
  const [whole, fraction] = text.split(".") as [string, string];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount < 0 && Number(text) !== 0 ? "-" : ""}$${grouped}.${fraction}`;
}

/** "1,204". */
export function count(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const requestsText = (value: number): string => `${count(value)} ${value === 1 ? "request" : "requests"}`;

/** "this week", "this month". */
const thisSpan = (report: Report): string => `this ${report.kind}`;

function titleLine(report: Report): string {
  return report.period.finished
    ? `Mesh, your ${report.kind} (${report.period.label}).`
    : `Mesh, your ${report.kind} so far (${report.period.label}, not finished).`;
}

function unpricedLine(report: VerifiedReport): string[] {
  if (report.unpricedRequests === 0) return [];
  return [report.unpricedRequests === 1
    ? "1 request on a model not in the price list is not counted."
    : `${count(report.unpricedRequests)} requests on models not in the price list are not counted.`];
}

/**
 * The first screen: the money statement, one short sentence a line. No lever
 * names, no token counts, nothing a non-engineer has to look up.
 */
export function reportHeadline(report: Report): string[] {
  const span = thisSpan(report);
  const dates = report.period.label;
  if (!report.ledgerVerified) {
    return [`Mesh could not verify your ledger ${span} (${dates}), so there is no figure.`, "Run: mesh verify"];
  }
  if (report.case === "no_requests") {
    return report.period.finished
      ? [`Mesh saw no requests ${span} (${dates}), so it is not connected.`, "Fix: mesh setup"]
      : [`Mesh has seen no requests so far ${span} (${dates}).`, "If you have used your tools since then, it is not connected. Fix: mesh setup"];
  }
  const tail = [`${requestsText(report.requests)}, ledger verified.`, ...unpricedLine(report)];
  const paid = `You paid your provider ${money(report.paidProviderUsd)}.`;
  if (report.case === "saved_nothing") {
    return [
      titleLine(report),
      paid,
      `Mesh saved you $0.00 ${span}, so you owe nothing.`,
      "Your setup is already lean.",
      ...tail,
    ];
  }
  if (report.case === "cost_more") {
    return [
      titleLine(report),
      paid,
      `Mesh cost you ${money(Math.abs(report.savedUsd))} ${span}.`,
      "That counts against Mesh's fee, and you owe nothing.",
      ...tail,
    ];
  }
  return [
    titleLine(report),
    paid,
    `Without Mesh: ${money(report.withoutMeshUsd)}.`,
    `Mesh saved you ${money(report.savedUsd)}.`,
    report.feeBelowOneCent
      ? "Mesh's fee on that is under one cent, so you owe nothing for it."
      : `Mesh's fee on that: ${money(report.feeUsd)}.`,
    `You keep ${money(report.keepUsd)}.`,
    ...tail,
  ];
}

/** "This month so far" in one line, or undefined when there is no figure to give. */
export function reportMonthLine(report: Report): string | undefined {
  const month = report.monthToDate;
  if (month === null) return undefined;
  // A report for the current month already is "this month so far".
  if (report.kind === "month" && report.period.id === month.period) return undefined;
  const lead = `This month so far (${month.monthName}):`;
  if (month.requests === 0) return `${lead} no requests yet, nothing owed yet.`;
  const shown = Math.round(month.savedUsd * 100);
  const saved = shown < 0 ? `Mesh cost you ${money(Math.abs(month.savedUsd))}` : `saved ${money(month.savedUsd)}`;
  return month.verdict === "charge"
    ? `${lead} ${saved}, fee so far ${money(month.feeUsd)}.`
    : `${lead} ${saved}, nothing owed yet.`;
}

/** "last week", "so far this week", "in the week of 2 to 8 Nov"; the same for a month. */
function whenPhrase(report: Report): string {
  if (report.period.relative === "current") return `so far this ${report.kind}`;
  if (report.period.relative === "last") return `last ${report.kind}`;
  return report.kind === "week" ? `in the week of ${report.period.label}` : `in ${report.period.label}`;
}

export type OneLineOptions = {
  /** The command the line ends on. Default "mesh report"; the desktop notification passes "mesh report --open". */
  detailsCommand?: string;
};

/**
 * One line for a notification, a banner or a status line. Says the same
 * thing as the first screen and nothing it does not.
 */
export function reportOneLine(report: Report, options: OneLineOptions = {}): string {
  const details = options.detailsCommand ?? "mesh report";
  const when = whenPhrase(report);
  // These two end on the fix. A caller that names its own command (the
  // notification) gets it added, so the text still ends on that command.
  const fixTail = options.detailsCommand === undefined ? "" : `. Report: ${details}`;
  if (!report.ledgerVerified) {
    return `Mesh could not verify your ledger ${when}, so there is no figure. Run: mesh verify${fixTail}`;
  }
  if (report.case === "no_requests") {
    return `Mesh saw no requests ${when}, so it is not connected. Fix: mesh setup${fixTail}`;
  }
  // A proposal waiting for a yes is worth one clause. It is never a figure.
  const theo = report.theo !== null && report.theo.waitingProposals > 0 ? " Theo found more: mesh theo --proposals." : "";
  const end = `${theo} Details: ${details}`;
  if (report.case === "saved_nothing") return `Mesh saved you $0.00 ${when}, so you owe nothing.${end}`;
  if (report.case === "cost_more") {
    return `Mesh cost you ${money(Math.abs(report.savedUsd))} ${when}. It counts against Mesh's fee and you owe nothing.${end}`;
  }
  return report.feeBelowOneCent
    ? `Mesh saved you ${money(report.savedUsd)} ${when} (fee under one cent, nothing owed).${end}`
    : `Mesh saved you ${money(report.savedUsd)} ${when} (fee ${money(report.feeUsd)}).${end}`;
}

/** Where the rest is. For a finished month, the statement too. */
export function reportPointers(report: Report, options: { detailShown?: boolean } = {}): string[] {
  const lines: string[] = [];
  if (report.kind === "month" && report.period.finished && report.ledgerVerified && report.case !== "no_requests") {
    lines.push(`Your statement: mesh statement --period ${report.period.id}`);
  }
  if (options.detailShown !== true && report.ledgerVerified && report.case !== "no_requests") {
    lines.push(report.kind === "month" ? `Details: mesh report --month ${report.period.id} --detail` : "Details: mesh report --detail");
  }
  return lines;
}

/** Four places, for the detail: ledger amounts are often fractions of a cent. */
const usd4 = (amount: number): string => money(amount, 4);

/** The breakdown below the plain part: per lever, per model, the counts and the notes. */
export function renderReportDetail(report: Report): string[] {
  const lines: string[] = [];
  const period = report.period;
  lines.push("THE DETAIL");
  if (period.kind === "week") {
    lines.push(`  Week      ${longDate(period.startDate)} to ${longDate(period.endDate)}, in your time zone (${period.timeZone})`);
  } else {
    lines.push(`  Month     ${period.label}, the billing month (a calendar month in UTC)`);
  }
  lines.push(`  Exactly   ${period.startsAt} up to, not including, ${period.endsBefore} (UTC)`);
  lines.push("  Amounts   US dollars. Shown to four places here; the plain part rounds to the cent.");
  if (!report.ledgerVerified) {
    lines.push("");
    lines.push("  The ledger's hash chain does not verify, so no figure is shown. Run: mesh verify");
    return lines;
  }
  const detail = report.detail;
  lines.push("");
  lines.push("  WHERE THE SAVING CAME FROM");
  if (detail.levers.length === 0) {
    lines.push(`    Nothing produced a verified saving this ${report.kind}.`);
  } else {
    lines.push(`    ${"Lever".padEnd(32)}${"Kind".padEnd(16)}${"Requests".padStart(9)}  ${"Verified saving".padStart(16)}`);
    for (const lever of detail.levers) {
      const marks = [
        ...(lever.basis === "estimated-baseline" ? ["estimated baseline"] : []),
        ...(lever.provenByTheo === true ? ["proved by Theo on your traffic"] : []),
      ];
      lines.push(
        `    ${lever.lever.padEnd(32)}${lever.kind.padEnd(16)}${count(lever.requests).padStart(9)}  ${usd4(lever.savedUsd).padStart(16)}` +
        `${marks.length === 0 ? "" : `  (${marks.join("; ")})`}`,
      );
    }
    if (detail.levers.some((lever) => lever.savedUsd < 0)) {
      lines.push("    A negative row cost more than it saved. It counts against Mesh.");
    }
  }
  lines.push("");
  lines.push("  BY MODEL");
  if (detail.models.length === 0) {
    lines.push("    No requests.");
  } else {
    lines.push(`    ${"Model".padEnd(48)}${"Requests".padStart(9)}  ${"You paid".padStart(14)}  ${"Verified saving".padStart(16)}`);
    for (const model of detail.models) {
      lines.push(
        `    ${`${model.provider}/${model.model}`.padEnd(48)}${count(model.requests).padStart(9)}  ` +
        `${usd4(model.paidProviderUsd).padStart(14)}  ${usd4(model.savedUsd).padStart(16)}`,
      );
    }
  }
  lines.push("");
  lines.push("  REQUESTS");
  const row = (label: string, value: string): string => `    ${label.padEnd(52)}${value}`;
  lines.push(row(`Requests this ${report.kind}`, count(detail.requests.counted)));
  lines.push(row("With a verified saving", count(detail.requests.withBilledSaving)));
  lines.push(row("Part of a failed task (savings not counted)", count(detail.requests.excludedFailedTask)));
  lines.push(row("On a model not in the price list (not counted)", count(detail.requests.unpriced)));
  for (const item of detail.requests.unpricedByModel) {
    lines.push(`        ${item.provider}/${item.model}: ${requestsText(item.requests)}`);
  }
  lines.push(row("Savings you already had (your own caching)", `${usd4(detail.alreadyYoursUsd)}, not counted`));
  if (detail.pieces.length > 1) {
    lines.push("");
    lines.push("  BY BILLING MONTH");
    lines.push(`    ${"Month".padEnd(12)}${"Requests".padStart(9)}  ${"You paid".padStart(14)}  ${"Verified saving".padStart(16)}`);
    for (const piece of detail.pieces) {
      lines.push(
        `    ${piece.billingMonth.padEnd(12)}${count(piece.requests).padStart(9)}  ` +
        `${usd4(piece.paidProviderUsd).padStart(14)}  ${usd4(piece.savedUsd).padStart(16)}`,
      );
    }
  }
  lines.push("");
  lines.push("  TOTALS");
  lines.push(row("You paid your provider", usd4(report.paidProviderUsd)));
  lines.push(row("Without Mesh (worked out, see the first note)", usd4(report.withoutMeshUsd)));
  lines.push(row("Verified saving", usd4(report.savedUsd)));
  lines.push(row(`Fee at ${report.feePercent}%, rounded down to the cent`, money(report.feeUsd)));
  lines.push("");
  lines.push("  NOTES");
  for (const note of detail.notes) lines.push(...wrap(note, 76).map((text, index) => `    ${index === 0 ? "- " : "  "}${text}`));
  return lines;
}

/** Break a sentence into lines of at most `width` characters. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * The whole text report: the money statement, Theo's one or two lines, then,
 * clearly apart, this month so far and where the detail is.
 */
export function renderReport(report: Report, options: { detail?: boolean } = {}): string {
  const lines: string[] = ["", ...reportHeadline(report)];
  if (report.theo !== null && report.theo.lines.length > 0) lines.push("", ...report.theo.lines);
  const below = [reportMonthLine(report), ...reportPointers(report, { detailShown: options.detail === true })]
    .filter((line): line is string => line !== undefined);
  if (below.length > 0) lines.push("", ...below);
  if (options.detail === true) lines.push("", ...renderReportDetail(report));
  lines.push("");
  return lines.map((line) => (line === "" ? "" : `  ${line}`)).join("\n");
}
