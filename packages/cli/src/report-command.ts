/**
 * `mesh report` — the weekly report, on demand.
 *
 * `collectReport` returns the report as data (what `--json` prints and what
 * the dashboard or an MCP server shows); it never prints, exits or writes.
 * `runReport` is the thin printer: text, JSON, the HTML page, and the on/off
 * switch for the weekly notification. No network call.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { CliError, meshIdentity, usageError, writeJson, type MeshIdentity } from "./json-output.js";
import {
  buildMonthReport,
  buildWeeklyReport,
  isCalendarDate,
  localTimeZone,
  readReportSpools,
  renderReport,
  reportHeadline,
  reportMonthLine,
  reportOneLine,
  type Report,
  type WeekChoice,
} from "./report.js";
import {
  defaultMeshHome,
  deliverWeeklyReportIfDue,
  readReportState,
  reportsDir,
  setReportNotifications,
  writeWeeklyPage,
  type DeliveryResult,
} from "./report-delivery.js";
import { renderReportHtml } from "./report-html.js";
import { readTheoRecords } from "./report-theo.js";
import { isPeriod } from "./statement.js";
import { isInteractive } from "./terminal.js";

export const REPORT_SCHEMA = "mesh-report/1";

/** What `collectReport` reads. Every default is this user's own ~/.mesh. */
export type ReportOptions = {
  meshHome?: string;
  /** Default <meshHome>/ledger. */
  ledgerDir?: string;
  /** The clock. Default: now. */
  now?: Date;
  /** The IANA zone a week's days are counted in. Default: this machine's. */
  timeZone?: string;
  /** Which week. Default: the last full week. */
  week?: WeekChoice;
  /** A billing month (YYYY-MM), or true for the current one. Replaces `week`. */
  month?: string | true;
};

/** The report with the words already made from it, as `--json` prints it. */
export type ReportResult = Report & {
  schema: typeof REPORT_SCHEMA;
  /** False only when the ledger does not verify (the case is then "not_verified"). */
  ok: boolean;
  mesh: MeshIdentity;
  /** The first screen: the money statement, one sentence a line. */
  headline: string[];
  /** "This month so far ..." in one line, or null. */
  monthLine: string | null;
  /** The one-line version, for a banner, a status line or a notification. */
  oneLine: string;
  /** Whether the weekly notification is switched on. */
  notifications: "on" | "off";
};

function resolveOptions(options: ReportOptions): { meshHome: string; ledgerDir: string; now: Date; timeZone: string } {
  const meshHome = options.meshHome ?? defaultMeshHome();
  return {
    meshHome,
    ledgerDir: options.ledgerDir ?? join(meshHome, "ledger"),
    now: options.now ?? new Date(),
    timeZone: options.timeZone ?? localTimeZone(),
  };
}

/**
 * The report as data. Reads the ledger and Theo's records, read-only, and
 * returns. Never prints, never exits, never writes a file.
 */
export function collectReport(options: ReportOptions = {}): ReportResult {
  const { meshHome, ledgerDir, now, timeZone } = resolveOptions(options);
  const spools = readReportSpools(ledgerDir);
  const theo = readTheoRecords(ledgerDir);
  const report = options.month !== undefined
    ? buildMonthReport({ spools, now, theo, ...(options.month === true ? {} : { period: options.month }) })
    : buildWeeklyReport({ spools, now, timeZone, theo, ...(options.week === undefined ? {} : { week: options.week }) });
  return {
    schema: REPORT_SCHEMA,
    ok: report.ledgerVerified,
    mesh: meshIdentity(),
    ...report,
    headline: reportHeadline(report),
    monthLine: reportMonthLine(report) ?? null,
    oneLine: reportOneLine(report),
    notifications: readReportState(meshHome).notifications,
  };
}

