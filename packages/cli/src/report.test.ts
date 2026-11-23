/**
 * The weekly report's figures and words, from ledgers built here. Everything
 * is in-process and pure: the clock and the time zone are passed in, and no
 * test reads the real ~/.mesh.
 */
import { describe, expect, it } from "vitest";

import { feeCents, chainLedgerRecord, type BillableEvent, type LedgerLever, type LedgerRecord } from "../../core/src/savings-ledger.js";
import {
  addDays,
  buildMonthReport,
  buildWeeklyReport,
  localDate,
  localDayStartUtc,
  localTimeZone,
  mondayOf,
  monthToDate,
  renderReport,
  reportHeadline,
  reportMonthLine,
  reportOneLine,
  weekPeriod,
  type Report,
  type VerifiedReport,
} from "./report.js";
import { buildStatement, type SpoolInput } from "./statement.js";

let counter = 0;

/** One ledger event. `paid` is the provider cost; `saved` a lossless lever's verified saving. */
function event(
  timestamp: string,
  options: { paid?: number; saved?: number; levers?: LedgerLever[] } & Partial<BillableEvent> = {},
): BillableEvent {
  counter += 1;
  const { paid, saved, levers, ...overrides } = options;
  return {
    schemaVersion: 1,
    requestId: `req-${counter}`,
    applicationId: "app",
    invoicePeriod: timestamp.slice(0, 7),
    timestamp,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    executionMode: "standard",
    pricingStatus: "priced",
    actualUsd: paid ?? 0,
    levers: levers ?? (saved === undefined ? [] : [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd: saved }]),
    status: "succeeded",
    ...overrides,
  };
}

function spool(events: readonly BillableEvent[], name = "app-anthropic.jsonl"): SpoolInput {
  const records: LedgerRecord[] = [];
  for (const item of events) records.push(chainLedgerRecord(item, records[records.length - 1]));
  return { name, records };
}

/** `count` requests spread through one UTC day, the first carrying the money. */
function busyDay(day: string, count: number, paid: number, saved: number): BillableEvent[] {
  const events: BillableEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = `${day}T${String(8 + (index % 10)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`;
    events.push(index === 0 ? event(at, { paid, saved }) : event(at));
  }
  return events;
}

const verified = (report: Report): VerifiedReport => {
  if (!report.ledgerVerified) throw new Error("expected a verified report");
  return report;
};

// Monday 23 Nov 2026, mid-morning in London: the last full week is 16 to 22 Nov.
const NOW = new Date("2026-11-23T10:00:00.000Z");
const LONDON = "Europe/London";

