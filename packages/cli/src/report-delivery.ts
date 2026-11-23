/**
 * How the weekly report reaches the user, with no account and no email.
 * Everything here is local: files under the Mesh home and, once a week, one
 * desktop notification. There is no network call.
 *
 *   Weekly, on by default.  While Mesh runs (the installed service, or
 *     `mesh start` / `mesh proxy`), `startWeeklyReportSchedule` checks about
 *     hourly. The first time it is past Monday 08:00 local and the last full
 *     week has not been delivered, it writes the page to
 *     ~/.mesh/reports/<monday>.html (the last 12 are kept) and shows ONE
 *     desktop notification with the one-line report. It never opens a
 *     window, never throws, never blocks the proxy and never retries: the
 *     week is recorded as delivered before the notification is attempted.
 *
 *   Once, in a terminal.  The first `mesh` command after a new week's report
 *     is due prints the one-line report to stderr, once
 *     (`announceInTerminal`). `mesh start` and `mesh proxy` print it as
 *     their first line (`startBannerLine`).
 *
 * The state file, ~/.mesh/report-state.json, records what was delivered and
 * shown, and holds the on/off switch (`mesh report --off` / `--on`).
 *
 * The decisions are pure functions with an injected clock
 * (`decideWeeklyDelivery`, `decideTerminalLine`); the rest is the thin part
 * that reads the ledger, writes the page and calls the notifier.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  buildWeeklyReport,
  localDate,
  localHour,
  localTimeZone,
  mondayOf,
  readReportSpools,
  reportOneLine,
  weekPeriod,
  type Report,
  type ReportPeriod,
} from "./report.js";
import { renderReportHtml } from "./report-html.js";
import { readTheoRecords } from "./report-theo.js";

/** The user's Mesh home. A function, so nothing is fixed when the module loads. */
export function defaultMeshHome(): string {
  return join(homedir(), ".mesh");
}

// ---------------------------------------------------------------------------
// The state file
// ---------------------------------------------------------------------------

export const REPORT_STATE_SCHEMA = "mesh-report-state/1";

export type ReportState = {
  schema: typeof REPORT_STATE_SCHEMA;
  /** The switch: "off" silences the weekly notification and the once-a-week terminal line. */
  notifications: "on" | "off";
  /** When this state file was first written: the report says nothing about weeks that ended before it. */
  firstSeenAt?: string;
  /** The Monday (YYYY-MM-DD) of the last week delivered as a page and a notification. */
  deliveredWeek?: string;
  deliveredAt?: string;
  /** The Monday of the last week whose one line was shown in a terminal. */
  terminalWeek?: string;
  terminalAt?: string;
};

export function reportStatePath(meshHome: string): string {
  return join(meshHome, "report-state.json");
}

