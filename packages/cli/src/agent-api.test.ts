/**
 * The in-process API an agent-facing caller uses (agent-api.ts): each function
 * returns a typed result and a caller can tell every state apart without
 * parsing text. Run against temporary directories and an in-process proxy on
 * a free port; nothing here reads the real ~/.mesh or ~/.claude.
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chainLedgerRecord, type BillableEvent, type LedgerRecord } from "../../core/src/savings-ledger.js";
import { startMeshProxy } from "../../sdk-js/src/proxy.js";
import { collectConnect, collectStatus, collectVerify, summariseLedger, type StatusOptions } from "./agent-api.js";

const event = (requestId: string, savedUsd: number, timestamp: string): BillableEvent => ({
  schemaVersion: 1,
  requestId,
  applicationId: "proxy",
  invoicePeriod: timestamp.slice(0, 7),
  timestamp,
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  executionMode: "standard",
  pricingStatus: "priced",
  levers: [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd }],
  status: "succeeded",
});

function spoolLines(savings: number[]): string[] {
  const records: LedgerRecord[] = [];
  savings.forEach((savedUsd, index) => {
    records.push(chainLedgerRecord(event(`r${index}`, savedUsd, `2026-11-1${index}T09:30:00.000Z`), records[records.length - 1]));
  });
  return records.map((record) => JSON.stringify(record));
}

/** Edit one saving in place without re-chaining: the tamper the chain exists to catch. */
function tamper(lines: string[], index: number, savedUsd: number): string[] {
  const copy = [...lines];
  const record = JSON.parse(copy[index]!) as LedgerRecord;
  (record.event.levers[0] as { savedUsd: number }).savedUsd = savedUsd;
  copy[index] = JSON.stringify(record);
  return copy;
}