describe("the weekly report: each case, in plain words", () => {
  it("saved: paid, without Mesh, saved, the fee rounded down, what you keep", () => {
    const report = verified(buildWeeklyReport({ spools: [spool(busyDay("2026-11-18", 1204, 412.10, 86.20))], now: NOW, timeZone: LONDON }));
    expect(report.case).toBe("saved");
    expect(report.period).toMatchObject({
      kind: "week",
      id: "2026-11-16",
      startDate: "2026-11-16",
      endDate: "2026-11-22",
      startsAt: "2026-11-16T00:00:00.000Z",
      endsBefore: "2026-11-23T00:00:00.000Z",
      finished: true,
      relative: "last",
      label: "16 to 22 Nov",
    });
    expect(report.requests).toBe(1204);
    expect(report.paidProviderUsd).toBeCloseTo(412.10, 9);
    expect(report.savedUsd).toBeCloseTo(86.20, 9);
    expect(report.withoutMeshUsd).toBeCloseTo(498.30, 9);
    expect(report.feeCents).toBe(86);
    expect(report.feeCents).toBe(feeCents(report.savedUsd, 1));
    expect(report.keepUsd).toBeCloseTo(85.34, 9);
    expect(reportHeadline(report)).toEqual([
      "Mesh, your week (16 to 22 Nov).",
      "You paid your provider $412.10.",
      "Without Mesh: $498.30.",
      "Mesh saved you $86.20.",
      "Mesh's fee on that: $0.86.",
      "You keep $85.34.",
      "1,204 requests, ledger verified.",
    ]);
    expect(reportOneLine(report)).toBe("Mesh saved you $86.20 last week (fee $0.86). Details: mesh report");
    expect(reportOneLine(report, { detailsCommand: "mesh report --open" })).toBe(
      "Mesh saved you $86.20 last week (fee $0.86). Details: mesh report --open",
    );
  });

  it("saved nothing: owes nothing, and says the setup is already lean", () => {
    const report = verified(buildWeeklyReport({ spools: [spool(busyDay("2026-11-18", 1204, 412.10, 0))], now: NOW, timeZone: LONDON }));
    expect(report.case).toBe("saved_nothing");
    expect(report.feeCents).toBe(0);
    expect(reportHeadline(report)).toEqual([
      "Mesh, your week (16 to 22 Nov).",
      "You paid your provider $412.10.",
      "Mesh saved you $0.00 this week, so you owe nothing.",
      "Your setup is already lean.",
      "1,204 requests, ledger verified.",
    ]);
    expect(reportOneLine(report)).toBe("Mesh saved you $0.00 last week, so you owe nothing. Details: mesh report");
  });

  it("cost more: says so honestly, that it counts against the fee, and that nothing is owed", () => {
    const events = [
      event("2026-11-17T09:00:00.000Z", { paid: 40, levers: [{ leverId: "cache-ttl-1h", kind: "provider_cache", savedUsd: -1.95 }] }),
      event("2026-11-18T09:00:00.000Z", { paid: 10, saved: 0.75 }),
    ];
    const report = verified(buildWeeklyReport({ spools: [spool(events)], now: NOW, timeZone: LONDON }));
    expect(report.case).toBe("cost_more");
    expect(report.savedUsd).toBeCloseTo(-1.2, 9);
    expect(report.feeCents).toBe(0);
    expect(report.keepUsd).toBeCloseTo(-1.2, 9);
    expect(reportHeadline(report)).toEqual([
      "Mesh, your week (16 to 22 Nov).",
      "You paid your provider $50.00.",
      "Mesh cost you $1.20 this week.",
      "That counts against Mesh's fee, and you owe nothing.",
      "2 requests, ledger verified.",
    ]);
    expect(reportOneLine(report)).toBe(
      "Mesh cost you $1.20 last week. It counts against Mesh's fee and you owe nothing. Details: mesh report",
    );
  });

  it("a fee under one cent on a real saving: the saving is stated and nothing is owed for it", () => {
    const report = verified(buildWeeklyReport({ spools: [spool([event("2026-11-18T09:00:00.000Z", { paid: 4.10, saved: 0.36 })])], now: NOW, timeZone: LONDON }));
    expect(report.case).toBe("saved");
    expect(report.feeBelowOneCent).toBe(true);
    expect(report.feeCents).toBe(0);
    expect(report.keepUsd).toBeCloseTo(0.36, 9);
    expect(reportHeadline(report)).toEqual([
      "Mesh, your week (16 to 22 Nov).",
      "You paid your provider $4.10.",
      "Without Mesh: $4.46.",
      "Mesh saved you $0.36.",
      "Mesh's fee on that is under one cent, so you owe nothing for it.",
      "You keep $0.36.",
      "1 request, ledger verified.",
    ]);
    expect(reportOneLine(report)).toBe("Mesh saved you $0.36 last week (fee under one cent, nothing owed). Details: mesh report");
  });

  it("no requests: not connected, with the fix, and no Theo section", () => {
    const other = [event("2026-11-03T09:00:00.000Z", { paid: 5, saved: 1 })];
    for (const spools of [[], [spool(other)]]) {
      const report = verified(buildWeeklyReport({ spools, now: NOW, timeZone: LONDON, theo: { state: "missing" } }));
      expect(report.case).toBe("no_requests");
      expect(report.theo).toBeNull();
      expect(reportHeadline(report)).toEqual([
        "Mesh saw no requests this week (16 to 22 Nov), so it is not connected.",
        "Fix: mesh setup",
      ]);
      expect(reportOneLine(report)).toBe("Mesh saw no requests last week, so it is not connected. Fix: mesh setup");
      expect(reportOneLine(report, { detailsCommand: "mesh report --open" })).toMatch(/mesh report --open$/);
    }
  });

  it("not verified: no money figure anywhere, and the command to run", () => {
    const records = spool(busyDay("2026-11-18", 3, 412.10, 86.20)).records.map((record) => structuredClone(record));
    (records[0]!.event.levers[0] as { savedUsd: number }).savedUsd = 999; // edited without re-chaining
    const report = buildWeeklyReport({ spools: [{ name: "x.jsonl", records }], now: NOW, timeZone: LONDON, theo: { state: "missing" } });
    expect(report.case).toBe("not_verified");
    expect(report.ledgerVerified).toBe(false);
    for (const field of ["requests", "paidProviderUsd", "withoutMeshUsd", "savedUsd", "feeCents", "feeUsd", "keepUsd", "monthToDate", "detail", "theo"] as const) {
      expect(report[field], field).toBeNull();
    }
    expect(reportHeadline(report)).toEqual([
      "Mesh could not verify your ledger this week (16 to 22 Nov), so there is no figure.",
      "Run: mesh verify",
    ]);
    expect(reportOneLine(report)).toBe("Mesh could not verify your ledger last week, so there is no figure. Run: mesh verify");
    const text = renderReport(report, { detail: true });
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toContain("999");
    expect(reportMonthLine(report)).toBeUndefined();
  });

  it("a spool with an unreadable line in the middle does not verify either", () => {
    const good = spool([event("2026-11-18T09:00:00.000Z", { paid: 1, saved: 1 })]);
    const report = buildWeeklyReport({ spools: [{ ...good, unreadableLine: 1 }], now: NOW, timeZone: LONDON });
    expect(report.case).toBe("not_verified");
  });

  it("unpriced requests add exactly one short line, and are not in the cost lines", () => {
    const events = [
      event("2026-11-18T09:00:00.000Z", { paid: 10, saved: 2 }),
      event("2026-11-18T10:00:00.000Z", { pricingStatus: "unpriced", actualUsd: undefined, model: "some-new-model" }),
      event("2026-11-18T11:00:00.000Z", { pricingStatus: "unpriced", actualUsd: undefined, model: "some-new-model" }),
    ];
    const report = verified(buildWeeklyReport({ spools: [spool(events)], now: NOW, timeZone: LONDON }));
    expect(report.unpricedRequests).toBe(2);
    expect(report.paidProviderUsd).toBe(10);
    const headline = reportHeadline(report);
    expect(headline.slice(-2)).toEqual([
      "3 requests, ledger verified.",
      "2 requests on models not in the price list are not counted.",
    ]);
    expect(headline).toHaveLength(8);
    expect(report.detail.requests.unpricedByModel).toEqual([{ provider: "anthropic", model: "some-new-model", requests: 2 }]);
  });

  it("the first screen has no lever name, no token count and no jargon", () => {
    const report = buildWeeklyReport({ spools: [spool(busyDay("2026-11-18", 12, 40, 9))], now: NOW, timeZone: LONDON });
    const screen = renderReport(report);
    for (const word of ["duplicate-context-removal", "lossless", "token", "lever", "baseline", "invoice", "UTC", "hash"]) {
      expect(screen.toLowerCase().includes(word.toLowerCase()), word).toBe(false);
    }
    expect(screen).toContain("Details: mesh report --detail");
    // The detail has them, below.
    const detail = renderReport(report, { detail: true });
    expect(detail).toContain("duplicate-context-removal");
    expect(detail).toContain("anthropic/claude-sonnet-5-5");
    const notes = verified(report).detail.notes.join(" ");
    expect(notes).toContain("worked out, not measured");
    expect(notes).toContain("can differ from it by a few cents");
    expect(notes).toContain("Your invoice is the monthly statement");
    expect(detail).toContain("worked out, not measured");
    expect(detail).not.toMatch(/[\u001b\u009b]/);
  });

  it("this week so far is labelled as not finished", () => {
    const report = verified(buildWeeklyReport({
      spools: [spool([event("2026-11-23T09:00:00.000Z", { paid: 3, saved: 1.5 })])],
      now: NOW,
      timeZone: LONDON,
      week: "this",
    }));
    expect(report.period).toMatchObject({ id: "2026-11-23", finished: false, relative: "current", label: "23 to 29 Nov" });
    expect(reportHeadline(report)[0]).toBe("Mesh, your week so far (23 to 29 Nov, not finished).");
    expect(reportOneLine(report)).toBe("Mesh saved you $1.50 so far this week (fee $0.01). Details: mesh report");
    expect(report.detail.notes.some((note) => note.includes("has not finished"))).toBe(true);
  });

  it("--week takes any date in the wanted week", () => {
    const spools = [spool([event("2026-11-04T09:00:00.000Z", { paid: 3, saved: 1.5 })])];
    for (const date of ["2026-11-02", "2026-11-05", "2026-11-08"]) {
      const report = verified(buildWeeklyReport({ spools, now: NOW, timeZone: LONDON, week: { date } }));
      expect(report.period).toMatchObject({ id: "2026-11-02", label: "2 to 8 Nov", relative: "earlier" });
      expect(report.requests).toBe(1);
      expect(reportOneLine(report)).toBe("Mesh saved you $1.50 in the week of 2 to 8 Nov (fee $0.01). Details: mesh report");
    }
  });
});

