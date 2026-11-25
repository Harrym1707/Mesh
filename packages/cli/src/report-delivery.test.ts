/**
 * How the weekly report reaches the user: the scheduling decision, the page
 * and notification, the once-only terminal line, and the switch.
 *
 * Every test uses a temporary Mesh home and an injected notifier. No test
 * shows a real desktop notification or reads the real ~/.mesh.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chainLedgerRecord, type BillableEvent, type LedgerRecord } from "../../core/src/savings-ledger.js";
import {
  REPORTS_KEPT,
  REPORT_STATE_SCHEMA,
  announceInTerminal,
  decideTerminalLine,
  decideWeeklyDelivery,
  deliverWeeklyReportIfDue,
  desktopNotifier,
  readReportState,
  reportStatePath,
  reportsDir,
  setReportNotifications,
  startBannerLine,
  startWeeklyReportSchedule,
  writeReportState,
  type Notifier,
  type ReportState,
} from "./report-delivery.js";

const ZONE = "America/Los_Angeles";
/** Monday 23 Nov 2026 in Los Angeles: 07:59 is 15:59 UTC, 08:00 is 16:00 UTC. */
const MONDAY_0759 = new Date("2026-11-23T15:59:00.000Z");
const MONDAY_0800 = new Date("2026-11-23T16:00:00.000Z");
const THURSDAY = new Date("2026-11-26T20:00:00.000Z");

const state = (fields: Partial<ReportState> = {}): ReportState => ({ schema: REPORT_STATE_SCHEMA, notifications: "on", ...fields });

describe("when the weekly report is due (a pure decision)", () => {
  it("before Monday 08:00 local: nothing yet", () => {
    expect(decideWeeklyDelivery({ now: MONDAY_0759, timeZone: ZONE, state: state() })).toEqual({ deliver: false, reason: "before_monday_morning" });
    // Monday 00:05 local, too.
    expect(decideWeeklyDelivery({ now: new Date("2026-11-23T08:05:00.000Z"), timeZone: ZONE, state: state() }))
      .toEqual({ deliver: false, reason: "before_monday_morning" });
  });

  it("from Monday 08:00 local: the last full week", () => {
    const decision = decideWeeklyDelivery({ now: MONDAY_0800, timeZone: ZONE, state: state() });
    expect(decision).toMatchObject({ deliver: true, week: { id: "2026-11-16", label: "16 to 22 Nov", finished: true } });
    // The instant that is Monday 07:59 in Los Angeles is already Tuesday in Tokyo: there it is due.
    expect(decideWeeklyDelivery({ now: MONDAY_0759, timeZone: "Asia/Tokyo", state: state() })).toMatchObject({ deliver: true, week: { id: "2026-11-16" } });
  });

  it("already delivered: nothing, for the rest of the week", () => {
    const delivered = state({ deliveredWeek: "2026-11-16" });
    for (const now of [MONDAY_0800, THURSDAY, new Date("2026-11-30T07:00:00.000Z")]) {
      expect(decideWeeklyDelivery({ now, timeZone: ZONE, state: delivered })).toEqual({ deliver: false, reason: "already_delivered" });
    }
    // The next Monday morning, the next week is due.
    expect(decideWeeklyDelivery({ now: new Date("2026-11-30T16:00:00.000Z"), timeZone: ZONE, state: delivered }))
      .toMatchObject({ deliver: true, week: { id: "2026-11-23" } });
  });

  it("switched off: nothing, whatever the day", () => {
    for (const now of [MONDAY_0759, MONDAY_0800, THURSDAY]) {
      expect(decideWeeklyDelivery({ now, timeZone: ZONE, state: state({ notifications: "off" }) })).toEqual({ deliver: false, reason: "switched_off" });
    }
  });

  it("a machine asleep for three weeks is owed only the latest week", () => {
    const decision = decideWeeklyDelivery({ now: THURSDAY, timeZone: ZONE, state: state({ deliveredWeek: "2026-10-26" }) });
    expect(decision).toMatchObject({ deliver: true, week: { id: "2026-11-16" } });
  });

  it("a machine that was off on Monday delivers when it is next on that week", () => {
    expect(decideWeeklyDelivery({ now: THURSDAY, timeZone: ZONE, state: state({ deliveredWeek: "2026-11-09" }) }))
      .toMatchObject({ deliver: true, week: { id: "2026-11-16" } });
  });

  it("a clock set back does not repeat an older week", () => {
    expect(decideWeeklyDelivery({ now: new Date("2026-11-12T20:00:00.000Z"), timeZone: ZONE, state: state({ deliveredWeek: "2026-11-16" }) }))
      .toEqual({ deliver: false, reason: "already_delivered" });
  });
});

