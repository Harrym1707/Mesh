/**
 * The real-bill test: does one real Claude Code request cost less through MESH
 * than sent directly? This is the scoreboard. Run it on a machine where the
 * terminal `claude` is logged in:
 *
 *   node --import tsx scripts/real-bill-test.ts            # this checkout
 *   node --import tsx scripts/real-bill-test.ts --installed  # ~/.mesh/bin/mesh
 *
 * It sends the SAME small request three ways. Each path is repeated until a
 * run writes nothing to the provider's prompt cache (at most five times): that
 * warm run is the steady state, and the one compared.
 *
 *   direct     straight to the provider
 *   control    through a plain pass-through on localhost that changes nothing
 *              (shows what Claude Code itself does differently behind a proxy)
 *   mesh       through MESH on a free port, with the environment `mesh start`
 *              writes for Claude Code
 *
 * Every token count is the provider's own, read from the CLI's JSON output.
 * Dollars are those counts at MESH's published price list. A subscription
 * login has no per-request invoice, so the dollars are API-rate equivalents.
 *
 * It never touches ~/.claude/settings.json (checked by hash before and after),
 * writes the ledger to a temporary folder unless --ledger is given, stores no
 * request headers, and stops only the processes it started.
 *
 * Options:
 *   --installed           test ~/.mesh/bin/mesh instead of this checkout
 *   --model <id>          default claude-sonnet-5-5
 *   --prompt <text>       default: a one-word reply
 *   --claude <path>       default: `claude` on PATH
 *   --no-tool-search      do not set ENABLE_TOOL_SEARCH on the mesh runs
 *   --small-model <id>    also set ANTHROPIC_DEFAULT_HAIKU_MODEL on the mesh runs
 *   --ledger <dir>        keep the ledger here instead of a temporary folder
 *   --json                print the result as JSON only
 *   --fail-if-dearer      exit 1 when the warm mesh run costs more than direct
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createServer, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishedModelPrices } from "../packages/core/src/model-prices.js";
import { priceUsage, resolveModelId } from "../packages/core/src/price-catalogue.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS = join(homedir(), ".claude", "settings.json");

function flag(name: string): boolean { return process.argv.includes(name); }
function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}

const MODEL = option("--model", "claude-sonnet-5-5");
const PROMPT = option("--prompt", "Reply with exactly the word OK and nothing else.");
const CLAUDE = option("--claude", "claude");
const JSON_ONLY = flag("--json");
const say = (line: string): void => { if (!JSON_ONLY) console.log(line); };

const settingsHash = (): string =>
  existsSync(SETTINGS) ? createHash("sha256").update(readFileSync(SETTINGS)).digest("hex") : "absent";

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
}

/** A clean environment: nothing inherited that could change what Claude Code sends. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const keep = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR"];
  const env: Record<string, string> = { SHELL: "/bin/sh", TERM: "dumb", LANG: "en_US.UTF-8" };
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  return { ...env, ...extra };
}

type ModelTokens = { fresh: number; cacheRead: number; cacheWrite: number; output: number; usd: number | null };
type Run = { ok: boolean; reply: string; inputTokens: number; usd: number | null; models: Record<string, ModelTokens> };

function priceModel(id: string, tokens: Omit<ModelTokens, "usd">, write1h: number): number | null {
  const resolved = resolveModelId(publishedModelPrices, "anthropic", id);
  if (resolved.status === "unresolved") return null;
  const priced = priceUsage(
    publishedModelPrices,
    { provider: "anthropic", model: resolved.model, at: new Date().toISOString().slice(0, 10), mode: "standard" },
    {
      inputTokens: tokens.fresh + tokens.cacheRead + tokens.cacheWrite,
      outputTokens: tokens.output,
      cachedInputTokens: tokens.cacheRead,
      cacheWriteInputTokens: tokens.cacheWrite,
      cacheWrite1hInputTokens: Math.min(write1h, tokens.cacheWrite),
    },
  );
  return priced.status === "priced" ? priced.costUsd : null;
}

/** Run the CLI without blocking this process (the pass-through lives in it). */
function capture(cwd: string, extraEnv: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(
      CLAUDE,
      ["-p", PROMPT, "--model", MODEL, "--strict-mcp-config", "--output-format", "json"],
      { cwd, env: cleanEnv(extraEnv), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.on("error", (error) => { clearTimeout(timer); done({ stdout, stderr: error.message }); });
    child.on("close", () => { clearTimeout(timer); done({ stdout, stderr }); });
  });
}

