/**
 * Theo's one or two lines in the weekly report. Each shape, the rule that a
 * proposal is never a saving, and that reading his records is read-only and
 * copes with records that are missing, old or broken.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { chainLedgerRecord, type BillableEvent, type LedgerLever, type LedgerRecord } from "../../core/src/savings-ledger.js";
import { acceptProposal, createTheoMemory, runTheoCycle, type TheoMemory } from "../../sdk-js/src/theo-agent.js";
import { defaultTheoMemoryPath } from "../../sdk-js/src/theo-agent-store.js";
import { policyGateVerdicts } from "../../sdk-js/src/theo-policy.js";
import { buildMonthReport, buildWeeklyReport, renderReport, reportOneLine, type Report, type VerifiedReport } from "./report.js";
import { renderReportHtml } from "./report-html.js";
import { readTheoRecords, theoLines, type TheoFacts, type TheoRecords } from "./report-theo.js";
import type { SpoolInput } from "./statement.js";

const NOW = new Date("2026-11-23T10:00:00.000Z");
const ZONE = "Europe/London";
const LOSSY = "stale-history-compaction";

let counter = 0;
function event(timestamp: string, paid: number, levers: LedgerLever[]): BillableEvent {
  counter += 1;
  return {
    schemaVersion: 1,
    requestId: `theo-req-${counter}`,
    applicationId: "app",
    invoicePeriod: timestamp.slice(0, 7),
    timestamp,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    executionMode: "standard",
    pricingStatus: "priced",
    actualUsd: paid,
    levers,
    status: "succeeded",
  };
}

function spool(events: readonly BillableEvent[]): SpoolInput {
  const records: LedgerRecord[] = [];
  for (const item of events) records.push(chainLedgerRecord(item, records[records.length - 1]));
  return { name: "app-anthropic.jsonl", records };
}

/** A week with $86.20 saved by a lossless lever, on $412.10 paid. */
const baseEvents = (): BillableEvent[] => [
  event("2026-11-18T09:00:00.000Z", 412.10, [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd: 86.20 }]),
  event("2026-11-19T09:00:00.000Z", 0, []),
];

const cycle = (at: string, autonomy = "recommend"): TheoMemory["log"][number] =>
  ({ at, autonomy: autonomy as TheoMemory["autonomy"], observed: "anthropic/claude-sonnet-5-5: 2 req, 900 tok/req", actions: 1 });

/** Theo's memory as his own code builds it: a fresh memory in recommend mode. */
function memory(change: (draft: TheoMemory) => void = () => {}): TheoMemory {
  const draft = createTheoMemory("local", "recommend", "2026-11-01T00:00:00.000Z");
  change(draft);
  return draft;
}

const loaded = (value: unknown): TheoRecords => ({ state: "loaded", memory: value });

const proposal = (lever: string, provenAt: string): TheoMemory["proposals"][number] => ({
  lever,
  savingPercent: 12.5,
  qualityDeltaPercent: -0.2,
  grader: "task-completion",
  provenAt,
  message: `${lever}: proven to save ~12.5% on your traffic, measured quality cost ~0.20% (grader: task-completion). Apply it?`,
});

function week(theo: TheoRecords | undefined, events: BillableEvent[] = baseEvents()): VerifiedReport {
  const report = buildWeeklyReport({ spools: [spool(events)], now: NOW, timeZone: ZONE, ...(theo === undefined ? {} : { theo }) });
  if (!report.ledgerVerified) throw new Error("fixture ledger must verify");
  return report;
}

/** The money in a report: every figure the fee and the "you keep" line come from. */
const moneyOf = (report: Report): unknown => ({
  requests: report.requests,
  paid: report.paidProviderUsd,
  without: report.withoutMeshUsd,
  saved: report.savedUsd,
  feeCents: report.feeCents,
  feeUsd: report.feeUsd,
  keep: report.keepUsd,
  month: report.monthToDate,
  detail: report.detail,
});