describe("the once-a-week line in a terminal (a pure decision)", () => {
  const base = { now: THURSDAY, timeZone: ZONE, state: state(), command: "status", json: false, stdoutIsTTY: true, stderrIsTTY: true };
  it("shows for any command in a terminal, once the week is due", () => {
    expect(decideTerminalLine(base)).toMatchObject({ show: true, week: { id: "2026-11-16" } });
    expect(decideTerminalLine({ ...base, command: undefined })).toMatchObject({ show: true });
    expect(decideTerminalLine({ ...base, command: "setup" })).toMatchObject({ show: true });
  });
  it("never in JSON mode, never when stdout or stderr is not a terminal", () => {
    expect(decideTerminalLine({ ...base, json: true })).toEqual({ show: false, reason: "json" });
    expect(decideTerminalLine({ ...base, stdoutIsTTY: false })).toEqual({ show: false, reason: "not_a_terminal" });
    expect(decideTerminalLine({ ...base, stderrIsTTY: false })).toEqual({ show: false, reason: "not_a_terminal" });
  });
  it("never for mesh report or mesh statusline, nor for the commands that print it themselves", () => {
    for (const command of ["report", "statusline", "start", "proxy", "serve"]) {
      expect(decideTerminalLine({ ...base, command })).toEqual({ show: false, reason: "command_excluded" });
    }
  });
  it("not twice, not when switched off, not before Monday 08:00", () => {
    expect(decideTerminalLine({ ...base, state: state({ terminalWeek: "2026-11-16" }) })).toEqual({ show: false, reason: "already_shown" });
    expect(decideTerminalLine({ ...base, state: state({ notifications: "off" }) })).toEqual({ show: false, reason: "switched_off" });
    expect(decideTerminalLine({ ...base, now: MONDAY_0759 })).toEqual({ show: false, reason: "before_monday_morning" });
  });
});

let counter = 0;
function event(timestamp: string, paid: number, saved: number): BillableEvent {
  counter += 1;
  return {
    schemaVersion: 1,
    requestId: `delivery-req-${counter}`,
    applicationId: "app",
    invoicePeriod: timestamp.slice(0, 7),
    timestamp,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    executionMode: "standard",
    pricingStatus: "priced",
    actualUsd: paid,
    levers: saved === 0 ? [] : [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd: saved }],
    status: "succeeded",
  };
}