const USAGE = `Usage: mesh report [options]

What Mesh did for you last week, in money: what you paid your provider, what
it would have cost without Mesh, what Mesh saved, Mesh's fee on that, and
what you keep. Read from your own ledger. Nothing leaves this machine.

  (no option)        Last full week, Monday to Sunday in your time zone.
  --week YYYY-MM-DD  The week that date falls in.
  --this-week        This week so far (not finished, so it can still change).
  --month [YYYY-MM]  A billing month in the same plain style. Default: this month.
  --detail           Add the breakdown: per lever, per model, and the notes.
  --json             Print one JSON object (schema ${REPORT_SCHEMA}) instead of text.
  --html [path]      Write the report as one self-contained HTML page.
                     Default ~/.mesh/reports/<week start>.html.
  --open             Write that page and open it (in a terminal; otherwise
                     the path is printed).
  --off              Switch off the weekly desktop notification and the
                     once-a-week line in your terminal.
  --on               Switch them back on.
  --deliver          Run the weekly check now, as the background service does:
                     write the page and show the notification if one is due.
  --ledger <dir>     Ledger directory to read. Default ~/.mesh/ledger.
  --help             Show this message.

The figures are the bill's own arithmetic, the same as mesh statement. The
weekly fee is a guide: your invoice is the monthly statement, which rounds
down once on the month's total, so the two can differ by a few cents.

Exits 0 when the report could be made, including "no requests". Exits 1 when
the ledger does not verify (there is then no figure), the same with --json.`;

type Args = {
  week?: WeekChoice;
  month?: string | true;
  detail: boolean;
  json: boolean;
  html?: string | true;
  open: boolean;
  switchTo?: "on" | "off";
  deliver: boolean;
  ledgerDir?: string;
  help: boolean;
};

function parse(argv: readonly string[]): Args {
  const args: Args = { detail: false, json: false, open: false, deliver: false, help: false };
  /** The next argument, when it is a value and not another option. */
  const valueAfter = (index: number): string | undefined => {
    const next = argv[index + 1];
    return next === undefined || next.startsWith("--") ? undefined : next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    switch (key) {
      case "--help":
      case "-h": args.help = true; break;
      case "--json": args.json = true; break;
      case "--detail": args.detail = true; break;
      case "--this-week": args.week = "this"; break;
      case "--open": args.open = true; break;
      case "--off": args.switchTo = "off"; break;
      case "--on": args.switchTo = "on"; break;
      case "--deliver": args.deliver = true; break;
      case "--week": {
        const value = valueAfter(index);
        if (!isCalendarDate(value)) throw usageError("--week needs a date written YYYY-MM-DD, for example 2026-11-18.");
        args.week = { date: value };
        index += 1;
        break;
      }
      case "--month": {
        const value = valueAfter(index);
        if (value === undefined) { args.month = true; break; }
        if (!isPeriod(value)) throw usageError("--month must be a calendar month written YYYY-MM, for example 2026-11.");
        args.month = value;
        index += 1;
        break;
      }
      case "--html": {
        const value = valueAfter(index);
        if (value === undefined) { args.html = true; break; }
        args.html = resolve(value);
        index += 1;
        break;
      }
      case "--ledger": {
        const value = valueAfter(index);
        if (value === undefined) throw usageError("--ledger needs a value.");
        args.ledgerDir = resolve(value);
        index += 1;
        break;
      }
      default:
        throw usageError(`Unknown option: ${key}. See mesh report --help.`);
    }
  }
  const spans = (argv.includes("--week") ? 1 : 0) + (argv.includes("--this-week") ? 1 : 0) + (args.month !== undefined ? 1 : 0);
  if (spans > 1) throw usageError("Use one of --week, --this-week and --month at a time.");
  if (argv.includes("--on") && argv.includes("--off")) throw usageError("Use --on or --off, not both.");
  return args;
}

/** Open a local file with the system's opener. Only ever called for a person at a terminal. */
function openFile(path: string): void {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  try { spawn(command, [path], { stdio: "ignore", detached: true, shell: platform() === "win32" }).unref(); }
  catch { /* no opener: the path is printed */ }
}

/** Where a page goes when no path is given: beside the weekly ones. */
function defaultPagePath(meshHome: string, report: Report): string {
  return join(reportsDir(meshHome), report.kind === "week" ? `${report.period.id}.html` : `month-${report.period.id}.html`);
}

