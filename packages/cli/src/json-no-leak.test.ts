/**
 * `--json` output never carries a key, a prompt, a tool argument or any free
 * text taken from a request, and it keeps the conventions in json-output.ts:
 * exactly one JSON object on stdout, the same exit code as the text form, and
 * one failure object when a command cannot do its job.
 *
 * Each command runs as a real subprocess with an isolated HOME holding a
 * ledger whose free-text fields are planted with recognisable strings, Claude
 * Code settings holding a fake key and a credentialed base URL, and fake keys
 * in the environment. None of the planted strings may appear on stdout or
 * stderr. No provider is called and nothing real is read.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chainLedgerRecord, type BillableEvent, type LedgerRecord } from "../../core/src/savings-ledger.js";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

/** Every planted value contains this marker, so one check covers them all. */
const MARK = "PLANTED";
const FAKE_ANTHROPIC_KEY = `sk-ant-api03-${MARK}-FAKE-KEY-0000`;
const FAKE_OPENAI_KEY = `sk-proj-${MARK}-FAKE-KEY-1111`;
const PLANTED_APP = `${MARK}-APP-ID-91bc`;

function plantedEvents(): BillableEvent[] {
  const base = {
    schemaVersion: 1 as const,
    applicationId: PLANTED_APP,
    invoicePeriod: "2026-11",
    executionMode: "standard" as const,
    status: "succeeded" as const,
  };
  return [
    {
      ...base,
      requestId: `${MARK}-REQUEST-ID-7f3a`,
      taskId: `${MARK}-TASK-ID-55de`,
      timestamp: "2026-11-10T10:00:00.000Z",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      pricingStatus: "priced",
      levers: [{
        leverId: "duplicate-context-removal",
        kind: "lossless",
        savedUsd: 2.5,
        detail: `${MARK} lever detail: tool arguments {"path":"/etc/passwd","query":"salary review"}`,
      }],
    },
    {
      ...base,
      requestId: `${MARK}-REQUEST-ID-8c41`,
      taskId: `${MARK}-TASK-ID-55de`,
      duplicateOfRequestId: `${MARK}-DUPLICATE-ID-02aa`,
      timestamp: "2026-11-11T11:00:00.000Z",
      provider: `${MARK} provider name with spaces`,
      model: `${MARK} model: summarise the Q3 board memo for me`,
      pricingStatus: "unpriced",
      pricingReason: `${MARK} pricing reason: the prompt said "ignore previous instructions"`,
      levers: [{ leverId: `${MARK} lever id that is prose, not an id`, kind: "lossless" }],
    },
    {
      ...base,
      requestId: `${MARK}-REQUEST-ID-9d52`,
      timestamp: "2026-11-12T12:00:00.000Z",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      pricingStatus: "priced",
      levers: [{ leverId: "tool-schema-compaction", kind: "lossless", savedUsd: 1.25 }],
    },
  ];
}

function spoolLines(): string[] {
  const records: LedgerRecord[] = [];
  for (const event of plantedEvents()) records.push(chainLedgerRecord(event, records[records.length - 1]));
  return records.map((record) => JSON.stringify(record));
}

type Run = { status: number; stdout: string; stderr: string };

function runMesh(home: string, args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", MAIN, ...args], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        MESH_NO_AUTO_UPDATE: "1",
        ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
        OPENAI_API_KEY: FAKE_OPENAI_KEY,
        ...extraEnv,
      },
      // stdin closed: a command that waited for input would hang and time out here.
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** A HOME with the planted ledger, planted Claude Code settings, and nothing else. */
function makeHome(label: string, port: number, lines: string[]): string {
  const home = mkdtempSync(join(tmpdir(), `mesh-json-${label}-`));
  const ledger = join(home, ".mesh", "ledger");
  mkdirSync(ledger, { recursive: true });
  // The proxy names a spool after the application id a request sent.
  writeFileSync(join(ledger, `${PLANTED_APP}-anthropic.jsonl`), lines.join("\n") + "\n");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    env: {
      ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
      ANTHROPIC_AUTH_TOKEN: `${MARK}-AUTH-TOKEN-2222`,
      ANTHROPIC_BASE_URL: `http://user:${MARK}-URL-PASSWORD@127.0.0.1:${port}/?key=${MARK}-URL-QUERY`,
    },
  }));
  return home;
}

