/**
 * `mesh start` — the one-command, frictionless deploy for Claude Code.
 *
 * What it does, in order:
 *   1. Starts the REAL MESH proxy (the same `startMeshProxy` the test suite
 *      covers) on a local port, writing a hash-chained ledger under ~/.mesh.
 *   2. Points Claude Code at it by writing ANTHROPIC_BASE_URL into
 *      ~/.claude/settings.json — and REVERTS that on exit, so Claude Code is
 *      never left pointing at a stopped proxy.
 *   3. Runs Theo alongside you: he applies only gate-proven levers, watches the
 *      ledger, and reports savings that are verified from your provider's own
 *      usage — never an estimate, never a number he can't prove.
 *
 * It never reads, stores or forwards your API key: your own credential stays in
 * Claude Code and is passed straight through to Anthropic. MESH only sets the
 * base URL.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Import the specific modules, NOT the package barrels: the barrels re-export
// the whole library (router, triage, observability adapters, billing), which
// would all bundle into the client runtime. Direct imports keep it to the
// client surface: proxy + reducer + ledger + Theo policy.
import { recomputeInvoice, verifyLedgerChain, type LedgerRecord } from "../../core/src/savings-ledger.js";
import { startMeshProxy } from "../../sdk-js/src/proxy.js";
import { asBundle, bundleToReductionConfig, defaultPolicy, policyToReductionConfig, withheldLevers, type TheoPolicy, type TheoPolicyBundle } from "../../sdk-js/src/theo-policy.js";
import type { TheoAutonomyLevel } from "../../sdk-js/src/theo-agent.js";
import { parseDuration, startBackgroundTheo } from "./theo.js";
// Pure formatter module (no core imports) — reused so the signup URL and the
// README badge have one source of truth across the proxy, SDK and this CLI.
import { MESH_SIGNUP_URL, savingsBadge, type SavingsSnapshot } from "../../sdk-js/src/cta.js";
import { pullNewerRuntime } from "./update.js";

declare const __MESH_BUILD_COMMIT__: string | undefined;
export const BUILD_COMMIT =
  typeof __MESH_BUILD_COMMIT__ !== "undefined" ? __MESH_BUILD_COMMIT__ : (process.env.MESH_BUILD_COMMIT ?? "dev");

export const MESH_HOME = join(homedir(), ".mesh");
export const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
export const DEFAULT_PORT = 8787;

/**
 * Read the user's Theo policy without writing anything — the default (STRICT,
 * lossless-only) when none exists yet. Shared by the dashboard and `mesh status`
 * so both read the policy the same way; the proxy's own read in
 * startProxyWithPolicy is separate because it writes the default on first run.
 */
export function readPolicy(): TheoPolicy {
  return readPolicyBundle().default;
}

/**
 * Read the user's full policy bundle (default + per-route overrides), normalising
 * a legacy single-policy file into a bundle. The DEFAULT (STRICT, lossless-only)
 * when none exists yet or the file is unreadable.
 */
export function readPolicyBundle(): TheoPolicyBundle {
  const path = join(MESH_HOME, "theo-policy.json");
  const fallback = (): TheoPolicyBundle => asBundle(defaultPolicy("local", new Date().toISOString()));
  if (!existsSync(path)) return fallback();
  try {
    return asBundle(JSON.parse(readFileSync(path, "utf8")) as TheoPolicy | TheoPolicyBundle);
  } catch {
    return fallback();
  }
}

type StartArgs = {
  port: number;
  ledgerDir: string;
  install: boolean;
  anthropicUpstream?: string;
  openaiUpstream?: string;
  capturePath?: string;
  captureMaxMb?: number;
  autonomy?: TheoAutonomyLevel;
  theoIntervalMs?: number;
  theoProviderUrl?: string;
  /** Path to the provider-key file the unattended gate reads (launchd has no shell env). */
  gateKeyFile?: string;
  noTheo?: boolean;
};