describe("week boundaries in the user's own time zone", () => {
  it("Los Angeles: Monday 00:00 local is 08:00 UTC in winter, and an event one second earlier is last week's", () => {
    const zone = "America/Los_Angeles";
    const now = new Date("2026-11-23T20:00:00.000Z");
    const period = weekPeriod("last", now, zone);
    expect(period).toMatchObject({ id: "2026-11-16", startsAt: "2026-11-16T08:00:00.000Z", endsBefore: "2026-11-23T08:00:00.000Z", timeZone: zone });
    const spools = [spool([
      event("2026-11-16T07:59:59.000Z", { paid: 1, saved: 100 }), // Sunday evening in LA: the week before
      event("2026-11-16T08:00:00.000Z", { paid: 2, saved: 10 }),
      event("2026-11-23T07:59:59.000Z", { paid: 4, saved: 20 }),
      event("2026-11-23T08:00:00.000Z", { paid: 8, saved: 1000 }), // Monday 00:00 in LA: this week
    ])];
    const report = verified(buildWeeklyReport({ spools, now, timeZone: zone }));
    expect(report.requests).toBe(2);
    expect(report.savedUsd).toBe(30);
    expect(report.paidProviderUsd).toBe(6);
    const before = verified(buildWeeklyReport({ spools, now, timeZone: zone, week: { date: "2026-11-15" } }));
    expect(before.savedUsd).toBe(100);
  });

  it("Tokyo: Monday 00:00 local is Sunday 15:00 UTC", () => {
    const zone = "Asia/Tokyo";
    const now = new Date("2026-11-23T02:00:00.000Z"); // Monday 11:00 in Tokyo
    const period = weekPeriod("last", now, zone);
    expect(period).toMatchObject({ id: "2026-11-16", startsAt: "2026-11-15T15:00:00.000Z", endsBefore: "2026-11-22T15:00:00.000Z" });
    const spools = [spool([
      event("2026-11-15T14:59:59.000Z", { paid: 1, saved: 100 }),
      event("2026-11-15T15:00:00.000Z", { paid: 2, saved: 10 }),
      event("2026-11-22T14:59:59.000Z", { paid: 4, saved: 20 }),
      event("2026-11-22T15:00:00.000Z", { paid: 8, saved: 1000 }),
    ])];
    const report = verified(buildWeeklyReport({ spools, now, timeZone: zone }));
    expect(report.requests).toBe(2);
    expect(report.savedUsd).toBe(30);
  });

  it("the same instant is in different weeks in different zones", () => {
    // 2026-11-22T20:00Z is Sunday in Los Angeles and already Monday in Tokyo.
    const at = new Date("2026-11-22T20:00:00.000Z");
    expect(weekPeriod("this", at, "America/Los_Angeles").id).toBe("2026-11-16");
    expect(weekPeriod("this", at, "Asia/Tokyo").id).toBe("2026-11-23");
  });

  it("a week with a daylight-saving change is 167 or 169 hours long, and still Monday to Monday", () => {
    const zone = "America/Los_Angeles";
    const hours = (period: { startsAt: string; endsBefore: string }): number =>
      (Date.parse(period.endsBefore) - Date.parse(period.startsAt)) / 3_600_000;
    // Clocks go back on Sunday 1 Nov 2026: that week is an hour longer.
    const autumn = weekPeriod({ date: "2026-10-28" }, NOW, zone);
    expect(autumn).toMatchObject({ id: "2026-10-26", startsAt: "2026-10-26T07:00:00.000Z", endsBefore: "2026-11-02T08:00:00.000Z" });
    expect(hours(autumn)).toBe(169);
    // Clocks go forward on Sunday 8 Mar 2026: that week is an hour shorter.
    const spring = weekPeriod({ date: "2026-03-04" }, NOW, zone);
    expect(spring).toMatchObject({ id: "2026-03-02", startsAt: "2026-03-02T08:00:00.000Z", endsBefore: "2026-03-09T07:00:00.000Z" });
    expect(hours(spring)).toBe(167);
    // An event in the repeated hour (01:30 PST, after the change) is counted once, in that week.
    const spools = [spool([event("2026-11-01T09:30:00.000Z", { paid: 1, saved: 7 }), event("2026-11-02T08:00:00.000Z", { paid: 1, saved: 70 })])];
    expect(verified(buildWeeklyReport({ spools, now: NOW, timeZone: zone, week: { date: "2026-10-28" } })).savedUsd).toBe(7);
  });

  it("weeks tile the year with no gap and no overlap, in zones with and without clock changes", () => {
    for (const zone of ["America/Los_Angeles", "Asia/Tokyo", "Europe/London", "Australia/Lord_Howe", "America/Havana", "Asia/Kathmandu", "Pacific/Chatham", "UTC"]) {
      let monday = mondayOf("2026-01-01");
      let previousEnd: string | undefined;
      for (let week = 0; week < 54; week += 1) {
        const period = weekPeriod({ date: monday }, NOW, zone);
        if (previousEnd !== undefined) expect(period.startsAt, `${zone} ${monday}`).toBe(previousEnd);
        expect(localDate(Date.parse(period.startsAt), zone), `${zone} ${monday}`).toBe(monday);
        expect(localDate(Date.parse(period.endsBefore) - 1, zone), `${zone} ${monday}`).toBe(addDays(monday, 6));
        previousEnd = period.endsBefore;
        monday = addDays(monday, 7);
      }
    }
  });

  it("a day starts at its first instant even when the clocks skip or repeat midnight", () => {
    // Havana changes its clocks at midnight; every day of the year must still start cleanly.
    for (const zone of ["America/Havana", "America/Santiago", "Africa/Cairo", "Asia/Beirut"]) {
      let date = "2026-01-01";
      for (let day = 0; day < 365; day += 1) {
        const start = localDayStartUtc(date, zone);
        expect(localDate(start, zone), `${zone} ${date}`).toBe(date);
        expect(localDate(start - 1, zone), `${zone} ${date}`).toBe(addDays(date, -1));
        date = addDays(date, 1);
      }
    }
  });

  it("this machine's zone follows TZ", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      expect(localTimeZone()).toBe("America/Los_Angeles");
      process.env.TZ = "Asia/Tokyo";
      expect(localTimeZone()).toBe("Asia/Tokyo");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

/** A ledger over ten weeks with everything the bill has a rule for. */
function mixedLedger(): SpoolInput[] {
  const first: BillableEvent[] = [];
  const second: BillableEvent[] = [];
  let seed = 7;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const start = Date.parse("2026-10-12T00:00:00.000Z");
  for (let index = 0; index < 900; index += 1) {
    const at = new Date(start + Math.floor(random() * 70 * 86_400_000)).toISOString();
    const kind = index % 9;
    const target = index % 2 === 0 ? first : second;
    if (kind === 0) {
      target.push(event(at, { paid: random() * 3, levers: [{ leverId: "cache-ttl-1h", kind: "provider_cache", savedUsd: -random() * 0.4 }] }));
    } else if (kind === 1) {
      target.push(event(at, { pricingStatus: "unpriced", actualUsd: undefined, model: "unlisted-model", saved: random() }));
    } else if (kind === 2) {
      target.push(event(at, { paid: random() * 2, levers: [{ leverId: "stale-history-compaction", kind: "lossy", savedUsd: random() }] })); // no verdict: never billed
    } else if (kind === 3) {
      target.push(event(at, {
        paid: random() * 2,
        model: "claude-haiku-5",
        excluded: { providerCacheAlreadyOwnedUsd: random(), gatewayCacheUsd: random() / 2 },
        levers: [{ leverId: "tool-schema-compaction", kind: "lossless", savedUsd: random() * 0.9, basis: "estimated-baseline" }],
      }));
    } else {
      target.push(event(at, { paid: random() * 4, saved: random() * 1.3 }));
    }
  }
  // A task whose early turns saved money and whose last turn failed three weeks later, in the same month.
  first.push(event("2026-11-03T10:00:00.000Z", { paid: 2, saved: 9.99, taskId: "task-late-failure", turnIndex: 0 }));
  first.push(event("2026-11-10T10:00:00.000Z", { paid: 2, saved: 5.55, taskId: "task-late-failure", turnIndex: 1 }));
  second.push(event("2026-11-24T10:00:00.000Z", { paid: 2, taskId: "task-late-failure", turnIndex: 2, status: "failed" }));
  // A task that fails in the NEXT month: the statement for November still counts its November turn.
  first.push(event("2026-11-29T10:00:00.000Z", { paid: 1, saved: 3.21, taskId: "task-fails-next-month", turnIndex: 0 }));
  second.push(event("2026-12-02T10:00:00.000Z", { paid: 1, saved: 1.11, taskId: "task-fails-next-month", turnIndex: 1 }));
  second.push(event("2026-12-03T10:00:00.000Z", { paid: 1, taskId: "task-fails-next-month", turnIndex: 2, status: "failed" }));
  // The same request recorded twice, in two weeks and two spools: it counts once, where it came first.
  const once = event("2026-11-05T12:00:00.000Z", { paid: 6, saved: 4.44 });
  first.push(once);
  second.push({ ...once, timestamp: "2026-11-19T12:00:00.000Z" });
  const inOrder = (events: BillableEvent[]): BillableEvent[] => [...events].sort((left, right) => (left.timestamp < right.timestamp ? -1 : 1));
  return [spool(inOrder(first), "a.jsonl"), spool(inOrder(second), "b.jsonl")];
}

/** Every local week that touches a billing month. */
function weeksTouching(month: string, zone: string): string[] {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const from = Date.UTC(year, index - 1, 1);
  const to = Date.UTC(year, index, 1);
  const mondays: string[] = [];
  let monday = mondayOf(localDate(from, zone));
  while (localDayStartUtc(monday, zone) < to) {
    mondays.push(monday);
    monday = addDays(monday, 7);
  }
  return mondays;
}

describe("reconciliation with mesh statement", () => {
  const spools = mixedLedger();
  const now = new Date("2026-12-28T12:00:00.000Z");

  for (const zone of ["America/Los_Angeles", "Asia/Tokyo", "UTC"]) {
    for (const month of ["2026-10", "2026-11", "2026-12"]) {
      it(`${month} in ${zone}: the parts of each week inside the month add up to the statement`, () => {
        const built = buildStatement({ spools, period: month, now });
        if (!built.valid) throw new Error("fixture ledger must verify");
        const statement = built.statement;
        let saved = 0;
        let paid = 0;
        let requests = 0;
        for (const monday of weeksTouching(month, zone)) {
          const week = verified(buildWeeklyReport({ spools, now, timeZone: zone, week: { date: monday } }));
          // A week that spans two months is the sum of its two parts.
          expect(week.detail.pieces.length).toBeLessThanOrEqual(2);
          expect(week.detail.pieces.reduce((sum, piece) => sum + piece.savedUsd, 0)).toBeCloseTo(week.savedUsd, 9);
          expect(week.detail.pieces.reduce((sum, piece) => sum + piece.requests, 0)).toBe(week.requests);
          expect(week.detail.levers.reduce((sum, lever) => sum + lever.savedUsd, 0)).toBeCloseTo(week.savedUsd, 9);
          expect(week.detail.models.reduce((sum, model) => sum + model.savedUsd, 0)).toBeCloseTo(week.savedUsd, 9);
          expect(week.detail.models.reduce((sum, model) => sum + model.paidProviderUsd, 0)).toBeCloseTo(week.paidProviderUsd, 9);
          expect(week.detail.models.reduce((sum, model) => sum + model.requests, 0)).toBe(week.requests);
          for (const piece of week.detail.pieces.filter((part) => part.billingMonth === month)) {
            saved += piece.savedUsd;
            paid += piece.paidProviderUsd;
            requests += piece.requests;
          }
        }
        expect(requests).toBe(statement.requests.inPeriod);
        expect(saved).toBeCloseTo(statement.totals.netVerifiedSavingsUsd, 9);
        expect(paid).toBeCloseTo(statement.totals.actualCostUsd, 9);
      });
    }
  }

  it("the month report is the statement: the same saving, cost, counts, fee and verdict", () => {
    for (const month of ["2026-10", "2026-11", "2026-12"]) {
      const built = buildStatement({ spools, period: month, now });
      if (!built.valid) throw new Error("fixture ledger must verify");
      const statement = built.statement;
      const report = verified(buildMonthReport({ spools, now, period: month }));
      expect(report.savedUsd).toBe(statement.totals.netVerifiedSavingsUsd);
      expect(report.paidProviderUsd).toBe(statement.totals.actualCostUsd);
      expect(report.withoutMeshUsd).toBe(statement.totals.baselineCostUsd);
      expect(report.requests).toBe(statement.requests.inPeriod);
      expect(report.feeCents).toBe(statement.fee.amountCents);
      expect(report.unpricedRequests).toBe(statement.requests.unpriced);
      expect(report.detail.requests.excludedFailedTask).toBe(statement.requests.excludedFailedTask);
      expect(report.detail.levers.map((lever) => [lever.lever, lever.requests, lever.savedUsd]))
        .toEqual(statement.levers.map((lever) => [lever.lever, lever.requests, lever.savedUsd]));
    }
  });

  it("this month so far is the statement's figure for the current month", () => {
    const midMonth = new Date("2026-11-20T12:00:00.000Z");
    const built = buildStatement({ spools, period: "2026-11", now: midMonth });
    if (!built.valid) throw new Error("fixture ledger must verify");
    const soFar = monthToDate(spools, midMonth)!;
    expect(soFar).toEqual({
      label: "this month so far",
      period: "2026-11",
      monthName: "November",
      requests: built.statement.requests.inPeriod,
      savedUsd: built.statement.totals.netVerifiedSavingsUsd,
      feePercent: 1,
      feeCents: built.statement.fee.amountCents,
      feeUsd: built.statement.fee.amountUsd,
      verdict: built.statement.verdict,
    });
    const weekly = verified(buildWeeklyReport({ spools, now: midMonth, timeZone: "UTC" }));
    expect(weekly.monthToDate).toEqual(soFar);
    expect(reportMonthLine(weekly)).toMatch(/^This month so far \(November\): saved \$[\d,]+\.\d\d, fee so far \$\d+\.\d\d\.$/);
  });

  it("a task that fails later voids an earlier week's saving, as on the statement", () => {
    const report = verified(buildWeeklyReport({ spools, now, timeZone: "UTC", week: { date: "2026-11-03" } }));
    // The 9.99 saved on 3 Nov belongs to a task that failed on 24 Nov: it is not in the week's lines.
    const alone = verified(buildWeeklyReport({
      spools: [spool([event("2026-11-03T10:00:00.000Z", { paid: 2, saved: 9.99, taskId: "t", turnIndex: 0 })])],
      now,
      timeZone: "UTC",
      week: { date: "2026-11-03" },
    }));
    expect(alone.savedUsd).toBe(9.99);
    const voided = verified(buildWeeklyReport({
      spools: [spool([
        event("2026-11-03T10:00:00.000Z", { paid: 2, saved: 9.99, taskId: "t", turnIndex: 0 }),
        event("2026-11-24T10:00:00.000Z", { paid: 2, taskId: "t", turnIndex: 1, status: "failed" }),
      ])],
      now,
      timeZone: "UTC",
      week: { date: "2026-11-03" },
    }));
    expect(voided.savedUsd).toBe(0);
    expect(voided.case).toBe("saved_nothing");
    expect(voided.paidProviderUsd).toBe(2); // the request was still paid for
    expect(voided.detail.requests.excludedFailedTask).toBe(1);
    expect(report.detail.requests.excludedFailedTask).toBeGreaterThanOrEqual(1);
    expect(report.detail.notes.some((note) => note.includes("If a task fails"))).toBe(true);
  });

  it("a week that spans a month end adds up to its two parts, each counted in its own month", () => {
    const events = [
      event("2026-11-30T12:00:00.000Z", { paid: 10, saved: 2.25 }),
      event("2026-12-01T12:00:00.000Z", { paid: 20, saved: 3.5 }),
      event("2026-12-06T12:00:00.000Z", { paid: 5, saved: 0.25 }),
    ];
    const report = verified(buildWeeklyReport({ spools: [spool(events)], now, timeZone: "UTC", week: { date: "2026-12-02" } }));
    expect(report.period.label).toBe("30 Nov to 6 Dec");
    expect(report.savedUsd).toBe(6);
    expect(report.paidProviderUsd).toBe(35);
    expect(report.detail.pieces).toEqual([
      { billingMonth: "2026-11", requests: 1, paidProviderUsd: 10, savedUsd: 2.25 },
      { billingMonth: "2026-12", requests: 2, paidProviderUsd: 25, savedUsd: 3.75 },
    ]);
    expect(renderReport(report, { detail: true })).toContain("BY BILLING MONTH");
  });

  it("weekly fee lines can differ from the invoice by cents: each week rounds down, the month rounds once", () => {
    // Four weeks of $0.99 saved: each week's fee is 0 cents, the month's is 3.
    const events = ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"].map((day) => event(`${day}T10:00:00.000Z`, { paid: 5, saved: 0.99 }));
    const ledger = [spool(events)];
    const weeklyFees = ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"]
      .map((date) => verified(buildWeeklyReport({ spools: ledger, now, timeZone: "UTC", week: { date } })).feeCents);
    expect(weeklyFees).toEqual([0, 0, 0, 0]);
    expect(verified(buildMonthReport({ spools: ledger, now, period: "2026-11" })).feeCents).toBe(3);
  });
});

describe("the month in the same plain style", () => {
  const spools = [spool([
    event("2026-10-07T10:00:00.000Z", { paid: 100, saved: 21.63 }),
    event("2026-11-10T10:00:00.000Z", { paid: 40, saved: 8.5 }),
  ])];

  it("a finished month points at the statement", () => {
    const report = verified(buildMonthReport({ spools, now: NOW, period: "2026-10" }));
    expect(report.period).toMatchObject({ kind: "month", id: "2026-10", label: "October 2026", finished: true, relative: "last", timeZone: "UTC" });
    expect(report.feeCents).toBe(21); // $0.2163 rounded down
    const text = renderReport(report);
    expect(text).toContain("Mesh, your month (October 2026).");
    expect(text).toContain("Mesh saved you $21.63.");
    expect(text).toContain("Mesh's fee on that: $0.21.");
    expect(text).toContain("Your statement: mesh statement --period 2026-10");
    expect(text).toContain("This month so far (November): saved $8.50, fee so far $0.08.");
    expect(reportOneLine(report)).toBe("Mesh saved you $21.63 last month (fee $0.21). Details: mesh report");
  });

  it("the current month is labelled as not finished and does not repeat itself", () => {
    const report = verified(buildMonthReport({ spools, now: NOW }));
    expect(report.period).toMatchObject({ id: "2026-11", finished: false, relative: "current" });
    const text = renderReport(report);
    expect(text).toContain("Mesh, your month so far (November 2026, not finished).");
    expect(text).not.toContain("Your statement:");
    expect(text).not.toContain("This month so far");
  });

  it("this month so far says nothing is owed yet when the verdict is do_not_charge", () => {
    const small = [spool([event("2026-11-17T10:00:00.000Z", { paid: 4, saved: 0.36 })])];
    const report = verified(buildWeeklyReport({ spools: small, now: NOW, timeZone: LONDON }));
    expect(report.monthToDate.verdict).toBe("do_not_charge");
    expect(reportMonthLine(report)).toBe("This month so far (November): saved $0.36, nothing owed yet.");
    const losing = [spool([event("2026-11-17T10:00:00.000Z", { paid: 4, levers: [{ leverId: "cache-ttl-1h", kind: "provider_cache", savedUsd: -2 }] })])];
    expect(reportMonthLine(buildWeeklyReport({ spools: losing, now: NOW, timeZone: LONDON }))).toBe(
      "This month so far (November): Mesh cost you $2.00, nothing owed yet.",
    );
  });
});