/** A port nothing is listening on: bind one, note it, release it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

describe("agent-api: results an in-process caller reads", () => {
  let home: string;
  let meshHome: string;
  let ledger: string;
  let settings: string;
  let options: StatusOptions;
  const closers: Array<() => Promise<unknown>> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "mesh-agent-api-"));
    meshHome = join(home, ".mesh");
    ledger = join(meshHome, "ledger");
    settings = join(home, ".claude", "settings.json");
    mkdirSync(ledger, { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    options = {
      port: await closedPort(),
      meshHome,
      claudeSettingsPath: settings,
      plistPath: join(home, "no-such.plist"),
      env: {},
    };
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    rmSync(home, { recursive: true, force: true });
  });

  const writeSpool = (lines: string[], name = "proxy-anthropic.jsonl"): void =>
    writeFileSync(join(ledger, name), lines.join("\n") + "\n");
  const pointClaudeAt = (baseUrl: string): void =>
    writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl } }));
  const startProxy = async (): Promise<number> => {
    const proxy = await startMeshProxy({ ledgerDirectory: join(home, "proxy-ledger") });
    closers.push(() => proxy.close());
    return Number(new URL(proxy.url).port);
  };

  describe("collectStatus", () => {
    it("a machine with nothing on it: every part says so, and nothing is charged", async () => {
      const status = await collectStatus(options);
      expect(status.schema).toBe("mesh-status/1");
      expect(status.ok).toBe(true);
      expect(status.mesh).toEqual({ version: expect.any(String), build: expect.any(String) });
      expect(status.runtime).toEqual({ cached: false, cachedVersion: null, launcherInstalled: false, runningFromCache: false });
      expect(status.proxy).toMatchObject({ reachable: false, portOpen: false, port: options.port, portSource: "flag" });
      expect(status.proxy.baseUrls).toEqual({
        anthropic: `http://127.0.0.1:${options.port}`,
        openai: `http://127.0.0.1:${options.port}/v1`,
      });
      expect(status.proxy.health).toBe(`http://127.0.0.1:${options.port}/mesh/health`);
      expect(status.claudeCode).toMatchObject({ state: "not_pointed", pointedAtMesh: false, port: null });
      expect(status.ledger).toMatchObject({ path: ledger, empty: true, requests: 0, firstRequestAt: null, lastRequestAt: null, chainVerified: true });
      expect(status.currency).toBe("USD");
      expect(status.savings).toEqual({ netVerifiedUsd: 0, netVerifiedCents: 0, hasVerifiedSavings: false });
      expect(status.bill).toEqual({
        scope: "all_periods",
        feePercent: 1,
        verdict: "do_not_charge",
        reasonCode: "no_requests",
        reason: "no requests are recorded",
        feeCents: 0,
        feeUsd: 0,
      });
      expect(status.theo).toEqual({ hasRun: false, mode: "unknown", pendingProposals: 0 });
      expect(status.coverage.levers.length).toBe(status.coverage.enforceableLevers);
      expect(status.coverage.active + status.coverage.held + status.coverage.available).toBe(status.coverage.enforceableLevers);
    });

    it("a cached runtime and an installed launcher are reported", async () => {
      mkdirSync(join(meshHome, "runtime"), { recursive: true });
      mkdirSync(join(meshHome, "bin"), { recursive: true });
      writeFileSync(join(meshHome, "runtime", "mesh-runtime.mjs"), "// stand-in\n");
      writeFileSync(join(meshHome, "runtime", "version"), "abc1234\n");
      writeFileSync(join(meshHome, "bin", "mesh"), "#!/bin/sh\n");
      const { runtime } = await collectStatus(options);
      expect(runtime).toEqual({ cached: true, cachedVersion: "abc1234", launcherInstalled: true, runningFromCache: false });
    });

    it("a ledger that verifies: requests, the last request time, savings and the bill's verdict with fee cents", async () => {
      writeSpool(spoolLines([50, 52.4494]));
      const status = await collectStatus(options);
      expect(status.ledger).toMatchObject({
        empty: false,
        requests: 2,
        firstRequestAt: "2026-11-10T09:30:00.000Z",
        lastRequestAt: "2026-11-11T09:30:00.000Z",
        chainVerified: true,
      });
      expect(status.ledger.brokenAt).toBeUndefined();
      expect(status.savings).toEqual({ netVerifiedUsd: 102.4494, netVerifiedCents: 10245, hasVerifiedSavings: true });
      // 1% of US$102.4494 is 102.4494 cents, billed as 102: rounded down, never more than 1%.
      expect(status.bill).toEqual({ scope: "all_periods", feePercent: 1, verdict: "charge", feeCents: 102, feeUsd: 1.02 });
      // The same arithmetic the text output prints, from the one summary.
      const summary = summariseLedger(ledger);
      expect(status.savings!.netVerifiedUsd).toBe(summary.savedUsd);
      expect(status.bill!.verdict).toBe(summary.verdict);
    });

    it("savings too small to bill: do_not_charge, with the reason", async () => {
      writeSpool(spoolLines([0.2, 0.3]));
      const { savings, bill } = await collectStatus(options);
      expect(savings).toEqual({ netVerifiedUsd: 0.5, netVerifiedCents: 50, hasVerifiedSavings: true });
      expect(bill).toMatchObject({ verdict: "do_not_charge", reasonCode: "fee_below_one_cent", reason: "the 1% fee is below one cent", feeCents: 0 });
    });

    it("a ledger that does not verify: no savings figure and no verdict, exactly as the text output", async () => {
      writeSpool(tamper(spoolLines([50, 2.4494]), 1, 100));
      const status = await collectStatus(options);
      expect(status.ok).toBe(true);
      expect(status.ledger).toMatchObject({ empty: false, requests: 2, chainVerified: false, brokenAt: { spool: 1, seq: 1 } });
      expect(status.savings).toBeNull();
      expect(status.bill).toBeNull();
    });

    it("the proxy answering: reachable on its port, and a caller's own base URL is recognised", async () => {
      const port = await startProxy();
      const status = await collectStatus({
        ...options,
        port,
        env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, OPENAI_BASE_URL: "https://api.openai.com/v1" },
      });
      expect(status.proxy).toMatchObject({ reachable: true, portOpen: true, port });
      expect(status.callerEnvironment).toEqual({ anthropicBaseUrlPointsAtMesh: true, openaiBaseUrlPointsAtMesh: false });
    });

    it("another program on the port: open, but not MESH", async () => {
      const other: Server = createServer((_req, res) => { res.writeHead(200); res.end("hello"); });
      await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
      closers.push(() => new Promise((done) => other.close(done)));
      const port = (other.address() as { port: number }).port;
      const { proxy } = await collectStatus({ ...options, port });
      expect(proxy).toMatchObject({ reachable: false, portOpen: true, port });
    });

    it("Claude Code pointed at a MESH proxy that answers", async () => {
      const port = await startProxy();
      pointClaudeAt(`http://127.0.0.1:${port}`);
      const { claudeCode } = await collectStatus({ ...options, port });
      expect(claudeCode).toMatchObject({ state: "pointed_at_mesh", pointedAtMesh: true, port, startSessionRunning: false });
      expect(claudeCode.detectedBy).toContain("~/.claude/settings.json");
    });

    it("Claude Code pointed at a running `mesh start` session: the session record is recognised", async () => {
      const port = await startProxy();
      pointClaudeAt(`http://127.0.0.1:${port}`);
      writeFileSync(join(meshHome, "claude-wiring.json"), JSON.stringify({
        pid: process.pid, proxyUrl: `http://127.0.0.1:${port}`, priorBaseUrl: null, hadFile: false, at: "2026-11-23T10:00:00.000Z",
      }));
      // No --port: the port comes from the session's own record.
      const status = await collectStatus({ ...options, port: undefined });
      expect(status.proxy).toMatchObject({ reachable: true, port, portSource: "start-session" });
      expect(status.claudeCode).toMatchObject({ state: "pointed_at_mesh", pointedAtMesh: true, port, startSessionRunning: true });
    });

    it("Claude Code left pointing at a proxy that has stopped", async () => {
      const dead = await closedPort();
      pointClaudeAt(`http://127.0.0.1:${dead}`);
      const { claudeCode } = await collectStatus(options);
      expect(claudeCode).toMatchObject({ state: "pointed_at_stopped_proxy", pointedAtMesh: false, port: dead });
    });

    it("Claude Code pointed somewhere that is not MESH, with a credential in the URL: the URL is not repeated", async () => {
      pointClaudeAt("https://user:url-secret-value@gateway.example/anthropic?key=query-secret-value");
      const status = await collectStatus(options);
      expect(status.claudeCode).toMatchObject({ state: "pointed_elsewhere", pointedAtMesh: false, port: null });
      const text = JSON.stringify(status);
      expect(text).not.toContain("url-secret-value");
      expect(text).not.toContain("query-secret-value");
      expect(text).not.toContain("gateway.example");
    });

    it("settings that are not valid JSON: unknown, not a guess", async () => {
      writeFileSync(settings, "{ not json");
      const { claudeCode } = await collectStatus(options);
      expect(claudeCode).toMatchObject({ state: "settings_invalid", pointedAtMesh: "unknown" });
    });

    it("Theo's last mode and his open proposals are read from his memory file", async () => {
      mkdirSync(join(ledger, "theo"), { recursive: true });
      writeFileSync(join(ledger, "theo", "local.json"), JSON.stringify({
        schemaVersion: 1, customer: "local", autonomy: "recommend",
        proposals: [{ lever: "output-cap", message: "free text that must stay out" }],
      }));
      const status = await collectStatus(options);
      expect(status.theo).toEqual({ hasRun: true, mode: "recommend", pendingProposals: 1 });
      expect(JSON.stringify(status)).not.toContain("free text that must stay out");
    });
  });

  describe("collectVerify", () => {
    const verify = (): ReturnType<typeof collectVerify> =>
      collectVerify({ ledgerDir: ledger, runtimeDir: join(meshHome, "runtime") });

    it("no ledger yet: every check ok, no totals", () => {
      const result = verify();
      expect(result.schema).toBe("mesh-verify/1");
      expect(result.ok).toBe(true);
      expect(result.checks.map((check) => [check.name, check.status])).toEqual([
        ["provenance", "ok"], ["reducer", "ok"], ["ledger", "ok"], ["determinism", "ok"],
      ]);
      expect(result.ledger).toEqual({ path: ledger, spools: 0, records: 0, chainVerified: true, failures: [] });
      expect(result.totals).toBeNull();
    });

    it("an intact ledger: the totals the text prints, as numbers", () => {
      writeSpool(spoolLines([50, 52.4494]));
      const result = verify();
      expect(result.ok).toBe(true);
      expect(result.ledger).toMatchObject({ spools: 1, records: 2, chainVerified: true });
      expect(result.currency).toBe("USD");
      expect(result.totals).toEqual({
        netVerifiedSavingsUsd: 102.4494,
        netVerifiedSavingsCents: 10245,
        feePercent: 1,
        feeCents: 102,
        feeUsd: 1.02,
        verdict: "charge",
      });
      expect(result.checks.find((check) => check.name === "determinism")!.detail)
        .toBe("invoice recomputes identically: $102.4494 verified (charge)");
    });

    it("a tampered ledger: failed, determinism not checked, no totals, and the spool is numbered not named", () => {
      writeSpool(spoolLines([1, 2]), "aaa-anthropic.jsonl");
      writeSpool(tamper(spoolLines([50, 2.4494]), 0, 100), "customer-app-name-anthropic.jsonl");
      const result = verify();
      expect(result.ok).toBe(false);
      expect(result.checks.map((check) => [check.name, check.status])).toEqual([
        ["provenance", "ok"], ["reducer", "ok"], ["ledger", "failed"], ["determinism", "not_checked"],
      ]);
      expect(result.checks[2]!.detail).toBe("spool 2: hash chain broken at seq 0");
      expect(result.ledger).toMatchObject({ spools: 2, chainVerified: false, failures: [{ spool: 2, problem: "broken_chain", seq: 0 }] });
      expect(result.totals).toBeNull();
      expect(JSON.stringify(result)).not.toContain("customer-app-name");
    });

    it("a line that is not a ledger record: failed, with the line number", () => {
      writeSpool([...spoolLines([1]), "{ this is not json"]);
      const result = verify();
      expect(result.ok).toBe(false);
      expect(result.ledger.failures).toEqual([{ spool: 1, problem: "unreadable_line", line: 2 }]);
      expect(result.totals).toBeNull();
    });

    it("a cached runtime that no longer matches its download checksum fails provenance", () => {
      mkdirSync(join(meshHome, "runtime"), { recursive: true });
      writeFileSync(join(meshHome, "runtime", "mesh-runtime.mjs"), "// altered\n");
      writeFileSync(join(meshHome, "runtime", "sha256"), "0".repeat(64));
      const result = verify();
      expect(result.ok).toBe(false);
      expect(result.checks[0]).toMatchObject({ name: "provenance", status: "failed" });
    });
  });

  describe("collectConnect", () => {
    it("names the base URLs, the health URL and each client's setting for the port, running or not", async () => {
      const port = options.port!;
      const result = await collectConnect({ port });
      expect(result.schema).toBe("mesh-connect/1");
      expect(result.ok).toBe(true);
      expect(result.proxy).toEqual({ reachable: false, portOpen: false, port, portSource: "flag" });
      expect(result.baseUrls).toEqual({ anthropic: `http://127.0.0.1:${port}`, openai: `http://127.0.0.1:${port}/v1` });
      expect(result.health).toBe(`http://127.0.0.1:${port}/mesh/health`);
      expect(result.startCommand).toBe(`mesh proxy --port ${port}`);
      const byId = Object.fromEntries(result.clients.map((client) => [client.id, client]));
      expect(byId["claude-code"]!.env).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` });
      expect(byId.anthropic!.env).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` });
      expect(byId.openai!.env).toEqual({ OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` });
      expect(byId["openai-compatible"]!.instruction).toContain("--openai-base");
      expect(Object.keys(byId)).toEqual(["claude-code", "anthropic", "openai", "openai-compatible", "framework"]);
    });

    it("says the proxy is answering when it is, and its health URL really answers", async () => {
      const port = await startProxy();
      const result = await collectConnect({ port });
      expect(result.proxy).toMatchObject({ reachable: true, portOpen: true, port });
      const health = await (await fetch(result.health)).json();
      expect(health).toEqual({ status: "ok", service: "mesh-proxy" });
    });
  });
});
