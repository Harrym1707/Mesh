/**
 * Installed is not connected, and every command a person reaches for says so.
 *
 * The home directory here is the founder's own on 2026-11-23: the launcher
 * at ~/.mesh/bin/mesh, a runtime folder, an empty ledger, no background
 * service, a Claude Code that is not pointed at Mesh, nothing listening.
 * Bare `mesh`, `mesh status` and `mesh doctor` must each say it is not
 * connected and name `mesh setup`.
 *
 * In-process where the function takes its paths (exact text, on a port known
 * to be closed), and as a real process in that home for both entry points.
 */
import { rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectStatus, type StatusOptions } from "./daemon.js";
import { DEFAULT_PORT } from "./machine.js";
import { monthSoFarLine, renderSummary, runSummary } from "./summary.js";
import {
  closedPort,
  fakeServiceRunner,
  makeInstalledNeverConnectedHome,
  portIsOpen,
  runMeshProcess,
  spoolLines,
  standInProxy,
  writeSpool,
  type FakeHome,
} from "./setup-testkit.js";

const NOT_CONNECTED = "Mesh is installed but not connected, so it has seen nothing and saved nothing.";
const NOW = new Date("2026-11-23T15:00:00.000Z");

describe("installed, never connected", () => {
  let fake: FakeHome;
  let options: StatusOptions;
  const closers: Array<() => Promise<unknown>> = [];

  beforeEach(async () => {
    fake = makeInstalledNeverConnectedHome();
    options = {
      port: await closedPort(),
      meshHome: fake.meshHome,
      claudeSettingsPath: fake.claudeSettingsPath,
      plistPath: fake.plistPath,
      env: {},
      now: NOW,
      timeZone: "UTC",
      runner: fakeServiceRunner(),
      platform: "darwin",
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of closers.splice(0)) await close();
    rmSync(fake.home, { recursive: true, force: true });
  });

  /** What a function printed to stdout through console.log. */
  async function printed(run: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
    try { await run(); } finally { vi.restoreAllMocks(); }
    return lines.join("\n");
  }

  it("status as data: the flow says not_set_up and the fix is mesh setup", async () => {
    const status = await collectStatus(options);
    expect(status.runtime).toMatchObject({ cached: true, launcherInstalled: true });
    expect(status.service.installed).toBe(false);
    expect(status.proxy.reachable).toBe(false);
    expect(status.claudeCode.state).toBe("not_pointed");
    expect(status.ledger.empty).toBe(true);
    expect(status.flow).toEqual({
      state: "not_set_up",
      headline: NOT_CONNECTED,
      detail: expect.stringContaining("Installing Mesh does not connect it"),
      fix: "mesh setup",
    });
    // `flow` comes straight after the envelope, before every other part.
    expect(Object.keys(status).slice(0, 4)).toEqual(["schema", "ok", "mesh", "flow"]);
  });

  it("bare mesh: identity, the headline and the fix, where the dashboard and the report are, and no usage text", async () => {
    const out = await printed(() => runSummary(options));
    const lines = out.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    expect(lines[0]).toMatch(/^Mesh \S+ \(build \S+\): /);
    expect(lines[1]).toBe(NOT_CONNECTED);
    expect(lines[2]).toBe("Fix: mesh setup");
    expect(out).toContain("mesh dashboard");
    expect(out).toContain("mesh report");
    expect(out).toContain("mesh --help for all commands");
    expect(out).not.toContain("Usage: mesh <command>");
    // No ledger, so no money line.
    expect(out).not.toContain("This month so far");
    expect(out).not.toContain("$");
  });

  it("bare mesh with a verified ledger: this month so far, from the bill's own figures", async () => {
    writeSpool(fake.ledgerDir, spoolLines([[6.2, "2026-11-20T09:30:00.000Z"], [6.2, "2026-11-23T14:58:00.000Z"]]));
    const proxy = standInProxy(options.port!);
    await proxy.listen();
    closers.push(() => proxy.close());
    writeFileSync(fake.claudeSettingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${options.port}` } }));
    const status = await collectStatus(options);
    expect(status.flow.state).toBe("flowing");
    const line = monthSoFarLine(status, { meshHome: fake.meshHome, now: NOW });
    expect(line).toBe("This month so far (November): saved $12.40, fee so far $0.12.");
    const out = renderSummary(status, line);
    expect(out).toContain("Mesh is working: the last request went through it 2 minutes ago.");
    expect(out).toContain("This month so far (November): saved $12.40, fee so far $0.12.");
    expect(out).not.toContain("Fix:");
  });

  it("bare mesh with a ledger that does not verify: no figure at all, and the fix is mesh verify", async () => {
    const lines = spoolLines([[6.2, "2026-11-20T09:30:00.000Z"], [6.2, "2026-11-23T14:58:00.000Z"]]);
    const tampered = JSON.parse(lines[1]!) as { event: { levers: Array<{ savedUsd: number }> } };
    tampered.event.levers[0]!.savedUsd = 600;
    writeSpool(fake.ledgerDir, [lines[0]!, JSON.stringify(tampered)]);
    const status = await collectStatus(options);
    expect(status.flow.state).toBe("ledger_not_verified");
    expect(monthSoFarLine(status, { meshHome: fake.meshHome, now: NOW })).toBeNull();
    const out = await printed(() => runSummary(options));
    expect(out).toContain("Mesh's ledger did not pass its check, so there is no savings figure.");
    expect(out).toContain("Fix: mesh verify");
    expect(out).not.toContain("$");
  });

  describe("as a real process in that home", () => {
    // These commands look at the default port. On a developer's machine
    // something may be listening there; the exact sentence is then a different
    // (also not-connected) one, and only what always holds is asserted.
    const expectNotConnected = async (text: string): Promise<void> => {
      expect(text).toContain("Fix: mesh setup");
      if (!(await portIsOpen(DEFAULT_PORT))) expect(text).toContain(NOT_CONNECTED);
    };

    for (const entry of ["runtime", "main"] as const) {
      it(`bare mesh (${entry} entry) prints the summary, not the usage text`, { timeout: 60_000 }, async () => {
        const result = runMeshProcess(fake, [], { entry });
        expect(result.status).toBe(0);
        await expectNotConnected(result.stdout);
        expect(result.stdout).toContain("mesh --help for all commands");
        expect(result.stdout).not.toContain("Usage: mesh <command>");
      });

      it(`mesh --help, mesh -h and mesh help (${entry} entry) print the usage text`, { timeout: 90_000 }, () => {
        for (const flag of ["--help", "-h", "help"]) {
          const result = runMeshProcess(fake, [flag], { entry });
          expect(result.status, flag).toBe(0);
          expect(result.stdout, flag).toContain("Usage: mesh <command>");
          expect(result.stdout, flag).not.toContain("Fix: mesh setup");
        }
      });

      it(`mesh --json (${entry} entry) is mesh status --json: one object with the flow`, { timeout: 60_000 }, async () => {
        const bare = runMeshProcess(fake, ["--json"], { entry });
        const status = runMeshProcess(fake, ["status", "--json"], { entry });
        expect(bare.status).toBe(0);
        expect(bare.stdout.endsWith("}\n")).toBe(true);
        expect(bare.stdout.trim().includes("\n")).toBe(false);
        const parsed = JSON.parse(bare.stdout) as { schema: string; flow: { state: string; fix: string | null } };
        expect(parsed.schema).toBe("mesh-status/1");
        expect(parsed.flow.fix).toMatch(/^mesh setup/);
        expect(Object.keys(parsed)).toEqual(Object.keys(JSON.parse(status.stdout) as object));
      });
    }

    it("mesh status says it first, on a port known to be closed, and keeps the rest", { timeout: 60_000 }, async () => {
      const port = await closedPort();
      const result = runMeshProcess(fake, ["status", "--port", String(port)]);
      expect(result.status).toBe(0);
      const lines = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
      expect(lines[0]).toBe(NOT_CONNECTED);
      expect(lines[1]).toBe("Fix: mesh setup");
      expect(lines[2]).toMatch(/^mesh status — build /);
      expect(result.stdout).toContain("service   not installed");
      expect(result.stdout).toContain("proxy     not responding");
      expect(result.stdout).toContain("coverage  live on");
      // "Use Claude Code and check back" would be false: nothing points at Mesh.
      expect(result.stdout).not.toContain("use Claude Code and check back");

      const json = runMeshProcess(fake, ["status", "--port", String(port), "--json"]);
      const parsed = JSON.parse(json.stdout) as { flow: { state: string; headline: string; fix: string } };
      expect(parsed.flow).toMatchObject({ state: "not_set_up", headline: NOT_CONNECTED, fix: "mesh setup" });
    });

    it("mesh doctor says it first, keeps its checks, and does not call the machine healthy", { timeout: 60_000 }, async () => {
      const result = runMeshProcess(fake, ["doctor"]);
      expect(result.status).toBe(0);
      await expectNotConnected(result.stdout);
      const lines = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
      expect(lines.findIndex((line) => line.startsWith("Fix: mesh setup"))).toBeLessThan(lines.findIndex((line) => line.startsWith("mesh doctor — build")));
      expect(result.stdout).toContain("node");
      expect(result.stdout).toContain("ledger");
      expect(result.stdout).not.toContain("Looks healthy.");
      expect(result.stdout).toContain("nothing is flowing through Mesh yet");

      const json = runMeshProcess(fake, ["doctor", "--json"]);
      expect(json.status).toBe(0);
      const parsed = JSON.parse(json.stdout) as { flow: { state: string; fix: string | null }; checks: Array<{ name: string }> };
      expect(parsed.flow.fix).toMatch(/^mesh setup/);
      expect(parsed.checks.map((check) => check.name)).toEqual(expect.arrayContaining(["node", "proxy", "claude", "ledger"]));
    });
  });
});
