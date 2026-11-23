/**
 * What Theo did, for the weekly report: one or two plain lines under the
 * money statement.
 *
 * READ-ONLY. This reads Theo's own memory file (the JSON document his cycle
 * saves beside the ledger, `<ledger>/theo/local.json`) and nothing else. It
 * never starts a cycle, never writes, and never calls a provider.
 *
 * TWO KINDS OF NUMBER, NEVER MIXED. What Mesh saved is verified and is what
 * the fee is charged on; it comes from the ledger (report.ts). What Theo
 * proposes is not a saving until the user accepts it and the ledger records
 * it. Nothing here is ever added to the saved total, the "you keep" line,
 * the fee or the month so far: `summariseTheo` returns words and counts
 * beside the report and has no way to change a figure in it.
 *
 * WHICH STORED FIELDS ARE READ, and what each means (TheoMemory in
 * packages/sdk-js/src/theo-agent.ts):
 *
 *   log[].at             when a cycle ran. Counted to say how many times Theo
 *                        checked the traffic in the span.
 *   log[].autonomy,      the mode of each cycle and the current mode. If
 *   autonomy             "optimise" (auto-apply) appears anywhere, the report
 *                        does not say "you accepted", because it cannot know.
 *   proposals[].provenAt an open proposal: a change proved on the user's own
 *                        traffic that waits for a yes or no. Only counted.
 *   policy.levers[]      with class "lossy" and a `gate` proof: a change that
 *                        is live because it was accepted (or auto-applied).
 *   driftBaselines[id].at  when that change went live (the acceptance time).
 *   experiments[]        `ranAt`, `passed`, `savingPercent`, `note`: a test
 *                        that failed on quality is "held back"; a note that
 *                        starts "rolled back:" is a change switched off after
 *                        retries or failures rose.
 *
 * NO DOLLAR FIGURE FOR A PROPOSAL. A proposal stores `savingPercent`: the
 * saving measured on the sample of captured requests the replay gate
 * replayed. Theo does not record how many requests that sample held, what
 * share of the traffic it stands for, or a dollar amount, so it cannot be
 * turned into "about $X a week" without inventing a projection. The line
 * therefore carries no number. `theoLines` can print an estimate ("about $X
 * a week (estimated)") the day Theo records one; nothing feeds it today.
 *
 * NEVER COPIED: lever names, a proposal's message, the grader, the observed
 * workload line. The lines name no lever; the detail stays behind
 * `mesh theo --proposals` and `mesh report --detail`.
 *
 * Missing state means Theo has never run and the report says so. State that
 * is there but cannot be read (not JSON, an unknown format) says nothing:
 * better silent than a guess.
 */
import { existsSync, readFileSync } from "node:fs";

import { defaultTheoMemoryPath } from "../../sdk-js/src/theo-agent-store.js";
import { count, localDate, money, shortDate, type ReportLever, type ReportPeriod } from "./report.js";

/** Theo's records as found on disk. `memory` is untrusted: every field is checked before use. */
export type TheoRecords =
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "loaded"; memory: unknown };

/** Read Theo's memory for this ledger. Read-only; never throws. */
export function readTheoRecords(ledgerDir: string, customer = "local"): TheoRecords {
  const path = defaultTheoMemoryPath(ledgerDir, customer);
  if (!existsSync(path)) return { state: "missing" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(parsed) || parsed.schemaVersion !== 1) return { state: "unreadable" };
    return { state: "loaded", memory: parsed };
  } catch {
    return { state: "unreadable" };
  }
}

export type TheoEarning = {
  /** Accepted changes with a verified saving recorded against them in the span. */
  changes: number;
  /** That saving, from the ledger. Already inside the report's saved total. */
  savedUsd: number;
  /** The local date the change went live, when there is exactly one and the records give it. */
  acceptedOn: string | null;
  /** False when Theo's records show auto-apply was ever on, so the report cannot say who accepted. */
  acceptedByYou: boolean;
};