function writeLedger(home: string, events: BillableEvent[]): void {
  const ledger = join(home, "ledger");
  mkdirSync(ledger, { recursive: true });
  const records: LedgerRecord[] = [];
  for (const item of events) records.push(chainLedgerRecord(item, records[records.length - 1]));
  writeFileSync(join(ledger, "app-anthropic.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

/** A notifier that records what it was asked to show and shows nothing. */
function recorder(result: Awaited<ReturnType<Notifier>> = { via: "osascript", ok: true, exitCode: 0 }): { notify: Notifier; calls: { title: string; text: string }[] } {
  const calls: { title: string; text: string }[] = [];
  return { calls, notify: (title, text) => { calls.push({ title, text }); return Promise.resolve(result); } };
}

describe("delivery", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mesh-report-delivery-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const lastWeek = (): BillableEvent[] => [event("2026-11-18T18:00:00.000Z", 412.10, 86.20), event("2026-11-19T18:00:00.000Z", 0, 0)];

  it("writes the page, shows one notification, records it, and does not do it twice", async () => {
    writeLedger(home, lastWeek());
    const { notify, calls } = recorder();
    const first = await deliverWeeklyReportIfDue({ meshHome: home, now: MONDAY_0800, timeZone: ZONE, notify });
    expect(first).toEqual({
      delivered: true,
      week: "2026-11-16",
      page: join(reportsDir(home), "2026-11-16.html"),
      text: "Mesh saved you $86.20 last week (fee $0.86). Details: mesh report --open",
      notification: { via: "osascript", ok: true, exitCode: 0 },
    });
    expect(calls).toEqual([{ title: "Mesh", text: "Mesh saved you $86.20 last week (fee $0.86). Details: mesh report --open" }]);
    expect(readFileSync(first.delivered ? first.page : "", "utf8")).toContain("Mesh saved you");
    expect(readReportState(home)).toMatchObject({ notifications: "on", deliveredWeek: "2026-11-16", deliveredAt: MONDAY_0800.toISOString() });

    for (const now of [MONDAY_0800, THURSDAY]) {
      expect(await deliverWeeklyReportIfDue({ meshHome: home, now, timeZone: ZONE, notify })).toEqual({ delivered: false, reason: "already_delivered" });
    }
    expect(calls).toHaveLength(1);
    expect(readdirSync(reportsDir(home))).toEqual(["2026-11-16.html"]);
  });

  it("before Monday 08:00: no page, no notification", async () => {
    writeLedger(home, lastWeek());
    const { notify, calls } = recorder();
    expect(await deliverWeeklyReportIfDue({ meshHome: home, now: MONDAY_0759, timeZone: ZONE, notify })).toEqual({ delivered: false, reason: "before_monday_morning" });
    expect(calls).toEqual([]);
    expect(existsSync(reportsDir(home))).toBe(false);
  });

  it("switched off: the schedule does nothing at all", async () => {
    writeLedger(home, lastWeek());
    setReportNotifications(home, "off", MONDAY_0759);
    const before = readFileSync(reportStatePath(home), "utf8");
    const { notify, calls } = recorder();
    expect(await deliverWeeklyReportIfDue({ meshHome: home, now: THURSDAY, timeZone: ZONE, notify })).toEqual({ delivered: false, reason: "switched_off" });
    expect(calls).toEqual([]);
    expect(existsSync(reportsDir(home))).toBe(false);
    expect(readFileSync(reportStatePath(home), "utf8")).toBe(before);
    // Back on: it is delivered.
    setReportNotifications(home, "on", THURSDAY);
    expect((await deliverWeeklyReportIfDue({ meshHome: home, now: THURSDAY, timeZone: ZONE, notify })).delivered).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("a notifier that fails or throws is not retried, and nothing is thrown", async () => {
    writeLedger(home, lastWeek());
    let attempts = 0;
    const failing: Notifier = () => { attempts += 1; return Promise.reject(new Error("no display")); };
    const result = await deliverWeeklyReportIfDue({ meshHome: home, now: MONDAY_0800, timeZone: ZONE, notify: failing });
    expect(result).toMatchObject({ delivered: true, notification: { via: "none", ok: false } });
    expect(await deliverWeeklyReportIfDue({ meshHome: home, now: THURSDAY, timeZone: ZONE, notify: failing })).toEqual({ delivered: false, reason: "already_delivered" });
    expect(attempts).toBe(1);
  });

  it("asleep for three weeks: one page and one notification, for the latest week", async () => {
    writeLedger(home, [event("2026-10-28T18:00:00.000Z", 10, 5), event("2026-11-04T18:00:00.000Z", 10, 6), event("2026-11-11T18:00:00.000Z", 10, 7), ...lastWeek()]);
    writeReportState(home, state({ firstSeenAt: "2026-10-01T00:00:00.000Z", deliveredWeek: "2026-10-19" }));
    const { notify, calls } = recorder();
    await deliverWeeklyReportIfDue({ meshHome: home, now: THURSDAY, timeZone: ZONE, notify });
    await deliverWeeklyReportIfDue({ meshHome: home, now: THURSDAY, timeZone: ZONE, notify });
    expect(calls.map((call) => call.text)).toEqual(["Mesh saved you $86.20 last week (fee $0.86). Details: mesh report --open"]);
    expect(readdirSync(reportsDir(home))).toEqual(["2026-11-16.html"]);
  });

  it("a fresh install is not told it was 'not connected' for the week before it existed", async () => {
    const { notify, calls } = recorder();
    expect(await deliverWeeklyReportIfDue({ meshHome: home, now: THURSDAY, timeZone: ZONE, notify })).toEqual({ delivered: false, reason: "nothing_to_report", week: "2026-11-16" });
    expect(calls).toEqual([]);
    expect(existsSync(reportsDir(home))).toBe(false);
    expect(readReportState(home)).toMatchObject({ firstSeenAt: THURSDAY.toISOString(), deliveredWeek: "2026-11-16" });
    // A week later, still no requests: now it is worth saying.
    const nextWeek = new Date("2026-12-03T20:00:00.000Z");
    const result = await deliverWeeklyReportIfDue({ meshHome: home, now: nextWeek, timeZone: ZONE, notify });
    expect(result).toMatchObject({ delivered: true, week: "2026-11-23" });
    expect(calls.map((call) => call.text)).toEqual([
      "Mesh saw no requests last week, so it is not connected. Fix: mesh setup. Report: mesh report --open",
    ]);
  });

  it("a ledger that does not verify: the notification says so and gives no figure", async () => {
    writeLedger(home, lastWeek());
    const path = join(home, "ledger", "app-anthropic.jsonl");
    writeFileSync(path, readFileSync(path, "utf8").replace("86.2", "986.2"));
    const { notify, calls } = recorder();
    await deliverWeeklyReportIfDue({ meshHome: home, now: THURSDAY, timeZone: ZONE, notify });
    expect(calls.map((call) => call.text)).toEqual([
      "Mesh could not verify your ledger last week, so there is no figure. Run: mesh verify. Report: mesh report --open",
    ]);
    expect(readFileSync(join(reportsDir(home), "2026-11-16.html"), "utf8")).not.toMatch(/\$\d/);
  });

  it(`keeps the last ${REPORTS_KEPT} weekly pages`, async () => {
    writeLedger(home, lastWeek());
    mkdirSync(reportsDir(home), { recursive: true });
    const old: string[] = [];
    for (let week = 1; week <= 15; week += 1) {
      const name = `2026-0${1 + Math.floor(week / 5)}-${String(week).padStart(2, "0")}.html`;
      old.push(name);
      writeFileSync(join(reportsDir(home), name), "old");
    }
    writeFileSync(join(reportsDir(home), "month-2026-10.html"), "a month page is not a weekly one");
    writeFileSync(join(reportsDir(home), "notes.txt"), "not ours");
    await deliverWeeklyReportIfDue({ meshHome: home, now: THURSDAY, timeZone: ZONE, notify: recorder().notify });
    const files = readdirSync(reportsDir(home)).sort();
    const weekly = files.filter((file) => /^\d{4}-\d{2}-\d{2}\.html$/.test(file));
    expect(weekly).toHaveLength(REPORTS_KEPT);
    expect(weekly.at(-1)).toBe("2026-11-16.html");
    expect(weekly).toEqual([...old.sort().slice(-(REPORTS_KEPT - 1)), "2026-11-16.html"]);
    expect(files).toContain("month-2026-10.html");
    expect(files).toContain("notes.txt");
  });

  it("the schedule checks, delivers once, and stops", async () => {
    writeLedger(home, lastWeek());
    const { notify, calls } = recorder();
    const lines: string[] = [];
    const stop = startWeeklyReportSchedule({
      meshHome: home,
      now: THURSDAY,
      timeZone: ZONE,
      notify,
      firstCheckMs: 5,
      intervalMs: 15,
      onDelivered: (line) => lines.push(line),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop();
    expect(calls).toHaveLength(1);
    expect(lines).toEqual(["weekly report for the week of 2026-11-16 written; notification shown (osascript)"]);
    // The line for the service log carries no money.
    expect(lines.join("")).not.toContain("$");
    const after = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toHaveLength(after);
  });

  it("a schedule pointed at a broken home never throws", async () => {
    const file = join(home, "not-a-directory");
    writeFileSync(file, "x");
    const stop = startWeeklyReportSchedule({ meshHome: join(file, "nested"), now: THURSDAY, timeZone: ZONE, notify: recorder().notify, firstCheckMs: 1, intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    await expect(deliverWeeklyReportIfDue({ meshHome: join(file, "nested"), now: THURSDAY, timeZone: ZONE, notify: recorder().notify })).rejects.toBeDefined();
  });

  describe("the terminal", () => {
    const terminal = (): { stream: { isTTY: boolean; write: (text: string) => void }; text: () => string } => {
      let written = "";
      return { stream: { isTTY: true, write: (text: string) => { written += text; } }, text: () => written };
    };

    it("prints the one line to stderr once, and not a second time", () => {
      writeLedger(home, lastWeek());
      writeReportState(home, state({ firstSeenAt: "2026-11-01T00:00:00.000Z" }));
      const out = terminal();
      const err = terminal();
      const options = { meshHome: home, now: THURSDAY, timeZone: ZONE, stdout: out.stream, stderr: err.stream };
      expect(announceInTerminal(["status"], options)).toBe("Mesh saved you $86.20 last week (fee $0.86). Details: mesh report");
      expect(err.text()).toBe("Mesh saved you $86.20 last week (fee $0.86). Details: mesh report\n");
      expect(out.text()).toBe("");
      expect(readReportState(home)).toMatchObject({ terminalWeek: "2026-11-16" });
      expect(announceInTerminal(["status"], options)).toBeUndefined();
      expect(announceInTerminal(["verify"], options)).toBeUndefined();
      expect(err.text().split("\n").filter((line) => line !== "")).toHaveLength(1);
      // The desktop delivery is a separate record: it still goes out once.
      expect(readReportState(home).deliveredWeek).toBeUndefined();
    });

    it("stays silent in JSON mode, off a terminal, for mesh report and statusline, and when switched off; and shows nothing as shown", () => {
      writeLedger(home, lastWeek());
      writeReportState(home, state({ firstSeenAt: "2026-11-01T00:00:00.000Z" }));
      const err = terminal();
      const tty = { isTTY: true, write: () => {} };
      const pipe = { isTTY: false, write: () => {} };
      const base = { meshHome: home, now: THURSDAY, timeZone: ZONE };
      expect(announceInTerminal(["status", "--json"], { ...base, stdout: tty, stderr: err.stream })).toBeUndefined();
      expect(announceInTerminal(["status"], { ...base, stdout: pipe, stderr: err.stream })).toBeUndefined();
      expect(announceInTerminal(["status"], { ...base, stdout: tty, stderr: { isTTY: false, write: err.stream.write } })).toBeUndefined();
      expect(announceInTerminal(["report"], { ...base, stdout: tty, stderr: err.stream })).toBeUndefined();
      expect(announceInTerminal(["report", "--detail"], { ...base, stdout: tty, stderr: err.stream })).toBeUndefined();
      expect(announceInTerminal(["statusline"], { ...base, stdout: tty, stderr: err.stream })).toBeUndefined();
      expect(err.text()).toBe("");
      expect(readReportState(home).terminalWeek).toBeUndefined();

      setReportNotifications(home, "off", THURSDAY);
      expect(announceInTerminal(["status"], { ...base, stdout: tty, stderr: err.stream })).toBeUndefined();
      expect(err.text()).toBe("");
      setReportNotifications(home, "on", THURSDAY);
      expect(announceInTerminal(["status"], { ...base, stdout: tty, stderr: err.stream })).toContain("Mesh saved you $86.20 last week");
    });

    it("a fresh install with no requests prints nothing, and never throws on a broken home", () => {
      const err = terminal();
      expect(announceInTerminal(["status"], { meshHome: home, now: THURSDAY, timeZone: ZONE, stdout: { isTTY: true }, stderr: err.stream })).toBeUndefined();
      expect(err.text()).toBe("");
      const file = join(home, "a-file");
      writeFileSync(file, "x");
      expect(announceInTerminal(["status"], { meshHome: join(file, "nested"), now: THURSDAY, timeZone: ZONE, stdout: { isTTY: true }, stderr: err.stream })).toBeUndefined();
    });

    it("mesh start and mesh proxy get the line as their banner; not when off, not when there were no requests", () => {
      writeLedger(home, lastWeek());
      const tty = { isTTY: true };
      expect(startBannerLine({ meshHome: home, now: THURSDAY, timeZone: ZONE, stdout: tty })).toBe(
        "Mesh saved you $86.20 last week (fee $0.86). Details: mesh report",
      );
      // Shown in a terminal: the next command does not repeat it.
      expect(readReportState(home).terminalWeek).toBe("2026-11-16");
      const err = terminal();
      expect(announceInTerminal(["status"], { meshHome: home, now: THURSDAY, timeZone: ZONE, stdout: tty, stderr: err.stream })).toBeUndefined();
      // It is a banner: every start prints it.
      expect(startBannerLine({ meshHome: home, now: THURSDAY, timeZone: ZONE, stdout: tty })).toContain("Mesh saved you $86.20");
      setReportNotifications(home, "off", THURSDAY);
      expect(startBannerLine({ meshHome: home, now: THURSDAY, timeZone: ZONE, stdout: tty })).toBeUndefined();

      const empty = mkdtempSync(join(tmpdir(), "mesh-report-empty-"));
      try {
        writeReportState(empty, state({ firstSeenAt: "2026-10-01T00:00:00.000Z" }));
        expect(startBannerLine({ meshHome: empty, now: THURSDAY, timeZone: ZONE, stdout: tty })).toBeUndefined();
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  it("the state file: defaults, the switch, and unreadable contents", () => {
    expect(readReportState(home)).toEqual({ schema: REPORT_STATE_SCHEMA, notifications: "on" });
    expect(setReportNotifications(home, "off", THURSDAY)).toEqual({ schema: REPORT_STATE_SCHEMA, notifications: "off", firstSeenAt: THURSDAY.toISOString() });
    expect(JSON.parse(readFileSync(reportStatePath(home), "utf8"))).toEqual({ schema: REPORT_STATE_SCHEMA, notifications: "off", firstSeenAt: THURSDAY.toISOString() });
    expect(setReportNotifications(home, "on", MONDAY_0800).notifications).toBe("on");
    expect(readReportState(home).firstSeenAt).toBe(THURSDAY.toISOString());
    writeFileSync(reportStatePath(home), "{ half a file");
    expect(readReportState(home)).toEqual({ schema: REPORT_STATE_SCHEMA, notifications: "on" });
    writeFileSync(reportStatePath(home), JSON.stringify({ notifications: "off", deliveredWeek: "not a date", terminalWeek: 7, firstSeenAt: "yesterday" }));
    expect(readReportState(home)).toEqual({ schema: REPORT_STATE_SCHEMA, notifications: "off" });
    // Only these files exist in the home.
    expect(readdirSync(home)).toEqual(["report-state.json"]);
  });
});

describe("the desktop notifier", () => {
  it("is nothing on a platform without one, and nothing when MESH_NO_NOTIFY is set", async () => {
    expect(await desktopNotifier("win32", {})("Mesh", "text")).toEqual({ via: "none", ok: false, exitCode: null });
    expect(await desktopNotifier("darwin", { MESH_NO_NOTIFY: "1" })("Mesh", "text")).toEqual({ via: "none", ok: false, exitCode: null });
    expect(await desktopNotifier("linux", { MESH_NO_NOTIFY: "1" })("Mesh", "text")).toEqual({ via: "none", ok: false, exitCode: null });
  });

  it("is switched off for the whole test run", () => {
    // vitest.config.ts sets MESH_NO_NOTIFY, so no test or subprocess can show a real notification.
    expect(process.env.MESH_NO_NOTIFY).toBe("1");
  });
});
