/**
 * The MESH client runtime — the commands a downloaded user actually runs.
 *
 * Deliberately NOT `analyse`: that local-analysis dev tool pulls in the traffic
 * ingest, router, triage and observability-adapter code a client never needs,
 * and has no business shipping in a download. Keeping this entry lean keeps the
 * runtime bundle to the client surface: proxy + reducer + ledger + Theo.
 *
 * This is what scripts/build-cli-package.ts bundles into /mesh-runtime; the
 * small /mesh bootstrap fetches, caches, verifies and execs it.
 */
const TOP_USAGE = `mesh — cut your LLM bill, verified on your own usage.

Usage: mesh <command> [options]

  (nothing)  Just \`mesh\`: is it working, the one thing to fix if not, and this
             month so far in money.
  start      Start the MESH proxy, point Claude Code at it, and run Theo
             alongside you. One command; reverts cleanly on exit.
  proxy      Start the MESH proxy for any app or agent: point its base URL at
             MESH and keep your own key. Leaves Claude Code alone.
  install    Always-on: run MESH as a background service so every Claude Code
             session is optimised, with nothing to start by hand.
  stop       Stop the background service (kept, resume with install); restore Claude Code.
  uninstall  Stop and remove the background service; restore Claude Code.
  status     Is the service up, and what has Theo saved so far?
  connect    How a client reaches MESH on this machine: the base URLs to set
             and whether the proxy is answering. Reads no key, changes nothing.
  dashboard  Open a live local web view of your savings and what Theo is doing.
  theo       Run Theo once (or --watch), answer his proposals (--proposals,
             --accept, --reject), or prove levers on your own capture (--gate).
  update     Update the runtime now (--rollback to revert to the previous one).
  verify     Re-prove MESH's claims on this machine: the build's provenance,
             your ledger's hash-chain, and a deterministic invoice recompute.
  report     What Mesh did for you last week, in plain money: paid, saved, the
             fee, what you keep. --detail for the breakdown, --open for a page.
  statement  Your statement for one billing period (--period YYYY-MM): verified
             savings per lever and the 1% fee, recomputed from your own
             ledger, with a file to share. A statement, not an invoice.
  doctor     Diagnose this machine: Node, the proxy, Claude Code wiring, the
             service, and the ledger — each with a one-line fix.
  restore    Put Claude Code's settings back if a MESH session was killed and
             left it pointed at a proxy that is no longer running.
  version    Print the installed version and build.
  compaction Estimate, per task in your ledger, what context compaction would
             save — and where it would cost more than it saves (advisory).

Run "mesh <command> --help" for command options.`;

async function main(): Promise<void> {
  const sub = process.argv[2];
  // Once a week, and only in a terminal: last week's report in one line on
  // stderr, before the command's own output (report-delivery.ts).
  if (process.stdout.isTTY === true && process.stderr.isTTY === true) {
    try {
      (await import("./report-delivery.js")).announceInTerminal(process.argv.slice(2));
    } catch { /* never in the way of the command */ }
  }
  if (sub === undefined) {
    // Bare `mesh`: the summary and the next step, not the usage text.
    await (await import("./summary.js")).runSummary();
  } else if (sub === "--json" && process.argv.length === 3) {
    // `mesh --json` is `mesh status --json`.
    await (await import("./daemon.js")).runStatus(["--json"]);
  } else if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(TOP_USAGE);
  } else if (sub === "start") {
    await (await import("./start.js")).runStart(process.argv.slice(3));
  } else if (sub === "proxy") {
    // The same proxy and Theo as `start`, for an application rather than Claude Code.
    await (await import("./start.js")).runStart(["--no-install", ...process.argv.slice(3)]);
  } else if (sub === "serve") {
    await (await import("./start.js")).runServe(process.argv.slice(3));
  } else if (sub === "install") {
    await (await import("./daemon.js")).runInstall(process.argv.slice(3));
  } else if (sub === "uninstall") {
    (await import("./daemon.js")).runUninstall(process.argv.slice(3));
  } else if (sub === "stop") {
    (await import("./daemon.js")).runStop(process.argv.slice(3));
  } else if (sub === "status") {
    await (await import("./daemon.js")).runStatus(process.argv.slice(3));
  } else if (sub === "update") {
    await (await import("./update.js")).runUpdate(process.argv.slice(3));
  } else if (sub === "verify") {
    await (await import("./verify.js")).runVerify(process.argv.slice(3));
  } else if (sub === "connect") {
    await (await import("./connect.js")).runConnect(process.argv.slice(3));
  } else if (sub === "report") {
    await (await import("./report-command.js")).runReport(process.argv.slice(3));
  } else if (sub === "statement") {
    await (await import("./statement.js")).runStatement(process.argv.slice(3));
  } else if (sub === "doctor") {
    await (await import("./diag.js")).runDoctor(process.argv.slice(3));
  } else if (sub === "restore") {
    await (await import("./diag.js")).runRestore(process.argv.slice(3));
  } else if (sub === "dashboard") {
    await (await import("./dashboard.js")).runDashboard(process.argv.slice(3));
  } else if (sub === "theo") {
    await (await import("./theo.js")).runTheo(process.argv.slice(3));
  } else if (sub === "version" || sub === "--version" || sub === "-v") {
    (await import("./diag.js")).runVersion(process.argv.slice(3));
  } else if (sub === "compaction") {
    await (await import("./compaction.js")).runCompaction(process.argv.slice(3));
  } else {
    console.log(TOP_USAGE);
  }
}

// A command that throws: the message on stderr, or with --json one failure
// object on stdout. Exit 1 either way (json-output.ts).
main().catch(async (error: unknown) => {
  (await import("./json-output.js")).reportFatal(error);
});