export type ReportTheo = {
  /** Did Theo run a cycle in the span, not run in it, or never run at all. */
  state: "ran" | "did_not_run" | "never_run";
  /** Theo's mode as his records give it. */
  mode: "observe" | "recommend" | "test" | "optimise" | "unknown";
  /** Cycles Theo ran in the span. */
  checks: number;
  /** Proposals waiting for the user's yes or no. */
  waitingProposals: number;
  /**
   * An ESTIMATE of what the waiting proposals would save a week, when Theo
   * recorded one. Always null today (see the note at the top of this file).
   * Never part of any saved, fee or month-so-far figure.
   */
  waitingEstimatedWeeklyUsd: number | null;
  earning: TheoEarning | null;
  /** Changes tested in the span and not offered because quality did not hold. */
  heldBack: number;
  /** Live changes switched back off in the span. */
  rolledBack: number;
  /** The one or two plain lines. */
  lines: string[];
};

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objects(value: unknown): Loose[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function instant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const MODES = ["observe", "recommend", "test", "optimise"] as const;

function mode(value: unknown): ReportTheo["mode"] {
  return (MODES as readonly unknown[]).includes(value) ? (value as ReportTheo["mode"]) : "unknown";
}

export type TheoFacts = Omit<ReportTheo, "lines">;

/**
 * The words. At most two lines, the most useful first: something that needs
 * a yes, then something already earning, then something held or rolled back;
 * and when there is none of those, one line saying Theo looked, did not run,
 * or has never run. No lever is named.
 */
export function theoLines(facts: TheoFacts, kind: "week" | "month"): string[] {
  const span = `this ${kind}`;
  const lines: string[] = [];
  if (facts.waitingProposals > 0) {
    const estimate = facts.waitingEstimatedWeeklyUsd;
    const one = facts.waitingProposals === 1;
    if (estimate !== null && Number.isFinite(estimate) && Math.round(estimate * 100) > 0) {
      lines.push(one
        ? `Theo, your token engineer, found a further saving of about ${money(estimate)} a week (estimated). It needs your OK: mesh theo --proposals`
        : `Theo, your token engineer, found ${count(facts.waitingProposals)} further savings of about ${money(estimate)} a week in total (estimated). They need your OK: mesh theo --proposals`);
    } else {
      lines.push(one
        ? "Theo, your token engineer, found a further saving that needs your OK: mesh theo --proposals"
        : `Theo, your token engineer, found ${count(facts.waitingProposals)} further savings that need your OK: mesh theo --proposals`);
    }
  }
  const earning = facts.earning;
  if (earning !== null) {
    const tail = `saved ${money(earning.savedUsd)} ${span} (verified, included above).`;
    if (!earning.acceptedByYou) {
      lines.push(earning.changes === 1
        ? `A change Theo proved on your traffic ${tail}`
        : `${count(earning.changes)} changes Theo proved on your traffic ${tail}`);
    } else if (earning.changes === 1) {
      lines.push(earning.acceptedOn === null
        ? `A change Theo proposed and you accepted ${tail}`
        : `A change Theo proposed and you accepted on ${shortDate(earning.acceptedOn)} ${tail}`);
    } else {
      lines.push(`${count(earning.changes)} changes Theo proposed and you accepted ${tail}`);
    }
  }
  if (facts.rolledBack > 0) {
    lines.push("Theo switched a change back off because it stopped proving safe on your traffic.");
  }
  if (facts.heldBack > 0) {
    lines.push("Theo tested a change and held it back because it did not prove safe on your traffic.");
  }
  if (lines.length > 0) return lines.slice(0, 2);
  if (facts.state === "never_run") return ["Theo, your token engineer, has not run yet."];
  if (facts.state === "did_not_run") return [`Theo, your token engineer, did not run ${span}.`];
  return [
    `Theo, your token engineer, checked your traffic ${facts.checks === 1 ? "once" : `${count(facts.checks)} times`} ${span} and found nothing more worth changing.`,
  ];
}

/**
 * Theo's part of a report, from his records and the span's verified lever
 * lines. Pure. Returns null when the records cannot be read, so the report
 * says nothing rather than guess.
 */
export function summariseTheo(
  records: TheoRecords,
  context: { period: ReportPeriod; levers: readonly ReportLever[]; now: Date },
): ReportTheo | null {
  const kind = context.period.kind;
  if (records.state === "unreadable") return null;
  if (records.state === "missing") {
    const facts: TheoFacts = {
      state: "never_run",
      mode: "unknown",
      checks: 0,
      waitingProposals: 0,
      waitingEstimatedWeeklyUsd: null,
      earning: null,
      heldBack: 0,
      rolledBack: 0,
    };
    return { ...facts, lines: theoLines(facts, kind) };
  }
  if (!isObject(records.memory)) return null;
  const memory = records.memory;
  const startMs = Date.parse(context.period.startsAt);
  const endMs = Date.parse(context.period.endsBefore);
  const inSpan = (at: number | undefined): boolean => at !== undefined && at >= startMs && at < endMs;

  const log = objects(memory.log);
  const checks = log.filter((entry) => inSpan(instant(entry.at))).length;
  // Auto-apply ("optimise") anywhere in the records: a live change may not have been the user's own yes.
  const autoApplySeen = memory.autonomy === "optimise" || log.some((entry) => entry.autonomy === "optimise");

  // Open proposals that existed by the end of the span.
  const waitingProposals = objects(memory.proposals).filter((proposal) => {
    const provenAt = instant(proposal.provenAt);
    return provenAt !== undefined && provenAt < endMs;
  }).length;

  // Changes that are live with a proof, and when each went live.
  const baselines = isObject(memory.driftBaselines) ? memory.driftBaselines : {};
  const live = new Map<string, number | undefined>();
  for (const lever of objects(isObject(memory.policy) ? memory.policy.levers : undefined)) {
    if (lever.class !== "lossy" || !isObject(lever.gate) || typeof lever.lever !== "string") continue;
    const baseline = baselines[lever.lever];
    live.set(lever.lever, isObject(baseline) ? instant(baseline.at) : undefined);
  }
  // Only what the ledger records against that change in the span: a verified
  // lossy line carrying a proof from Theo's gate. It is already in the total.
  let earningUsd = 0;
  let earningChanges = 0;
  let acceptedAt: number | undefined;
  for (const [lever, wentLiveAt] of live) {
    if (wentLiveAt !== undefined && wentLiveAt >= endMs) continue;
    const saved = context.levers
      .filter((line) => line.lever === lever && line.kind === "lossy" && line.provenByTheo === true)
      .reduce((sum, line) => sum + line.savedUsd, 0);
    if (Math.round(saved * 100) <= 0) continue;
    earningUsd += saved;
    earningChanges += 1;
    acceptedAt = wentLiveAt;
  }
  const earning: TheoEarning | null = earningChanges === 0 ? null : {
    changes: earningChanges,
    savedUsd: earningUsd,
    acceptedOn: earningChanges === 1 && acceptedAt !== undefined ? localDate(acceptedAt, context.period.timeZone) : null,
    acceptedByYou: !autoApplySeen,
  };

  let heldBack = 0;
  let rolledBack = 0;
  for (const experiment of objects(memory.experiments)) {
    if (experiment.passed !== false || !inSpan(instant(experiment.ranAt))) continue;
    if (typeof experiment.note === "string" && experiment.note.startsWith("rolled back:")) rolledBack += 1;
    // A test that saved money but failed is one that did not hold quality.
    else if (typeof experiment.savingPercent === "number" && experiment.savingPercent > 0) heldBack += 1;
  }

  const facts: TheoFacts = {
    state: checks > 0 ? "ran" : log.length === 0 && instant(memory.updatedAt) === undefined ? "never_run" : "did_not_run",
    mode: mode(memory.autonomy),
    checks,
    waitingProposals,
    // No stored field gives a dollar figure or what the gate's sample covered.
    waitingEstimatedWeeklyUsd: null,
    earning,
    heldBack,
    rolledBack,
  };
  return { ...facts, lines: theoLines(facts, kind) };
}