export function reportsDir(meshHome: string): string {
  return join(meshHome, "reports");
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/;

/** Read the state. A missing or unreadable file is the default state: on, nothing delivered. */
export function readReportState(meshHome: string): ReportState {
  const state: ReportState = { schema: REPORT_STATE_SCHEMA, notifications: "on" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(reportStatePath(meshHome), "utf8"));
  } catch {
    return state;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return state;
  const stored = raw as Record<string, unknown>;
  if (stored.notifications === "off") state.notifications = "off";
  const date = (value: unknown): string | undefined => (typeof value === "string" && DATE.test(value) ? value : undefined);
  const time = (value: unknown): string | undefined => (typeof value === "string" && ISO.test(value) ? value : undefined);
  const firstSeenAt = time(stored.firstSeenAt);
  const deliveredWeek = date(stored.deliveredWeek);
  const deliveredAt = time(stored.deliveredAt);
  const terminalWeek = date(stored.terminalWeek);
  const terminalAt = time(stored.terminalAt);
  if (firstSeenAt !== undefined) state.firstSeenAt = firstSeenAt;
  if (deliveredWeek !== undefined) state.deliveredWeek = deliveredWeek;
  if (deliveredAt !== undefined) state.deliveredAt = deliveredAt;
  if (terminalWeek !== undefined) state.terminalWeek = terminalWeek;
  if (terminalAt !== undefined) state.terminalAt = terminalAt;
  return state;
}

/** Write the state through a temporary file, so a reader never sees half of it. */
export function writeReportState(meshHome: string, state: ReportState): void {
  mkdirSync(meshHome, { recursive: true });
  const path = reportStatePath(meshHome);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Re-read, change, write: so two processes each keep the other's fields. */
function updateReportState(meshHome: string, now: Date, change: (state: ReportState) => void): ReportState {
  const state = readReportState(meshHome);
  if (state.firstSeenAt === undefined) state.firstSeenAt = now.toISOString();
  change(state);
  writeReportState(meshHome, state);
  return state;
}

/** `mesh report --off` / `--on`. */
export function setReportNotifications(meshHome: string, value: "on" | "off", now: Date = new Date()): ReportState {
  return updateReportState(meshHome, now, (state) => { state.notifications = value; });
}

// ---------------------------------------------------------------------------
// The decisions (pure)
// ---------------------------------------------------------------------------

/** The hour on Monday, local time, from which last week's report is due. */
export const DUE_HOUR = 8;

/**
 * The week whose report is due: the last full week, once it is Monday 08:00
 * local or later. Before that on a Monday, nothing is due yet. Only ever the
 * latest week: a machine that was off for three weeks is not owed three.
 */
export function dueWeek(now: Date, timeZone: string): ReportPeriod | undefined {
  const today = localDate(now.getTime(), timeZone);
  if (today === mondayOf(today) && localHour(now.getTime(), timeZone) < DUE_HOUR) return undefined;
  return weekPeriod("last", now, timeZone);
}

export type DeliveryDecision =
  | { deliver: true; week: ReportPeriod }
  | { deliver: false; reason: "switched_off" | "before_monday_morning" | "already_delivered" };

/** Should the weekly page and notification go out now? Pure. */
export function decideWeeklyDelivery(input: { now: Date; timeZone: string; state: ReportState }): DeliveryDecision {
  if (input.state.notifications === "off") return { deliver: false, reason: "switched_off" };
  const week = dueWeek(input.now, input.timeZone);
  if (week === undefined) return { deliver: false, reason: "before_monday_morning" };
  // Delivered for this week or a later one (a clock set back must not repeat an old week).
  if (input.state.deliveredWeek !== undefined && input.state.deliveredWeek >= week.id) {
    return { deliver: false, reason: "already_delivered" };
  }
  return { deliver: true, week };
}

/** Commands that never get the once-a-week line: the report itself, and ones that own their output. */
const NO_TERMINAL_LINE = new Set(["report", "statusline", "start", "proxy", "serve"]);

export type TerminalDecision =
  | { show: true; week: ReportPeriod }
  | { show: false; reason: "json" | "not_a_terminal" | "command_excluded" | "switched_off" | "before_monday_morning" | "already_shown" };

/** Should this `mesh` command print the one-line report first? Pure. */
export function decideTerminalLine(input: {
  now: Date;
  timeZone: string;
  state: ReportState;
  /** The `mesh` subcommand, if any. */
  command: string | undefined;
  json: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
}): TerminalDecision {
  if (input.json) return { show: false, reason: "json" };
  if (!input.stdoutIsTTY || !input.stderrIsTTY) return { show: false, reason: "not_a_terminal" };
  if (input.command !== undefined && NO_TERMINAL_LINE.has(input.command)) return { show: false, reason: "command_excluded" };
  if (input.state.notifications === "off") return { show: false, reason: "switched_off" };
  const week = dueWeek(input.now, input.timeZone);
  if (week === undefined) return { show: false, reason: "before_monday_morning" };
  if (input.state.terminalWeek !== undefined && input.state.terminalWeek >= week.id) return { show: false, reason: "already_shown" };
  return { show: true, week };
}

/**
 * Is this report worth telling the user about unasked? Everything is, except
 * "no requests" for a week that ended before Mesh was first seen on this
 * machine: a fresh install is not "not connected" for the week before it.
 */
export function worthAnnouncing(report: Report, state: ReportState): boolean {
  if (report.case !== "no_requests") return true;
  return state.firstSeenAt !== undefined && state.firstSeenAt < report.period.endsBefore;
}

// ---------------------------------------------------------------------------
// The desktop notification
// ---------------------------------------------------------------------------

export type NotifyResult = {
  /** What was used. "none" when this platform has no notifier or it is switched off. */
  via: "osascript" | "notify-send" | "none";
  ok: boolean;
  exitCode: number | null;
};

/** Shows one desktop notification. Resolves whatever happens; never rejects. */
export type Notifier = (title: string, text: string) => Promise<NotifyResult>;

function run(command: string, args: string[], via: NotifyResult["via"]): Promise<NotifyResult> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: 10_000, windowsHide: true }, (error) => {
        if (error === null) { resolve({ via, ok: true, exitCode: 0 }); return; }
        const code = (error as NodeJS.ErrnoException).code;
        // The program is not installed: there is no notifier here.
        if (code === "ENOENT") { resolve({ via: "none", ok: false, exitCode: null }); return; }
        resolve({ via, ok: false, exitCode: typeof code === "number" ? code : null });
      });
    } catch {
      resolve({ via: "none", ok: false, exitCode: null });
    }
  });
}

