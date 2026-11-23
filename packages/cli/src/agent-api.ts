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
 *
 * Shared pieces, for a caller that needs less than a whole result:
 *
 *   summariseLedger(ledgerDir)  LedgerSummary     requests, verified savings, the bill's verdict
 *   inspectLedger(ledgerDir)    LedgerInspection  per-spool chain check and the invoice recompute
 *   resolvePort(flag?)          { port, source }  where MESH is configured on this machine
 *   probeProxy(port)            Promise<ProxyProbe>  is MESH answering there
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