/**
 * The first (cold) run on a path and the first run after it that wrote nothing
 * to the prompt cache. Two runs sent back to back can both be cache writes, so
 * "the second run" is not reliably warm.
 */
async function coldAndWarm(cwd: string, extraEnv: Record<string, string>): Promise<Run[]> {
  const cold = await runClaude(cwd, extraEnv);
  let warm = cold;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    warm = await runClaude(cwd, extraEnv);
    if (!warm.ok || Object.values(warm.models).every((model) => model.cacheWrite === 0)) break;
  }
  return [cold, warm];
}

async function runClaude(cwd: string, extraEnv: Record<string, string>): Promise<Run> {
  const result = await capture(cwd, extraEnv);
  let parsed: Record<string, any>;
  try { parsed = JSON.parse(result.stdout) as Record<string, any>; }
  catch { return { ok: false, reply: (result.stderr || result.stdout || "no output").slice(0, 200), inputTokens: 0, usd: null, models: {} }; }
  const write1h = Number(parsed.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const models: Record<string, ModelTokens> = {};
  let usd: number | null = 0;
  for (const [id, raw] of Object.entries((parsed.modelUsage ?? {}) as Record<string, Record<string, number>>)) {
    const tokens = {
      fresh: raw.inputTokens ?? 0, cacheRead: raw.cacheReadInputTokens ?? 0,
      cacheWrite: raw.cacheCreationInputTokens ?? 0, output: raw.outputTokens ?? 0,
    };
    const cost = priceModel(id, tokens, write1h);
    models[id] = { ...tokens, usd: cost };
    usd = usd === null || cost === null ? null : usd + cost;
  }
  const usage = parsed.usage ?? {};
  return {
    ok: parsed.is_error === false,
    reply: String(parsed.result ?? "").slice(0, 80),
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    usd,
    models,
  };
}

/** Forwards every request to api.anthropic.com unchanged. Logs and stores nothing. */
function startPassThrough(port: number): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const upstream = https.request(
      { host: "api.anthropic.com", port: 443, method: request.method, path: request.url, headers: { ...request.headers, host: "api.anthropic.com" } },
      (reply) => { response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response); },
    );
    upstream.on("error", (error) => { response.writeHead(502); response.end(error.message); });
    request.pipe(upstream);
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

async function waitForHealth(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const up = await new Promise<boolean>((done) => {
      const request = http.get({ host: "127.0.0.1", port, path: "/mesh/health", timeout: 1000 }, (reply) => {
        reply.resume();
        done(reply.statusCode === 200);
      });
      request.on("error", () => done(false));
      request.on("timeout", () => { request.destroy(); done(false); });
    });
    if (up) return true;
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}

function stopGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  // Started detached, so the pid is its own process group: this reaches the
  // launcher and the runtime it spawned, and nothing this script did not start.
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
}

function ledgerClaim(ledgerDir: string): { rows: number; claimedUsd: number; statuses: string[] } {
  const path = join(ledgerDir, "proxy-anthropic.jsonl");
  if (!existsSync(path)) return { rows: 0, claimedUsd: 0, statuses: [] };
  const events = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { event: Record<string, any> }).event);
  const claimedUsd = events.reduce((sum, event) =>
    sum + ((event.levers ?? []) as Array<{ savedUsd?: number }>).reduce((s, lever) => s + (lever.savedUsd ?? 0), 0), 0);
  return { rows: events.length, claimedUsd, statuses: [...new Set(events.map((event) => `${event.status}/${event.pricingStatus}`))] };
}