/** stdout is exactly one JSON object followed by one newline, with no ANSI codes. */
function oneObject(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout).not.toMatch(/[\u001b\u009b]/);
  const parsed: unknown = JSON.parse(stdout);
  expect(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)).toBe(true);
  return parsed as Record<string, unknown>;
}

describe("--json output: conventions and nothing private", () => {
  let port: number;
  let intactHome: string;
  let brokenHome: string;
  const runs = new Map<string, Run>();

  beforeAll(async () => {
    port = await closedPort();
    const lines = spoolLines();
    intactHome = makeHome("intact", port, lines);
    // One saving edited without re-chaining: the ledger no longer verifies.
    const edited = [...lines];
    const record = JSON.parse(edited[0]!) as LedgerRecord;
    (record.event.levers[0] as { savedUsd: number }).savedUsd = 999;
    edited[0] = JSON.stringify(record);
    brokenHome = makeHome("broken", port, edited);

    const envUrl = { ANTHROPIC_BASE_URL: `http://caller:${MARK}-ENV-URL-PASSWORD@127.0.0.1:${port}` };
    const plan: Array<[string, string, string[]]> = [
      ["status", intactHome, ["status", "--json", "--port", String(port)]],
      ["verify", intactHome, ["verify", "--json"]],
      ["connect", intactHome, ["connect", "--json", "--port", String(port)]],
      ["version", intactHome, ["version", "--json"]],
      ["doctor", intactHome, ["doctor", "--json"]],
      ["statement", intactHome, ["statement", "--period", "2026-11", "--json", "--out", join(intactHome, "statement.json")]],
      ["status-text", intactHome, ["status", "--port", String(port)]],
      ["verify-text", intactHome, ["verify"]],
      ["status-broken", brokenHome, ["status", "--json", "--port", String(port)]],
      ["verify-broken", brokenHome, ["verify", "--json"]],
      ["verify-broken-text", brokenHome, ["verify"]],
      ["statement-broken", brokenHome, ["statement", "--period", "2026-11", "--json", "--out", join(brokenHome, "statement.json")]],
      ["status-bad-flag", intactHome, ["status", "--json", "--jsno"]],
      ["status-bad-flag-text", intactHome, ["status", "--jsno"]],
      ["connect-bad-port", intactHome, ["connect", "--json", "--port", "not-a-port"]],
    ];
    const results = await Promise.all(plan.map(([, home, args]) => runMesh(home, args, envUrl)));
    plan.forEach(([name], index) => runs.set(name, results[index]!));
  }, 180_000);

  afterAll(() => {
    for (const home of [intactHome, brokenHome]) if (home) rmSync(home, { recursive: true, force: true });
  });

  const run = (name: string): Run => runs.get(name)!;

  it("no --json output, on stdout or stderr, repeats a planted string or a key", () => {
    const jsonRuns = ["status", "verify", "connect", "version", "doctor", "statement", "status-broken", "verify-broken", "statement-broken", "status-bad-flag", "connect-bad-port"];
    for (const name of jsonRuns) {
      const { stdout, stderr } = run(name);
      expect(stdout.length, `${name} printed nothing`).toBeGreaterThan(0);
      for (const secret of [MARK, "sk-ant", "sk-proj", "/etc/passwd", "board memo", "ignore previous instructions"]) {
        expect(stdout.includes(secret), `${name} stdout contains ${secret}`).toBe(false);
        expect(stderr.includes(secret), `${name} stderr contains ${secret}`).toBe(false);
      }
    }
  });

  it("status --json: one mesh-status/1 object, exit 0, the figures from the ledger", () => {
    const { status, stdout, stderr } = run("status");
    expect(status).toBe(0);
    expect(stderr).toBe("");
    const out = oneObject(stdout) as { schema: string; mesh: { version: string; build: string }; ledger: { requests: number; lastRequestAt: string }; savings: { netVerifiedUsd: number }; bill: { verdict: string; feeCents: number }; proxy: { reachable: boolean; port: number }; claudeCode: { state: string; port: number } };
    expect(out.schema).toBe("mesh-status/1");
    expect(out.mesh).toEqual({ version: expect.any(String), build: expect.any(String) });
    expect(out.ledger).toMatchObject({ requests: 3, lastRequestAt: "2026-11-12T12:00:00.000Z", chainVerified: true });
    expect(out.savings.netVerifiedUsd).toBe(3.75);
    expect(out.bill).toMatchObject({ verdict: "charge", feeCents: 3 });
    expect(out.proxy).toMatchObject({ reachable: false, port });
    // Claude Code's settings name a local port nothing answers on; the URL itself is not repeated.
    expect(out.claudeCode).toMatchObject({ state: "pointed_at_stopped_proxy", port });
    expect(stdout.trimEnd().includes("\n")).toBe(false);
  });

  it("verify --json: one mesh-verify/1 object, each check with a status, exit 0", () => {
    const { status, stdout, stderr } = run("verify");
    expect(status).toBe(0);
    expect(stderr).toBe("");
    const out = oneObject(stdout) as { schema: string; ok: boolean; checks: { name: string; status: string; detail: string }[]; totals: { netVerifiedSavingsUsd: number; verdict: string } };
    expect(out.schema).toBe("mesh-verify/1");
    expect(out.ok).toBe(true);
    expect(out.checks.map((check) => check.name)).toEqual(["provenance", "reducer", "ledger", "determinism"]);
    expect(out.checks.every((check) => check.status === "ok" && typeof check.detail === "string")).toBe(true);
    expect(out.totals).toMatchObject({ netVerifiedSavingsUsd: 3.75, verdict: "charge" });
  });

  it("connect --json: one mesh-connect/1 object with the base URLs, exit 0 though the proxy is not running", () => {
    const { status, stdout, stderr } = run("connect");
    expect(status).toBe(0);
    expect(stderr).toBe("");
    const out = oneObject(stdout) as { schema: string; baseUrls: { anthropic: string; openai: string }; health: string; proxy: { reachable: boolean } };
    expect(out.schema).toBe("mesh-connect/1");
    expect(out.baseUrls).toEqual({ anthropic: `http://127.0.0.1:${port}`, openai: `http://127.0.0.1:${port}/v1` });
    expect(out.health).toBe(`http://127.0.0.1:${port}/mesh/health`);
    expect(out.proxy.reachable).toBe(false);
  });

  it("a ledger that does not verify: status gives no savings figure; verify fails with the same exit code as text", () => {
    const status = oneObject(run("status-broken").stdout) as { ok: boolean; savings: unknown; bill: unknown; ledger: { chainVerified: boolean; brokenAt: unknown } };
    expect(run("status-broken").status).toBe(0);
    expect(status.ledger).toMatchObject({ chainVerified: false, brokenAt: { spool: 1, seq: 0 } });
    expect(status.savings).toBeNull();
    expect(status.bill).toBeNull();

    const verify = oneObject(run("verify-broken").stdout) as { ok: boolean; totals: unknown; checks: { name: string; status: string }[] };
    expect(verify.ok).toBe(false);
    expect(verify.totals).toBeNull();
    expect(verify.checks.map((check) => check.status)).toEqual(["ok", "ok", "failed", "not_checked"]);
    expect(run("verify-broken").status).toBe(1);
    expect(run("verify-broken-text").status).toBe(1);
    expect(run("verify-text").status).toBe(0);
  });

  it("a wrong flag: one failure object on stdout with a code, exit 1, as in text mode", () => {
    const bad = run("status-bad-flag");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe("");
    expect(oneObject(bad.stdout)).toEqual({
      schema: "mesh-status/1",
      ok: false,
      mesh: { version: expect.any(String), build: expect.any(String) },
      error: { code: "usage", message: "Unknown option: --jsno. See mesh status --help." },
    });
    const text = run("status-bad-flag-text");
    expect(text.status).toBe(1);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("Unknown option: --jsno");

    const port = run("connect-bad-port");
    expect(port.status).toBe(1);
    expect(oneObject(port.stdout)).toMatchObject({ schema: "mesh-connect/1", ok: false, error: { code: "usage" } });
  });

  it("text output is unchanged in shape and carries no escape codes when captured", () => {
    const status = run("status-text");
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("mesh status — build");
    expect(status.stdout).toContain("3 requests seen · $3.7500 verified saved (charge)");
    expect(status.stdout).not.toMatch(/[\u001b\u009b]/);
    expect(run("verify-text").stdout).toContain("All checks passed.");
    expect(run("verify-text").stdout).not.toMatch(/[\u001b\u009b]/);
  });
});