function parseStart(argv: string[]): StartArgs {
  const args: StartArgs = {
    port: 8787,
    ledgerDir: join(MESH_HOME, "ledger"),
    install: true,
    // Env defaults so the background service (mesh serve) can be pointed at an
    // OpenAI-compatible provider too, not just the foreground command.
    anthropicUpstream: process.env.MESH_ANTHROPIC_UPSTREAM,
    openaiUpstream: process.env.MESH_OPENAI_UPSTREAM,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (key === "--help" || key === "-h") {
      console.log(
        `Usage: mesh start [options]\n\n` +
          `  --port <n>              Port for the local proxy (default 8787).\n` +
          `  --ledger <dir>          Where to write the hash-chained ledger (default ~/.mesh/ledger).\n` +
          `  --openai-base <url>     Send OpenAI-style traffic to this host instead of api.openai.com —\n` +
          `                          any OpenAI-compatible provider (Grok, DeepSeek, Mistral, Llama, …).\n` +
          `  --anthropic-base <url>  Send Anthropic traffic to this host instead of api.anthropic.com.\n` +
          `  --capture <file>        Opt-in: record your own requests to <file> (local, owner-only) so\n` +
          `                          Theo can prove lossy levers on real traffic.\n` +
          `  --capture-max-mb <n>    Cap the capture file at n MB of prompt content (default 5).\n` +
          `  --gate-key-file <path>  Provider key for the unattended gate, read from this file (chmod\n` +
          `                          600) — the daemon has no shell env. Only the path is stored.\n` +
          `  --autonomy <level>      Theo's autonomy while running alongside: observe | recommend |\n` +
          `                          test | optimise (default recommend).\n` +
          `  --theo-interval <dur>   How often Theo runs a cycle (e.g. 15m, 1h; default 15m).\n` +
          `  --no-theo               Don't run Theo alongside the proxy; just serve.\n` +
          `  --no-install            Don't touch ~/.claude/settings.json; just run the proxy.\n` +
          `  --help                  Show this message.`,
      );
      process.exit(0);
    }
    if (key === "--no-install") { args.install = false; continue; }
    if (key === "--no-theo") { args.noTheo = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value.`);
    i += 1;
    if (key === "--port") args.port = Number.parseInt(value, 10);
    else if (key === "--ledger") args.ledgerDir = value;
    else if (key === "--openai-base") args.openaiUpstream = value;
    else if (key === "--anthropic-base") args.anthropicUpstream = value;
    else if (key === "--capture") args.capturePath = value;
    else if (key === "--capture-max-mb") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--capture-max-mb must be a positive number.");
      args.captureMaxMb = n;
    }
    else if (key === "--autonomy") {
      if (!["observe", "recommend", "test", "optimise"].includes(value)) {
        throw new Error("--autonomy must be observe | recommend | test | optimise.");
      }
      args.autonomy = value as TheoAutonomyLevel;
    }
    else if (key === "--theo-interval") args.theoIntervalMs = parseDuration(value);
    else if (key === "--theo-provider-url") args.theoProviderUrl = value;
    else if (key === "--gate-key-file") args.gateKeyFile = value;
    else throw new Error(`Unknown option: ${key}. See mesh start --help.`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error("--port must be 0-65535.");
  for (const url of [args.anthropicUpstream, args.openaiUpstream]) {
    if (url !== undefined && !/^https?:\/\//.test(url)) throw new Error(`Upstream must be an http(s) URL: ${url}`);
  }
  return args;
}

/** A per-user HMAC key for Theo's blind feature stream. Local, 0600, never leaves. */
function blindKey(): string {
  const path = join(MESH_HOME, "blind.key");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const key = randomBytes(32).toString("hex");
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

/** Point Claude Code at the proxy; return a function that restores the prior state. */
function configureClaudeCode(baseUrl: string): () => void {
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  let settings: Record<string, unknown> = {};
  let hadFile = false;
  if (existsSync(CLAUDE_SETTINGS)) {
    hadFile = true;
    try {
      settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`~/.claude/settings.json isn't valid JSON — fix or move it, then re-run. MESH won't overwrite it.`);
    }
  }
  const env = { ...((settings.env as Record<string, string>) ?? {}) };
  const priorBaseUrl = env.ANTHROPIC_BASE_URL;
  env.ANTHROPIC_BASE_URL = baseUrl;
  writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify({ ...settings, env }, null, 2)}\n`);

  return function restore(): void {
    try {
      const now = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) as Record<string, unknown>;
      const nowEnv = { ...((now.env as Record<string, string>) ?? {}) };
      if (priorBaseUrl === undefined) delete nowEnv.ANTHROPIC_BASE_URL;
      else nowEnv.ANTHROPIC_BASE_URL = priorBaseUrl;
      const next: Record<string, unknown> = { ...now, env: nowEnv };
      if (Object.keys(nowEnv).length === 0) delete next.env;
      if (!hadFile && Object.keys(next).length === 0) return; // we created nothing worth keeping
      writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(next, null, 2)}\n`);
    } catch {
      /* best-effort restore; never crash on shutdown */
    }
  };
}

type LedgerSummary = { events: number; savedUsd: number; verdict: string; chainOk: boolean; brokenAt?: string };
export type LedgerRead = { records: LedgerRecord[]; chainOk: boolean; brokenAt?: string };

/** Read every ledger spool and verify each hash chain. Shared by status and the dashboard. */
export function readLedger(ledgerDir: string): LedgerRead {
  if (!existsSync(ledgerDir)) return { records: [], chainOk: true };
  const spools = readdirSync(ledgerDir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".features.jsonl"));
  const allRecords: LedgerRecord[] = [];
  let chainOk = true;
  let brokenAt: string | undefined;
  for (const spool of spools) {
    const records: LedgerRecord[] = [];
    const raw = readFileSync(join(ledgerDir, spool), "utf8").trim();
    if (raw === "") continue;
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try { records.push(JSON.parse(line) as LedgerRecord); } catch { /* partial tail line mid-write */ }
    }
    const chain = verifyLedgerChain(records);
    if (!chain.ok) { chainOk = false; brokenAt = `${spool} seq ${chain.seq}`; }
    allRecords.push(...records);
  }
  return { records: allRecords, chainOk, ...(brokenAt === undefined ? {} : { brokenAt }) };
}

/** Read every ledger spool, verify each chain, and recompute one honest invoice. */
export function summariseLedger(ledgerDir: string): LedgerSummary {
  const { records, chainOk, brokenAt } = readLedger(ledgerDir);
  if (records.length === 0) return { events: 0, savedUsd: 0, verdict: "do_not_charge", chainOk, ...(brokenAt === undefined ? {} : { brokenAt }) };
  const invoice = recomputeInvoice(records.map((r) => r.event));
  return {
    events: records.length,
    savedUsd: invoice.netVerifiedSavingsUsd,
    verdict: invoice.verdict,
    chainOk,
    ...(brokenAt === undefined ? {} : { brokenAt }),
  };
}

/** Build the snapshot the CTA/badge read, from the same verified ledger. */
export function snapshotLedger(ledgerDir: string): SavingsSnapshot {
  const { records, chainOk } = readLedger(ledgerDir);
  if (records.length === 0) {
    return { requests: 0, savedUsd: 0, spendUsd: 0, verdict: "do_not_charge", chainOk };
  }
  const events = records.map((r) => r.event);
  const invoice = recomputeInvoice(events);
  const spendUsd = events.reduce((sum, e) => sum + (e.actualUsd ?? 0), 0);
  return {
    requests: records.length,
    savedUsd: invoice.netVerifiedSavingsUsd,
    spendUsd,
    verdict: invoice.verdict,
    chainOk,
  };
}

const T = "⬢ theo"; // the hex mark, Theo's sign-off

/** Start the proxy with Theo's current policy + blind stream. Shared by start/serve. */
export async function startProxyWithPolicy(
  port: number,
  ledgerDir: string,
  upstreams: { anthropicUpstream?: string; openaiUpstream?: string } = {},
  capture?: { path: string; limit?: number },
): Promise<{ proxy: Awaited<ReturnType<typeof startMeshProxy>>; policy: ReturnType<typeof defaultPolicy> }> {
  mkdirSync(MESH_HOME, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  const policyPath = join(MESH_HOME, "theo-policy.json");
  const policy = existsSync(policyPath)
    ? (JSON.parse(readFileSync(policyPath, "utf8")) as ReturnType<typeof defaultPolicy>)
    : defaultPolicy("local", new Date().toISOString());
  if (!existsSync(policyPath)) writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  // Hot-reload: re-read the policy file when it changes (Theo publishes to it),
  // so proven levers take effect without restarting the proxy. mtime-cached so a
  // request never re-parses the file needlessly; the last good config is kept on
  // any read/parse error, so a mid-write or bad file can't break the request path.
  // mtime-cache the parsed BUNDLE (default + per-route overrides); the per-route
  // config for a given model id is resolved per request from the cached bundle, so
  // routing costs nothing beyond a map lookup once the file is parsed.
  let cached = { mtimeMs: -1, bundle: asBundle(policy) };
  const liveReduction = (modelId?: string): ReturnType<typeof policyToReductionConfig> => {
    try {
      const mtimeMs = statSync(policyPath).mtimeMs;
      if (mtimeMs !== cached.mtimeMs) {
        const current = JSON.parse(readFileSync(policyPath, "utf8")) as TheoPolicy | TheoPolicyBundle;
        cached = { mtimeMs, bundle: asBundle(current) };
      }
    } catch {
      // keep the last good bundle
    }
    return bundleToReductionConfig(cached.bundle, modelId ?? "");
  };
  const proxy = await startMeshProxy({
    port,
    ledgerDirectory: ledgerDir,
    tokenReduction: liveReduction,
    blindFeaturesKey: blindKey(),
    ...(capture ? { requestCapture: capture } : {}),
    ...(upstreams.anthropicUpstream ? { anthropicUpstream: upstreams.anthropicUpstream } : {}),
    ...(upstreams.openaiUpstream ? { openaiUpstream: upstreams.openaiUpstream } : {}),
  });
  return { proxy, policy };
}

/**
 * `mesh serve` — the always-on daemon body: proxy + Theo, logging to stdout so
 * launchd captures it to ~/.mesh/daemon.log. No config writes and no revert;
 * `mesh install` owns the persistent Claude Code wiring, `mesh uninstall`
 * removes it. Started by the LaunchAgent, not run by hand.
 */
export async function runServe(argv: string[]): Promise<void> {
  const args = parseStart(argv);
  const { proxy } = await startProxyWithPolicy(args.port, args.ledgerDir, args, args.capturePath ? { path: args.capturePath, ...(args.captureMaxMb !== undefined ? { maxBytes: Math.round(args.captureMaxMb * 1024 * 1024) } : {}) } : undefined);
  const stamp = (): string => new Date().toISOString();
  console.log(`[${stamp()}] mesh serve · build ${BUILD_COMMIT} · proxy ${proxy.url} · ledger ${args.ledgerDir}`);
  if (args.openaiUpstream) console.log(`[${stamp()}] openai-style upstream → ${args.openaiUpstream}`);
  if (args.anthropicUpstream) console.log(`[${stamp()}] anthropic upstream → ${args.anthropicUpstream}`);

  // Run Theo alongside the proxy: every interval he observes this ledger, decides
  // within his autonomy level, and (apply) writes the policy the proxy hot-reloads
  // — so the always-on service keeps optimising with nothing to run by hand.
  const theoIntervalMs = args.theoIntervalMs ?? 15 * 60_000;
  const stopTheo = args.noTheo ? undefined : startBackgroundTheo(
    {
      ledgerDir: args.ledgerDir,
      customer: "local",
      autonomy: args.autonomy ?? "recommend",
      maxSamples: 20,
      apply: true,
      ...(args.capturePath ? { gate: args.capturePath } : {}),
      ...(args.theoProviderUrl ? { providerUrl: args.theoProviderUrl } : {}),
      ...(args.gateKeyFile ? { gateKeyFile: args.gateKeyFile } : {}),
    },
    theoIntervalMs,
  );
  if (stopTheo) {
    console.log(`[${stamp()}] ${T} running every ${Math.round(theoIntervalMs / 1000)}s · autonomy ${args.autonomy ?? "recommend"}${args.capturePath ? " · proving on capture" : ""}`);
  }

  let lastEvents = -1;
  const monitor = setInterval(() => {
    const s = summariseLedger(args.ledgerDir);
    if (!s.chainOk) { console.log(`[${stamp()}] ${T} ⚠ ledger chain failed at ${s.brokenAt}`); return; }
    if (s.events === lastEvents || s.events === 0) return;
    lastEvents = s.events;
    console.log(`[${stamp()}] ${T} ${s.events} requests · $${s.savedUsd.toFixed(4)} verified saved (${s.verdict})`);
  }, 10000);

  // Keep the always-on service current. The bootstrap only checks for a newer
  // runtime at launch, but the daemon launches once and runs for weeks — so
  // without this it would serve the version it started with until the machine
  // restarts (customers stuck on old MESH). A few times a day, pull a newer
  // published runtime (checksum-verified, with a rollback copy) and, when one
  // lands, exit so launchd relaunches us on it. Disable with MESH_NO_AUTO_UPDATE.
  const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
  const autoUpdate = process.env.MESH_NO_AUTO_UPDATE === undefined && BUILD_COMMIT !== "dev";
  const updateTimer = autoUpdate ? setInterval(() => { void (async () => {
    try {
      const next = await pullNewerRuntime();
      if (next && next !== BUILD_COMMIT) {
        console.log(`[${stamp()}] ${T} runtime updated ${BUILD_COMMIT} → ${next}; restarting to apply.`);
        clearInterval(monitor);
        clearInterval(updateTimer!);
        await proxy.close();
        process.exit(0); // launchd KeepAlive relaunches → bootstrap runs the new runtime
      }
    } catch { /* an update check must never take the proxy down */ }
  })(); }, UPDATE_CHECK_MS) : undefined;

  const shutdown = async (): Promise<void> => {
    clearInterval(monitor);
    if (updateTimer) clearInterval(updateTimer);
    stopTheo?.();
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
  await new Promise<void>(() => {});
}

export async function runStart(argv: string[]): Promise<void> {
  const args = parseStart(argv);
  const { proxy, policy } = await startProxyWithPolicy(args.port, args.ledgerDir, args, args.capturePath ? { path: args.capturePath, ...(args.captureMaxMb !== undefined ? { maxBytes: Math.round(args.captureMaxMb * 1024 * 1024) } : {}) } : undefined);
  const restore = args.install ? configureClaudeCode(proxy.url) : () => {};
  const withheld = withheldLevers(policy);

  // ---- banner ----
  console.log("");
  console.log(`  MESH is running  ·  build ${BUILD_COMMIT}`);
  console.log(`  proxy    ${proxy.url}`);
  console.log(`  ledger   ${args.ledgerDir}  (hash-chained; recompute any time with: mesh verify)`);
  if (args.install) console.log(`  claude   pointed at MESH via ~/.claude/settings.json  (restored on exit)`);
  else console.log(`  claude   not configured (--no-install); set ANTHROPIC_BASE_URL=${proxy.url} yourself`);
  // MESH is not Claude-specific: any OpenAI-style client works by pointing its
  // base URL here and keeping its own key. The proxy picks the upstream from
  // the request (Anthropic vs OpenAI-style) and your key passes straight through.
  console.log(`  openai   point any OpenAI-style client here: OPENAI_BASE_URL=${proxy.url}/v1  (keep your own key)`);
  if (args.openaiUpstream) console.log(`  upstream OpenAI-style traffic → ${args.openaiUpstream}`);
  if (args.anthropicUpstream) console.log(`  upstream Anthropic traffic → ${args.anthropicUpstream}`);
  console.log("");
  console.log(`  ${T} — I'm watching your traffic. I only ever tune MESH, never your prompts`);
  console.log(`  ${T}   or answers. Everything I report is verified from your provider's own`);
  console.log(`  ${T}   usage — never an estimate.`);
  if (withheld.length > 0) {
    console.log(`  ${T}   Holding ${withheld.length} lossy lever${withheld.length === 1 ? "" : "s"} back until a replay`);
    console.log(`  ${T}   proves ${withheld.length === 1 ? "it is" : "they are"} safe on your own traffic.`);
  }
  console.log("");
  console.log(`  Just use Claude Code as normal. Press Ctrl+C to stop (Claude Code reverts cleanly).`);
  console.log("");

  // ---- Theo's monitor: report verified savings as they accrue ----
  let lastEvents = -1;
  const tick = (): void => {
    const s = summariseLedger(args.ledgerDir);
    if (!s.chainOk) {
      console.log(`  ${T} — ⚠ ledger chain check failed at ${s.brokenAt}. Stop and run: mesh verify`);
      return;
    }
    if (s.events === lastEvents) return;
    lastEvents = s.events;
    if (s.events === 0) return;
    const saved = `$${s.savedUsd.toFixed(4)}`;
    const verdict = s.verdict === "charge" ? saved : `${saved} (nothing to bill yet — do not pay us)`;
    console.log(`  ${T} — ${s.events} request${s.events === 1 ? "" : "s"} seen · ${verdict} verified saved`);
  };
  const monitor = setInterval(tick, 6000);

  // ---- clean shutdown ----
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(monitor);
    const snap = snapshotLedger(args.ledgerDir);
    restore();
    await proxy.close();
    console.log("");
    if (snap.requests > 0) {
      console.log(`  ${T} — session done: ${snap.requests} request${snap.requests === 1 ? "" : "s"}, $${snap.savedUsd.toFixed(4)} verified saved.`);
      console.log(`  ${T}   Recompute it yourself any time: mesh verify`);
      // The signup ask — only when there's a real, verified saving to claim.
      if (snap.chainOk && snap.verdict === "charge" && snap.savedUsd > 0) {
        console.log("");
        console.log(`  ${T} — keep these savings metered: ${MESH_SIGNUP_URL}`);
        console.log(`  ${T}   show it off — paste this badge into your README:`);
        console.log(`     ${savingsBadge(snap).markdown}`);
      }
    } else {
      console.log(`  ${T} — no requests ran through MESH this session.`);
    }
    console.log(`  Claude Code restored. Bye.`);
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  // Keep the process alive.
  await new Promise<void>(() => {});
}