async function main(): Promise<void> {
  const before = settingsHash();
  const cwd = mkdtempSync(join(tmpdir(), "mesh-real-bill-cwd-"));
  const ledgerDir = resolve(option("--ledger", mkdtempSync(join(tmpdir(), "mesh-real-bill-ledger-"))));
  const installed = flag("--installed");
  const meshEnv: Record<string, string> = {};
  if (!flag("--no-tool-search")) meshEnv.ENABLE_TOOL_SEARCH = "true";
  const smallModel = option("--small-model", "");
  if (smallModel !== "") meshEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallModel;

  say(`real-bill test · model ${MODEL} · ${installed ? "installed MESH" : "this checkout"} · ${new Date().toISOString()}`);
  const direct = await coldAndWarm(cwd, {});
  if (!direct[1]!.ok) throw new Error(`The direct request failed, so there is nothing to compare: ${direct[1]!.reply}`);

  const controlPort = await freePort();
  const passThrough = await startPassThrough(controlPort);
  const controlEnv = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${controlPort}`, ...meshEnv };
  const control = await coldAndWarm(cwd, controlEnv);
  await new Promise((done) => passThrough.close(done));

  const meshPort = await freePort();
  const meshArgs = ["start", "--no-install", "--no-theo", "--port", String(meshPort), "--ledger", ledgerDir];
  const mesh = installed
    ? spawn(join(homedir(), ".mesh", "bin", "mesh"), meshArgs, { cwd, env: cleanEnv({}), stdio: "ignore", detached: true })
    : spawn(process.execPath, ["--import", "tsx", join(REPO, "packages/cli/src/main.ts"), ...meshArgs],
        { cwd: REPO, env: cleanEnv({}), stdio: "ignore", detached: true });
  let meshRuns: Run[] = [];
  try {
    if (!(await waitForHealth(meshPort))) throw new Error(`MESH did not answer on port ${meshPort}.`);
    const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${meshPort}`, ...meshEnv };
    meshRuns = await coldAndWarm(cwd, env);
  } finally {
    stopGroup(mesh);
  }

  const after = settingsHash();
  const claim = ledgerClaim(ledgerDir);
  const warm = { direct: direct[1]!, control: control[1]!, mesh: meshRuns[1]! };
  const percent = (a: number | null, b: number | null): number | null =>
    a === null || b === null || b === 0 ? null : ((a - b) / b) * 100;
  const result = {
    at: new Date().toISOString(),
    model: MODEL,
    build: installed ? "installed" : "checkout",
    meshEnvironment: meshEnv,
    settingsUntouched: before === after,
    warm,
    cold: { direct: direct[0]!, control: control[0]!, mesh: meshRuns[0]! },
    meshVersusDirectPercent: percent(warm.mesh.usd, warm.direct.usd),
    meshVersusControlPercent: percent(warm.mesh.usd, warm.control.usd),
    ledger: { dir: ledgerDir, ...claim },
  };

  if (JSON_ONLY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const row = (name: string, run: Run): string =>
      `  ${name.padEnd(8)} ${run.ok ? "ok    " : "FAILED"} ${String(run.inputTokens).padStart(7)} input tokens   ` +
      `${run.usd === null ? "unpriced" : `$${run.usd.toFixed(6)}`}   ` +
      Object.entries(run.models).map(([id, m]) => `${id}: ${m.fresh}+${m.cacheRead}r+${m.cacheWrite}w in, ${m.output} out`).join(" · ");
    say("");
    say("  warm run (first run on each path that wrote nothing to the cache; main request input tokens; cost of the whole run)");
    say(row("direct", warm.direct));
    say(row("control", warm.control));
    say(row("mesh", warm.mesh));
    say("");
    const signed = (value: number | null): string => value === null ? "unpriced" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
    say(`  mesh against direct:   ${signed(result.meshVersusDirectPercent)}   (negative means MESH is cheaper)`);
    say(`  mesh against control:  ${signed(result.meshVersusControlPercent)}   (MESH's own effect, same client behaviour)`);
    say(`  ledger:                ${claim.rows} rows, ${claim.statuses.join(", ") || "none"}, claimed $${claim.claimedUsd.toFixed(6)} over all mesh runs`);
    say(`  settings.json:         ${result.settingsUntouched ? "untouched" : "CHANGED — investigate"}`);
    say("");
  }
  const failed = !warm.mesh.ok || !warm.control.ok || !result.settingsUntouched;
  const dearer = flag("--fail-if-dearer") && (result.meshVersusDirectPercent ?? 1) > 0;
  process.exit(failed || dearer ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
