/**
 * The in-process API: what an agent-facing caller (the `--json` printers, and
 * an MCP server) uses to read MESH on this machine.
 *
 * Every function here RETURNS a typed result and does nothing else: it never
 * prints, never calls process.exit, never writes a file and never makes a
 * provider call. The `run*` command functions are thin printers over these.
 * The result objects are exactly what `--json` prints, so the JSON conventions
 * in json-output.ts hold for them: a `schema`, `mesh: { version, build }`,
 * US-dollar amounts with integer cents for a fee, the bill's own verdict, and
 * no key, prompt, tool argument or free text taken from a request.
 *
 *   collectStatus(options?)   Promise<StatusResult>    mesh-status/1
 *   collectVerify(options?)   VerifyResult             mesh-verify/1
 *   collectConnect(options?)  Promise<ConnectResult>   mesh-connect/1
 *   collectReport(options?)   ReportResult             mesh-report/1
 *
 * Shared pieces, for a caller that needs less than a whole result:
 *
 *   summariseLedger(ledgerDir)  LedgerSummary     requests, verified savings, the bill's verdict
 *   inspectLedger(ledgerDir)    LedgerInspection  per-spool chain check and the invoice recompute
 *   resolvePort(flag?)          { port, source }  where MESH is configured on this machine
 *   probeProxy(port)            Promise<ProxyProbe>  is MESH answering there
 *
 * The weekly report in smaller pieces (report.ts; all pure, clock injected):
 *
 *   readReportSpools(ledgerDir)   SpoolInput[]   the ledger, read once
 *   buildWeeklyReport(input)      Report         one local week
 *   buildMonthReport(input)       Report         one billing month
 *   monthToDate(spools, now)      MonthToDate | null   "this month so far"
 *   reportOneLine(report)         string         for a banner or a status line
 *   reportHeadline(report)        string[]       the first screen
 *   renderReportHtml(report)      string         the self-contained page
 *
 * Every default path is the user's own ~/.mesh and ~/.claude, fixed from the
 * home directory when the module loads. Pass the options to read elsewhere.
 */
export { collectStatus, type ClaudeCodeState, type StatusOptions, type StatusResult } from "./daemon.js";
export {
  collectVerify,
  inspectLedger,
  type LedgerInspection,
  type SpoolFailure,
  type VerifyCheckStatus,
  type VerifyOptions,
  type VerifyResult,
} from "./verify.js";
export { collectConnect, renderConnect, type ConnectClient, type ConnectOptions, type ConnectResult } from "./connect.js";
export { collectReport, REPORT_SCHEMA, type ReportOptions, type ReportResult } from "./report-command.js";
export {
  buildMonthReport,
  buildWeeklyReport,
  localTimeZone,
  monthToDate,
  readReportSpools,
  renderReport,
  renderReportDetail,
  reportHeadline,
  reportMonthLine,
  reportOneLine,
  type MonthToDate,
  type Report,
  type ReportCase,
  type ReportDetail,
  type ReportPeriod,
  type ReportTheo,
  type WeekChoice,
} from "./report.js";
export { renderReportHtml } from "./report-html.js";
export { readTheoRecords, type TheoRecords } from "./report-theo.js";
export {
  decideWeeklyDelivery,
  deliverWeeklyReportIfDue,
  readReportState,
  startWeeklyReportSchedule,
  type DeliveryResult,
  type ReportState,
} from "./report-delivery.js";
export { summariseLedger, readLedger, ledgerTimeRange, type LedgerRead, type LedgerSummary } from "./start.js";
export { billVerdict, type BillVerdict, type VerdictReasonCode } from "./bill-verdict.js";
export { probeProxy, proxyUrls, resolvePort, portOpen, DEFAULT_PORT, type PortSource, type ProxyProbe } from "./machine.js";
export {
  CliError,
  jsonFailure,
  meshIdentity,
  type JsonFailure,
  type MeshErrorCode,
  type MeshIdentity,
} from "./json-output.js";