function writePage(meshHome: string, report: Report, path: string | true): string {
  // The default weekly path is the delivery's own, so the same pruning applies.
  if (path === true && report.kind === "week") return writeWeeklyPage(meshHome, report);
  const out = path === true ? defaultPagePath(meshHome, report) : path;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderReportHtml(report));
  return out;
}

function deliveryText(result: DeliveryResult): string {
  if (result.delivered) {
    const how = result.notification.ok
      ? `Notification shown through ${result.notification.via} (exit ${result.notification.exitCode}).`
      : result.notification.via === "none"
        ? "No notification: this machine has no notifier, or MESH_NO_NOTIFY is set."
        : `The notification did not show (${result.notification.via}, exit ${result.notification.exitCode ?? "unknown"}).`;
    return `Weekly report for the week of ${result.week} delivered.\n  Page: ${result.page}\n  ${how}\n  It said: ${result.text}`;
  }
  switch (result.reason) {
    case "switched_off": return "Nothing delivered: the weekly report is switched off (mesh report --on).";
    case "before_monday_morning": return "Nothing delivered: last week's report is due from Monday 08:00.";
    case "already_delivered": return "Nothing delivered: last week's report was already delivered on this machine.";
    case "nothing_to_report": return "Nothing delivered: Mesh was not on this machine during that week.";
  }
}

/** What the command reads besides its arguments. Tests point it away from the real ~/.mesh. */
export type ReportCommandOptions = Pick<ReportOptions, "meshHome" | "now" | "timeZone">;

export async function runReport(argv: string[], options: ReportCommandOptions = {}): Promise<void> {
  const args = parse(argv);
  if (args.help) { console.log(USAGE); return; }
  const meshHome = options.meshHome ?? defaultMeshHome();

  if (args.switchTo !== undefined) {
    const state = setReportNotifications(meshHome, args.switchTo, options.now ?? new Date());
    if (args.json) { writeJson({ schema: REPORT_SCHEMA, ok: true, mesh: meshIdentity(), notifications: state.notifications }); return; }
    console.log(args.switchTo === "off"
      ? "The weekly report is switched off. Mesh will not show the weekly notification or the once-a-week line in your terminal.\nmesh report still works whenever you want it. Switch it back on: mesh report --on"
      : "The weekly report is switched on. Once a week, after Monday 08:00, Mesh shows one notification and one line in your terminal.\nSwitch it off: mesh report --off");
    return;
  }

  if (args.deliver) {
    const result = await deliverWeeklyReportIfDue({
      meshHome,
      ...(args.ledgerDir === undefined ? {} : { ledgerDir: args.ledgerDir }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    });
    if (args.json) { writeJson({ schema: REPORT_SCHEMA, ok: true, mesh: meshIdentity(), delivery: result }); return; }
    console.log(deliveryText(result));
    return;
  }

  const result = collectReport({
    ...options,
    meshHome,
    ...(args.ledgerDir === undefined ? {} : { ledgerDir: args.ledgerDir }),
    ...(args.week === undefined ? {} : { week: args.week }),
    ...(args.month === undefined ? {} : { month: args.month }),
  });
  // The words are made from the report alone; drop the envelope before rendering.
  const { schema: _schema, ok: _ok, mesh: _mesh, headline: _headline, monthLine: _monthLine, oneLine: _oneLine, notifications: _notifications, ...rest } = result;
  const report = rest as Report;

  let page: string | undefined;
  if (args.html !== undefined || args.open) {
    try {
      page = writePage(meshHome, report, args.html ?? true);
    } catch (cause) {
      throw new CliError("unexpected", `The report page could not be written: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (!result.ok) process.exitCode = 1;

  if (args.json) {
    writeJson(page === undefined ? result : { ...result, page });
    return;
  }
  if (args.open && page !== undefined) {
    if (isInteractive()) {
      openFile(page);
      console.log(`Opened ${page}`);
    } else {
      console.log(page);
    }
    return;
  }
  console.log(renderReport(report, { detail: args.detail }));
  if (page !== undefined) console.log(`  Page written: ${page}\n`);
}