describe("Theo in the weekly report", () => {
  it("a proposal waiting for a yes: said plainly, with no number, because none is recorded", () => {
    const report = week(loaded(memory((draft) => {
      draft.log.push(cycle("2026-11-17T10:00:00.000Z"));
      draft.proposals.push(proposal(LOSSY, "2026-11-17T10:00:00.000Z"));
    })));
    expect(report.theo).toMatchObject({
      state: "ran",
      mode: "recommend",
      checks: 1,
      waitingProposals: 1,
      waitingEstimatedWeeklyUsd: null,
      earning: null,
    });
    expect(report.theo!.lines).toEqual([
      "Theo, your token engineer, found a further saving that needs your OK: mesh theo --proposals",
    ]);
    expect(report.theo!.lines.join(" ")).not.toMatch(/[$%\d]/);
    expect(reportOneLine(report)).toBe(
      "Mesh saved you $86.20 last week (fee $0.86). Theo found more: mesh theo --proposals. Details: mesh report",
    );
    expect(reportOneLine(report, { detailsCommand: "mesh report --open" })).toMatch(/Theo found more: mesh theo --proposals\. Details: mesh report --open$/);
  });

  it("several proposals: the count, still no number", () => {
    const report = week(loaded(memory((draft) => {
      draft.proposals.push(proposal(LOSSY, "2026-11-10T10:00:00.000Z"), proposal("output-cap", "2026-11-18T10:00:00.000Z"), proposal("fresh-tool-result-cap", "2026-11-19T10:00:00.000Z"));
    })));
    expect(report.theo!.waitingProposals).toBe(3);
    expect(report.theo!.lines).toEqual([
      "Theo, your token engineer, found 3 further savings that need your OK: mesh theo --proposals",
    ]);
  });

  it("a proposal found after the week being reported is not in that week's report", () => {
    const report = week(loaded(memory((draft) => {
      draft.log.push(cycle("2026-11-17T10:00:00.000Z"));
      draft.proposals.push(proposal(LOSSY, "2026-11-23T09:00:00.000Z")); // this Monday, after last week ended
    })));
    expect(report.theo!.waitingProposals).toBe(0);
    expect(reportOneLine(report)).not.toContain("Theo");
  });

  it("the words can carry an estimate when one is recorded, always marked as estimated", () => {
    const facts: TheoFacts = { state: "ran", mode: "recommend", checks: 4, waitingProposals: 1, waitingEstimatedWeeklyUsd: 12, earning: null, heldBack: 0, rolledBack: 0 };
    expect(theoLines(facts, "week")).toEqual([
      "Theo, your token engineer, found a further saving of about $12.00 a week (estimated). It needs your OK: mesh theo --proposals",
    ]);
    expect(theoLines({ ...facts, waitingProposals: 2, waitingEstimatedWeeklyUsd: 30.5 }, "week")).toEqual([
      "Theo, your token engineer, found 2 further savings of about $30.50 a week in total (estimated). They need your OK: mesh theo --proposals",
    ]);
    // A stored proposal never produces one: the reader finds no dollar figure in Theo's records.
    expect(week(loaded(memory((draft) => { draft.proposals.push(proposal(LOSSY, "2026-11-17T10:00:00.000Z")); }))).theo!.waitingEstimatedWeeklyUsd).toBeNull();
  });

  /** Theo's own code: a proof opens a proposal in recommend mode, and the user accepts it. */
  function acceptedMemory(acceptedAt: string): TheoMemory {
    const start = createTheoMemory("local", "recommend", "2026-11-01T00:00:00.000Z");
    const observation = {
      profile: { name: "anthropic/claude-sonnet-5-5", requests: 40, segments: { toolSchemas: 2000, systemPrompt: 800, retrievedContext: 0, history: 6000, userTurn: 300, output: 500 } },
      price: { inputPerMillion: 3, outputPerMillion: 15 },
    } as unknown as Parameters<typeof runTheoCycle>[1]["observation"];
    const proved = runTheoCycle(start, {
      observation,
      proofs: [{ lever: LOSSY, savingPercent: 12.5, qualityDeltaPercent: -0.2, grader: "task-completion", provenAt: "2026-11-09T10:00:00.000Z" }],
    }, "2026-11-09T10:00:00.000Z");
    expect(proved.memory.proposals.map((item) => item.lever)).toEqual([LOSSY]);
    // Recommend mode publishes nothing lossy on its own.
    expect(proved.memory.policy.levers.some((lever) => lever.class === "lossy" && lever.gate !== undefined)).toBe(false);
    const decision = acceptProposal(proved.memory, LOSSY, {}, acceptedAt);
    if (!decision.ok) throw new Error(decision.reason);
    return decision.memory;
  }

  /** The ledger line the proxy writes for a proven lossy lever: its saving, with the gate's verdict. */
  function earningEvents(accepted: TheoMemory, savedUsd: number): BillableEvent[] {
    const verdict = policyGateVerdicts(accepted.policy)[LOSSY]!;
    return [
      ...baseEvents(),
      event("2026-11-20T09:00:00.000Z", 30, [{ leverId: LOSSY, kind: "lossy", savedUsd, gateVerdict: verdict }]),
    ];
  }

  it("a change the user accepted is now earning: the ledger's figure for it, marked as included above", () => {
    const accepted = acceptedMemory("2026-11-12T15:00:00.000Z");
    const report = week(loaded(accepted), earningEvents(accepted, 4.20));
    expect(report.theo!.earning).toEqual({ changes: 1, savedUsd: 4.20, acceptedOn: "2026-11-12", acceptedByYou: true });
    expect(report.theo!.lines).toEqual([
      "A change Theo proposed and you accepted on 12 Nov saved $4.20 this week (verified, included above).",
    ]);
    // It is inside the verified total, not on top of it.
    expect(report.savedUsd).toBeCloseTo(86.20 + 4.20, 9);
    expect(report.detail.levers.find((lever) => lever.lever === LOSSY)).toMatchObject({ kind: "lossy", savedUsd: 4.20, provenByTheo: true });
  });

  it("a waiting proposal plus an earning one: two lines, the one that needs a yes first", () => {
    const accepted = acceptedMemory("2026-11-12T15:00:00.000Z");
    accepted.proposals.push(proposal("output-cap", "2026-11-18T10:00:00.000Z"));
    accepted.log.push(cycle("2026-11-18T10:00:00.000Z"));
    const report = week(loaded(accepted), earningEvents(accepted, 4.20));
    expect(report.theo!.lines).toEqual([
      "Theo, your token engineer, found a further saving that needs your OK: mesh theo --proposals",
      "A change Theo proposed and you accepted on 12 Nov saved $4.20 this week (verified, included above).",
    ]);
    const text = renderReport(report);
    // Directly under the money statement, before the month line.
    expect(text.indexOf("ledger verified.")).toBeLessThan(text.indexOf("Theo, your token engineer"));
    expect(text.indexOf("included above")).toBeLessThan(text.indexOf("This month so far"));
    const html = renderReportHtml(report);
    expect(html).toContain("found a further saving that needs your OK");
    expect(html).toContain("you accepted on 12 Nov saved $4.20 this week (verified, included above).");
  });

  it("an accepted change earns nothing in the report unless the ledger records it against that change in that week", () => {
    const accepted = acceptedMemory("2026-11-12T15:00:00.000Z");
    // The same lever id in the ledger, but without Theo's proof on the line: not attributed.
    const unproven = [...baseEvents(), event("2026-11-20T09:00:00.000Z", 30, [{ leverId: LOSSY, kind: "lossy", savedUsd: 4.20 }])];
    expect(week(loaded(accepted), unproven).theo!.earning).toBeNull();
    // Earned in another week: nothing for this one.
    const verdict = policyGateVerdicts(accepted.policy)[LOSSY]!;
    const otherWeek = [...baseEvents(), event("2026-11-11T09:00:00.000Z", 30, [{ leverId: LOSSY, kind: "lossy", savedUsd: 4.20, gateVerdict: verdict }])];
    expect(week(loaded(accepted), otherWeek).theo!.earning).toBeNull();
    // Accepted after the week ended: nothing for this one.
    const later = acceptedMemory("2026-11-23T09:00:00.000Z");
    expect(week(loaded(later), earningEvents(later, 4.20)).theo!.earning).toBeNull();
  });

  it("never says 'you accepted' when Theo's records show auto-apply was ever on", () => {
    const accepted = acceptedMemory("2026-11-12T15:00:00.000Z");
    accepted.log.push(cycle("2026-11-13T10:00:00.000Z", "optimise"));
    const report = week(loaded(accepted), earningEvents(accepted, 4.20));
    expect(report.theo!.earning).toMatchObject({ acceptedByYou: false });
    expect(report.theo!.lines).toEqual([
      "A change Theo proved on your traffic saved $4.20 this week (verified, included above).",
    ]);
  });

  it("looked and found nothing: says how many times he checked", () => {
    const report = week(loaded(memory((draft) => {
      draft.log.push(cycle("2026-11-09T10:00:00.000Z")); // the week before: not counted
      for (let hour = 0; hour < 7; hour += 1) draft.log.push(cycle(`2026-11-18T${String(8 + hour).padStart(2, "0")}:00:00.000Z`));
    })));
    expect(report.theo).toMatchObject({ state: "ran", checks: 7 });
    expect(report.theo!.lines).toEqual([
      "Theo, your token engineer, checked your traffic 7 times this week and found nothing more worth changing.",
    ]);
    expect(reportOneLine(report)).toBe("Mesh saved you $86.20 last week (fee $0.86). Details: mesh report");
    const once = week(loaded(memory((draft) => { draft.log.push(cycle("2026-11-18T10:00:00.000Z")); })));
    expect(once.theo!.lines[0]).toContain("checked your traffic once this week");
  });

  it("held something back, or switched it back off", () => {
    const held = week(loaded(memory((draft) => {
      draft.log.push(cycle("2026-11-18T10:00:00.000Z"));
      draft.experiments.push({ lever: LOSSY, ranAt: "2026-11-18T10:00:00.000Z", passed: false, savingPercent: 9, qualityDeltaPercent: -4, grader: "task-completion", note: "quality drop 4.00% exceeds the 1% ceiling" });
    })));
    expect(held.theo).toMatchObject({ heldBack: 1, rolledBack: 0 });
    expect(held.theo!.lines).toEqual(["Theo tested a change and held it back because it did not prove safe on your traffic."]);

    const rolled = week(loaded(memory((draft) => {
      draft.log.push(cycle("2026-11-18T10:00:00.000Z"));
      draft.experiments.push({ lever: LOSSY, ranAt: "2026-11-19T10:00:00.000Z", passed: false, note: "rolled back: retry rate rose 2.0% → 9.0%" });
      draft.rolledBack.push(LOSSY);
    })));
    expect(rolled.theo).toMatchObject({ heldBack: 0, rolledBack: 1 });
    expect(rolled.theo!.lines).toEqual(["Theo switched a change back off because it stopped proving safe on your traffic."]);

    // A test that simply saved nothing is not a safety hold, and one from another week is not this week's.
    const neither = week(loaded(memory((draft) => {
      draft.log.push(cycle("2026-11-18T10:00:00.000Z"));
      draft.experiments.push({ lever: LOSSY, ranAt: "2026-11-18T10:00:00.000Z", passed: false, savingPercent: 0, qualityDeltaPercent: 0, grader: "g", note: "no saving once priced, so nothing to enable" });
      draft.experiments.push({ lever: "output-cap", ranAt: "2026-11-02T10:00:00.000Z", passed: false, savingPercent: 9, qualityDeltaPercent: -4, grader: "g" });
    })));
    expect(neither.theo).toMatchObject({ heldBack: 0, rolledBack: 0 });
    expect(neither.theo!.lines[0]).toContain("found nothing more worth changing");
  });

  it("not running this week, or never run: one line each; no traffic: no section at all", () => {
    const idle = week(loaded(memory((draft) => { draft.log.push(cycle("2026-11-05T10:00:00.000Z")); })));
    expect(idle.theo).toMatchObject({ state: "did_not_run", checks: 0 });
    expect(idle.theo!.lines).toEqual(["Theo, your token engineer, did not run this week."]);

    const never = week({ state: "missing" });
    expect(never.theo).toMatchObject({ state: "never_run" });
    expect(never.theo!.lines).toEqual(["Theo, your token engineer, has not run yet."]);

    const quiet = buildWeeklyReport({ spools: [], now: NOW, timeZone: ZONE, theo: loaded(memory((draft) => { draft.proposals.push(proposal(LOSSY, "2026-11-17T10:00:00.000Z")); })) });
    expect(quiet.case).toBe("no_requests");
    expect(quiet.theo).toBeNull();
    expect(renderReport(quiet)).not.toContain("Theo");
    expect(renderReportHtml(quiet)).not.toContain("Theo");
    expect(reportOneLine(quiet)).not.toContain("Theo");
  });

  it("no lever is named in Theo's lines, in the one-line version or on the first screen", () => {
    const accepted = acceptedMemory("2026-11-12T15:00:00.000Z");
    accepted.proposals.push(proposal("output-cap", "2026-11-18T10:00:00.000Z"));
    const report = week(loaded(accepted), earningEvents(accepted, 4.20));
    const screen = `${renderReport(report)}\n${reportOneLine(report)}\n${report.theo!.lines.join("\n")}`;
    for (const name of [LOSSY, "output-cap", "duplicate-context-removal", "task-completion", "12.5", "grader", "lossy"]) {
      expect(screen.includes(name), name).toBe(false);
    }
  });

  it("nothing Theo proposes or records ever changes a money line", () => {
    const events = baseEvents();
    const without = week(undefined, events);
    const variants: TheoRecords[] = [
      { state: "missing" },
      { state: "unreadable" },
      loaded(memory()),
      loaded(memory((draft) => {
        for (const lever of [LOSSY, "output-cap", "fresh-tool-result-cap"]) draft.proposals.push({ ...proposal(lever, "2026-11-17T10:00:00.000Z"), savingPercent: 99 });
        draft.log.push(cycle("2026-11-18T10:00:00.000Z"));
      })),
      loaded({ schemaVersion: 1, proposals: [{ lever: LOSSY, provenAt: "2026-11-17T10:00:00.000Z", savingPercent: 80, estimatedWeeklySavingUsd: 5000, savedUsd: 5000 }], log: [] }),
    ];
    for (const theo of variants) {
      const report = week(theo, events);
      expect(moneyOf(report)).toEqual(moneyOf(without));
      expect(reportOneLine(report).startsWith("Mesh saved you $86.20 last week (fee $0.86).")).toBe(true);
      const month = buildMonthReport({ spools: [spool(events)], now: NOW, theo });
      expect(moneyOf(month)).toEqual(moneyOf(buildMonthReport({ spools: [spool(events)], now: NOW })));
    }
    // An earning line reports a figure that is already in the total: taking Theo's records away changes no figure.
    const accepted = acceptedMemory("2026-11-12T15:00:00.000Z");
    const earning = earningEvents(accepted, 4.20);
    expect(moneyOf(week(loaded(accepted), earning))).toEqual(moneyOf(week(undefined, earning)));
  });

  it("records that are old, odd or broken say nothing rather than guess", () => {
    expect(week({ state: "unreadable" }).theo).toBeNull();
    for (const odd of [null, "text", 7, [], { schemaVersion: 1 }, { schemaVersion: 1, log: "no", proposals: 3, experiments: {}, policy: [], driftBaselines: "x" }]) {
      const report = week(loaded(odd));
      const lines = report.theo?.lines ?? [];
      expect(lines.length).toBeLessThanOrEqual(1);
      expect(lines.join(" ")).not.toMatch(/\$|accepted|found a further/);
    }
    // Entries with unusable dates are skipped, not counted.
    const report = week(loaded(memory((draft) => {
      (draft.log as unknown[]).push({ at: "last Tuesday" }, { at: 12 }, null, "x");
      (draft.proposals as unknown[]).push({ lever: LOSSY }, { lever: LOSSY, provenAt: "soon" }, 4);
      (draft.experiments as unknown[]).push({ passed: false, ranAt: "never", savingPercent: 5 });
    })));
    expect(report.theo).toMatchObject({ checks: 0, waitingProposals: 0, heldBack: 0 });
  });

  describe("reading his records from disk", () => {
    let dir: string | undefined;
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

    it("is read-only: no file is created, changed or touched, and no cycle is logged", () => {
      dir = mkdtempSync(join(tmpdir(), "mesh-report-theo-"));
      const ledger = join(dir, "ledger");
      expect(readTheoRecords(ledger)).toEqual({ state: "missing" });
      expect(() => readdirSync(ledger)).toThrow(); // nothing was created

      const path = defaultTheoMemoryPath(ledger, "local");
      mkdirSync(join(ledger, "theo"), { recursive: true });
      const stored = memory((draft) => { draft.log.push(cycle("2026-11-18T10:00:00.000Z")); });
      writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
      const before = { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
      const records = readTheoRecords(ledger);
      expect(records.state).toBe("loaded");
      week(records);
      expect(readFileSync(path, "utf8")).toBe(before.text);
      expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
      expect(readdirSync(join(ledger, "theo"))).toEqual(["local.json"]);
      expect(readdirSync(ledger)).toEqual(["theo"]);

      writeFileSync(path, "{ not json");
      expect(readTheoRecords(ledger)).toEqual({ state: "unreadable" });
      writeFileSync(path, JSON.stringify({ schemaVersion: 0, proposals: [proposal(LOSSY, "2026-11-17T10:00:00.000Z")] }));
      expect(readTheoRecords(ledger)).toEqual({ state: "unreadable" });
    });
  });
});