/**
 * The notifier for this platform: macOS through `osascript`
 * (`display notification`), Linux through `notify-send` when it is installed,
 * otherwise nothing. The text is passed as an argument, never spliced into a
 * script. `MESH_NO_NOTIFY` set to anything switches it off (the page is still
 * written), for servers, CI and tests.
 */
export function desktopNotifier(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): Notifier {
  const none: Notifier = () => Promise.resolve({ via: "none", ok: false, exitCode: null });
  if (env.MESH_NO_NOTIFY !== undefined && env.MESH_NO_NOTIFY !== "") return none;
  if (platform === "darwin") {
    return (title, text) => run("osascript", [
      "-e", "on run argv",
      "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e", "end run",
      text, title,
    ], "osascript");
  }
  if (platform === "linux") {
    return (title, text) => run("notify-send", ["--app-name=Mesh", title, text], "notify-send");
  }
  return none;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryOptions = {
  /** Default ~/.mesh. */
  meshHome?: string;
  /** Default <meshHome>/ledger. */
  ledgerDir?: string;
  now?: Date;
  timeZone?: string;
  /** Injected in tests. Default: this platform's notifier. */
  notify?: Notifier;
};

export type DeliveryResult =
  | { delivered: false; reason: "switched_off" | "before_monday_morning" | "already_delivered" }
  | { delivered: false; reason: "nothing_to_report"; week: string }
  | {
      delivered: true;
      /** The Monday of the week delivered. */
      week: string;
      /** The page written. */
      page: string;
      /** The one line shown in the notification. */
      text: string;
      notification: NotifyResult;
    };

/** How many weekly pages are kept. */
export const REPORTS_KEPT = 12;

/** Write a week's page and drop all but the newest `REPORTS_KEPT` weekly pages. Returns the path. */
export function writeWeeklyPage(meshHome: string, report: Report): string {
  const directory = reportsDir(meshHome);
  mkdirSync(directory, { recursive: true });
  const page = join(directory, `${report.period.id}.html`);
  writeFileSync(page, renderReportHtml(report));
  const weekly = readdirSync(directory).filter((file) => /^\d{4}-\d{2}-\d{2}\.html$/.test(file)).sort();
  for (const old of weekly.slice(0, Math.max(0, weekly.length - REPORTS_KEPT))) {
    try { unlinkSync(join(directory, old)); } catch { /* an old page that will not go is not worth failing for */ }
  }
  return page;
}

function buildWeek(options: DeliveryOptions, meshHome: string, now: Date, timeZone: string, week: ReportPeriod): Report {
  const ledgerDir = options.ledgerDir ?? join(meshHome, "ledger");
  return buildWeeklyReport({
    spools: readReportSpools(ledgerDir),
    now,
    timeZone,
    week: { date: week.id },
    theo: readTheoRecords(ledgerDir),
  });
}

/**
 * One check, as the schedule runs it: if last week's report is due and not
 * yet delivered, write the page and show one notification. The week is
 * recorded as delivered BEFORE the notification is attempted, so a notifier
 * that fails is never tried again for that week.
 */
export async function deliverWeeklyReportIfDue(options: DeliveryOptions = {}): Promise<DeliveryResult> {
  const meshHome = options.meshHome ?? defaultMeshHome();
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? localTimeZone();
  // The cheap part first: the small state file decides whether the ledger is read at all.
  const state = existsSync(reportStatePath(meshHome))
    ? readReportState(meshHome)
    : updateReportState(meshHome, now, () => {});
  const decision = decideWeeklyDelivery({ now, timeZone, state });
  if (!decision.deliver) return { delivered: false, reason: decision.reason };

  const report = buildWeek(options, meshHome, now, timeZone, decision.week);
  const mark = (): void => {
    updateReportState(meshHome, now, (current) => {
      current.deliveredWeek = decision.week.id;
      current.deliveredAt = now.toISOString();
    });
  };
  if (!worthAnnouncing(report, state)) {
    mark();
    return { delivered: false, reason: "nothing_to_report", week: decision.week.id };
  }
  const page = writeWeeklyPage(meshHome, report);
  const text = reportOneLine(report, { detailsCommand: "mesh report --open" });
  mark();
  const notify = options.notify ?? desktopNotifier();
  let notification: NotifyResult;
  try {
    notification = await notify("Mesh", text);
  } catch {
    notification = { via: "none", ok: false, exitCode: null };
  }
  return { delivered: true, week: decision.week.id, page, text, notification };
}

export type ScheduleOptions = DeliveryOptions & {
  /** Delay before the first check. Default one minute. */
  firstCheckMs?: number;
  /** Time between checks. Default one hour. */
  intervalMs?: number;
  /** Told when a report was delivered. Money never goes to a log through here: only the week and how it went. */
  onDelivered?: (line: string) => void;
};

/**
 * Check about hourly for as long as the process runs. The timers do not keep
 * the process alive, a check never overlaps the one before, and nothing a
 * check does can throw into the caller. Returns a stop function.
 */
export function startWeeklyReportSchedule(options: ScheduleOptions = {}): () => void {
  let running = false;
  const check = (): void => {
    if (running) return;
    running = true;
    // `now` is read at each check unless a test pins it.
    void deliverWeeklyReportIfDue(options)
      .then((result) => {
        if (result.delivered) {
          options.onDelivered?.(
            `weekly report for the week of ${result.week} written; notification ${result.notification.ok ? `shown (${result.notification.via})` : "not shown"}`,
          );
        }
      })
      .catch(() => { /* a report must never take the proxy down */ })
      .finally(() => { running = false; });
  };
  const first = setTimeout(check, options.firstCheckMs ?? 60_000);
  const every = setInterval(check, options.intervalMs ?? 60 * 60_000);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

// ---------------------------------------------------------------------------
// The terminal
// ---------------------------------------------------------------------------

type StreamLike = { isTTY?: boolean; write?: (text: string) => unknown };

export type TerminalOptions = DeliveryOptions & {
  stdout?: StreamLike;
  stderr?: StreamLike;
};

/**
 * Called by both entry points before a command runs. The first time any
 * `mesh` command runs in a terminal after a new week's report is due, print
 * the one-line report to stderr and record that it was shown. Never in
 * `--json` mode, never when stdout or stderr is not a terminal, never for
 * `mesh report` or `mesh statusline`. Never throws. Returns the line printed.
 */
export function announceInTerminal(argv: readonly string[], options: TerminalOptions = {}): string | undefined {
  try {
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const meshHome = options.meshHome ?? defaultMeshHome();
    const now = options.now ?? new Date();
    const timeZone = options.timeZone ?? localTimeZone();
    const facts = {
      now,
      timeZone,
      command: argv[0],
      json: argv.includes("--json"),
      stdoutIsTTY: stdout.isTTY === true,
      stderrIsTTY: stderr.isTTY === true,
    };
    // Decide what can be decided without touching the disk first.
    const early = decideTerminalLine({ ...facts, state: { schema: REPORT_STATE_SCHEMA, notifications: "on" } });
    if (!early.show) return undefined;
    const state = existsSync(reportStatePath(meshHome))
      ? readReportState(meshHome)
      : updateReportState(meshHome, now, () => {});
    const decision = decideTerminalLine({ ...facts, state });
    if (!decision.show) return undefined;
    const report = buildWeek(options, meshHome, now, timeZone, decision.week);
    updateReportState(meshHome, now, (current) => {
      current.terminalWeek = decision.week.id;
      current.terminalAt = now.toISOString();
    });
    if (!worthAnnouncing(report, state)) return undefined;
    const line = reportOneLine(report);
    stderr.write?.(`${line}\n`);
    return line;
  } catch {
    return undefined;
  }
}

/**
 * The first line `mesh start` and `mesh proxy` print: the one-line report
 * for the last full week. Nothing when the reports are switched off, when
 * there is nothing worth saying, or when there were no requests (someone
 * starting Mesh is connecting it now, so "not connected" would be wrong).
 * Records the week as shown when stdout is a terminal. Never throws.
 */
export function startBannerLine(options: TerminalOptions = {}): string | undefined {
  try {
    const stdout = options.stdout ?? process.stdout;
    const meshHome = options.meshHome ?? defaultMeshHome();
    const now = options.now ?? new Date();
    const timeZone = options.timeZone ?? localTimeZone();
    const state = existsSync(reportStatePath(meshHome))
      ? readReportState(meshHome)
      : updateReportState(meshHome, now, () => {});
    if (state.notifications === "off") return undefined;
    const week = weekPeriod("last", now, timeZone);
    const report = buildWeek(options, meshHome, now, timeZone, week);
    if (report.case === "no_requests") return undefined;
    if (stdout.isTTY === true && (state.terminalWeek === undefined || state.terminalWeek < week.id)) {
      updateReportState(meshHome, now, (current) => {
        current.terminalWeek = week.id;
        current.terminalAt = now.toISOString();
      });
    }
    return reportOneLine(report);
  } catch {
    return undefined;
  }
}
