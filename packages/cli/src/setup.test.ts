/**
 * `mesh setup`, end to end against fakes.
 *
 * Every run here works on a temporary home directory, a FAKE service manager
 * that records what `launchctl` would have been asked (setup-testkit.ts), and
 * a stand-in proxy that answers the health check when that fake "loads" the
 * service. The real launchctl is never reached: launchd registers an agent
 * for the logged-in user whatever HOME says.
 *
 * The same service code `mesh install` and `mesh uninstall` run is what is
 * exercised (daemon.ts installService / uninstallService), with its file
 * paths and its runner passed in.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { repairWiring } from "./claude-wiring.js";
import { collectStatus, stopService, uninstallService, type ServiceTarget } from "./daemon.js";
import { CliError } from "./json-output.js";
import { portOpen, probeProxy } from "./machine.js";
import { parseSetupArgs, renderSetupResult, runSetup, setupMesh, type SetupArgs, type SetupOptions, type SetupResult } from "./setup.js";
import {
  closedPort,
  fakeServiceRunner,
  listTree,
  makeInstalledNeverConnectedHome,
  runMeshProcess,
  standInProxy,
  type FakeHome,
  type FakeServiceRunner,
} from "./setup-testkit.js";

const NOW = new Date("2026-11-23T15:00:00.000Z");
/** Planted so a leak would show: nothing setup prints may contain any of these. */
const PLANTED_KEY = "sk-ant-PLANTED-0123456789";
const PLANTED_SETTINGS_KEY = "sk-ant-SETTINGS-PLANTED-abcdef";
const PLANTED_URL = "https://gateway-user:sk-URL-PLANTED-token@gateway.internal.example/v1?api_key=sk-QUERY-PLANTED";
const SECRETS = ["sk-ant", "PLANTED", "gateway-user", "gateway.internal.example", "api_key"];

describe("mesh setup", () => {
  let fake: FakeHome;
  let runner: FakeServiceRunner;
  let port: number;
  let proxy: ReturnType<typeof standInProxy>;
  let said: string[];
  let options: SetupOptions;
  let target: ServiceTarget;
  let originalSettings: string;
  const exitCodeBefore = process.exitCode;

  const args = (extra: Partial<SetupArgs> = {}): SetupArgs => ({ yes: false, dryRun: false, json: false, port, ...extra });
  /** Everything a run printed: what it said as it went, then its closing words. */
  const transcript = (result: SetupResult): string => `${said.join("\n")}\n${renderSetupResult(result)}`;
  const settings = (): { env?: Record<string, string> } & Record<string, unknown> =>
    JSON.parse(readFileSync(fake.claudeSettingsPath, "utf8")) as { env?: Record<string, string> } & Record<string, unknown>;
  const expectNoSecret = (text: string): void => { for (const secret of SECRETS) expect(text).not.toContain(secret); };
  const quickWait = async (wanted: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await probeProxy(wanted, 500)).isMesh) return true;
      await new Promise((done) => setTimeout(done, 25));
    }
    return false;
  };
  const refusal = async (run: Promise<unknown>): Promise<CliError> => {
    const error = await run.then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  };

  beforeEach(async () => {
    fake = makeInstalledNeverConnectedHome();
    originalSettings = readFileSync(fake.claudeSettingsPath, "utf8");
    runner = fakeServiceRunner();
    port = await closedPort();
    proxy = standInProxy(port);
    // The fake service manager "starts" Mesh: the stand-in proxy answers once the agent is loaded.
    runner.onLoad = () => { void proxy.listen(); };
    runner.onUnload = () => { void proxy.close(); };
    said = [];
    const launcher = join(fake.home, "Downloads", "mesh");
    mkdirSync(join(fake.home, "Downloads"), { recursive: true });
    writeFileSync(launcher, "#!/usr/bin/env node\n// the downloaded launcher\n");
    target = { meshHome: fake.meshHome, plistPath: fake.plistPath, claudeSettingsPath: fake.claudeSettingsPath, runner };
    options = {
      ...target,
      wiringStatePath: fake.wiringStatePath,
      platform: "darwin",
      env: { ANTHROPIC_API_KEY: PLANTED_KEY, OPENAI_API_KEY: PLANTED_KEY },
      now: NOW,
      timeZone: "UTC",
      launcherPath: launcher,
      nodePath: "/usr/local/bin/node",
      waitForProxy: quickWait,
      say: (line) => { said.push(line); },
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = exitCodeBefore;
    await proxy.close();
    rmSync(fake.home, { recursive: true, force: true });
  });

  describe("on a machine that was installed and never connected", () => {
    it("--dry-run prints the plan in plain words, says nothing was changed, and changes nothing", async () => {
      const before = listTree(fake.home);
      const result = await setupMesh(args({ dryRun: true }), options);
      expect(listTree(fake.home)).toEqual(before);
      expect(runner.calls.filter((call) => call[0] !== "list")).toEqual([]);
      expect(result).toMatchObject({
        schema: "mesh-setup/1",
        ok: true,
        dryRun: true,
        client: "claude-code",
        alwaysOn: true,
        defaulted: ["client", "alwaysOn"],
        changed: false,
        connected: false,
        alreadyConnected: false,
        flow: { state: "not_set_up", fix: "mesh setup" },
      });
      expect(result.plan.map((step) => step.id)).toEqual(["copy_launcher", "write_service_definition", "register_service", "point_claude_code"]);
      const text = transcript(result);
      expect(text).toContain("Mesh would make these changes:");
      expect(text).toContain(fake.plistPath);
      expect(text).toContain(`"mesh serve --port ${port}"`);
      expect(text).toContain(`Set env.ANTHROPIC_BASE_URL to http://127.0.0.1:${port} in ${fake.claudeSettingsPath}`);
      expect(text).toContain("Everything else in that file is kept.");
      expect(text).toContain("Mesh does not read, ask for or store your API key");
      expect(text).toContain("Undo all of it at any time with: mesh uninstall");
      expect(text).toContain("Dry run: nothing was changed.");
      expect(text).toContain("Right now: Mesh is installed but not connected, so it has seen nothing and saved nothing.");
      expect(text).toContain(`mesh setup --client claude-code --always-on --port ${port} --yes`);
      expectNoSecret(text);
    });

    it("as a real process: mesh setup --dry-run prints the plan and that nothing was changed", { timeout: 60_000 }, () => {
      const before = listTree(fake.home);
      const result = runMeshProcess(fake, ["setup", "--dry-run", "--port", String(port)]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Mesh would make these changes:");
      expect(result.stdout).toContain("~/.claude/settings.json");
      expect(result.stdout).toContain("~/Library/LaunchAgents/dev.meshtoken.mesh.plist");
      expect(result.stdout).toContain("Dry run: nothing was changed.");
      expect(result.stdout).toContain("Mesh is installed but not connected");
      expect(listTree(fake.home)).toEqual(before);
    });
  });

  describe("Claude Code, always on", () => {
    it("writes the service, points Claude Code, waits for the proxy, and says it is connected", async () => {
      const result = await setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options);
      expect(result).toMatchObject({
        ok: true,
        connected: true,
        alreadyConnected: false,
        changed: true,
        rolledBack: false,
        via: "service",
        fix: null,
        undo: ["mesh uninstall"],
        flow: { state: "connected_idle" },
        weeklyReport: { notifications: "on", turnOff: "mesh report --off" },
      });
      expect(result.error).toBeUndefined();

      // The service definition, at the temporary path, running the stable launcher copy.
      const plist = readFileSync(fake.plistPath, "utf8");
      expect(plist).toContain("<string>dev.meshtoken.mesh</string>");
      expect(plist).toContain(`<string>${join(fake.meshHome, "bin", "mesh")}</string>`);
      expect(plist).toMatch(new RegExp(`<string>serve</string>\\s*<string>--port</string>\\s*<string>${port}</string>`));
      expect(plist).toContain(`<string>${join(fake.meshHome, "ledger")}</string>`);
      expect(readFileSync(join(fake.meshHome, "bin", "mesh"), "utf8")).toContain("the downloaded launcher");
      // The fake service manager was asked to load exactly that file.
      expect(runner.calls).toContainEqual(["load", "-w", fake.plistPath]);
      expect(runner.loaded).toBe(true);
      // Claude Code is pointed at the proxy, and everything else in its settings is kept.
      expect(settings()).toEqual({ theme: "dark", env: { FOO: "bar", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } });

      const text = transcript(result);
      expect(text).toContain("Mesh will make these changes:");
      expect(text).toContain(`Connected. Mesh is running on http://127.0.0.1:${port} and Claude Code is pointed at it (always on: the background service).`);
      expect(text).toContain("Open a new Claude Code session; your next message goes through Mesh.");
      expect(text).toContain("mesh dashboard");
      expect(text).toContain("Weekly report  ON: once a week, after Monday 08:00");
      expect(text).toContain("Turn the notification off: mesh report --off");
      expect(text).toContain("Undo           mesh uninstall");
      expectNoSecret(text);
      expectNoSecret(JSON.stringify(result));
      expectNoSecret(plist);
    });

    it("run again on the connected machine, it changes nothing and says so", async () => {
      await setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options);
      const before = listTree(fake.home);
      const callsBefore = runner.calls.filter((call) => call[0] !== "list").length;
      said = [];
      const again = await setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options);
      expect(listTree(fake.home)).toEqual(before);
      expect(runner.calls.filter((call) => call[0] !== "list").length).toBe(callsBefore);
      expect(again).toMatchObject({ ok: true, connected: true, alreadyConnected: true, changed: false, plan: [], via: "service", undo: ["mesh uninstall"] });
      const text = transcript(again);
      expect(text).toContain("Nothing on this machine needs changing.");
      expect(text).toContain("Already connected.");
      expect(text).toContain("Nothing was changed.");
    });

    it("the weekly report line follows the real switch", async () => {
      writeFileSync(join(fake.meshHome, "report-state.json"), JSON.stringify({ schema: "mesh-report-state/1", notifications: "off" }));
      const result = await setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options);
      expect(result.weeklyReport.notifications).toBe("off");
      const text = renderSetupResult(result);
      expect(text).toContain("Weekly report  OFF");
      expect(text).toContain("mesh report --on");
    });

    it("mesh uninstall undoes everything setup did", async () => {
      await setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options);
      const removed = uninstallService(target);
      expect(removed).toMatchObject({ wasLoaded: true, removedDefinition: true, restoredClaudeCode: true });
      expect(runner.calls).toContainEqual(["unload", "-w", fake.plistPath]);
      expect(runner.loaded).toBe(false);
      expect(existsSync(fake.plistPath)).toBe(false);
      // Claude Code's settings are byte for byte what they were before setup.
      expect(readFileSync(fake.claudeSettingsPath, "utf8")).toBe(originalSettings);
      await proxy.close();
      const status = await collectStatus({ ...target, port, wiringStatePath: fake.wiringStatePath, platform: "darwin", env: {}, now: NOW });
      expect(status.flow.state).toBe("not_set_up");
    });

    it("mesh stop takes the address back out and keeps the service definition", async () => {
      await setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options);
      expect(stopService(target)).toMatchObject({ wasLoaded: true, removedDefinition: false, restoredClaudeCode: true });
      expect(existsSync(fake.plistPath)).toBe(true);
      expect(readFileSync(fake.claudeSettingsPath, "utf8")).toBe(originalSettings);
    });

    it("mesh restore puts Claude Code back if the service has gone and left its address behind", async () => {
      await setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options);
      // The service disappears without mesh uninstall (the definition was deleted by hand).
      runner.loaded = false;
      rmSync(fake.plistPath);
      await proxy.close();
      const status = await collectStatus({ ...target, port, wiringStatePath: fake.wiringStatePath, platform: "darwin", env: {}, now: NOW });
      expect(status.flow).toMatchObject({ state: "proxy_down_client_pointed", fix: "mesh restore" });
      // What `mesh restore` runs.
      const repaired = await repairWiring({ settingsPath: fake.claudeSettingsPath, statePath: fake.wiringStatePath }, { portUp: portOpen });
      expect(repaired.changed).toBe(true);
      expect(readFileSync(fake.claudeSettingsPath, "utf8")).toBe(originalSettings);
    });

    it("if the proxy never answers, setup removes the service again and Claude Code is as it was", async () => {
      delete runner.onLoad; // the service "loads" but nothing ever listens
      const result = await setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), { ...options, waitForProxy: () => Promise.resolve(false) });
      expect(result).toMatchObject({ ok: false, connected: false, changed: false, rolledBack: true, fix: "mesh doctor", undo: [] });
      expect(result.error).toMatchObject({ code: "not_connected" });
      expect(existsSync(fake.plistPath)).toBe(false);
      expect(runner.loaded).toBe(false);
      expect(readFileSync(fake.claudeSettingsPath, "utf8")).toBe(originalSettings);
      const text = transcript(result);
      expect(text).toContain("NOT connected. Mesh did not start, and setup undid what it had changed.");
      expect(text).toContain("State: not_set_up.");
      expect(text).toContain("mesh doctor");
    });

    it("a mesh start session that was killed is put right first, then the service is set up", async () => {
      // Claude Code still points at the dead session's address; the record says nothing was set before it.
      writeFileSync(fake.claudeSettingsPath, JSON.stringify({ theme: "dark", env: { FOO: "bar", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } }, null, 2) + "\n");
      writeFileSync(fake.wiringStatePath, JSON.stringify({ pid: 2 ** 22 + 12345, proxyUrl: `http://127.0.0.1:${port}`, priorBaseUrl: null, hadFile: true, at: NOW.toISOString() }));
      const before = await collectStatus({ ...target, port, wiringStatePath: fake.wiringStatePath, platform: "darwin", env: {}, now: NOW });
      expect(before.flow).toMatchObject({ state: "proxy_down_client_pointed", fix: "mesh restore" });
      const result = await setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options);
      expect(result.plan.map((step) => step.id)).toEqual(["restore_claude_code", "copy_launcher", "write_service_definition", "register_service", "point_claude_code"]);
      expect(result).toMatchObject({ ok: true, connected: true, via: "service" });
      expect(existsSync(fake.wiringStatePath)).toBe(false);
      uninstallService(target);
      expect(readFileSync(fake.claudeSettingsPath, "utf8")).toBe(originalSettings);
    });

    it("a mesh start session that is running is left alone: connected already, nothing changed", async () => {
      await proxy.listen();
      writeFileSync(fake.claudeSettingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } }));
      writeFileSync(fake.wiringStatePath, JSON.stringify({ pid: process.pid, proxyUrl: `http://127.0.0.1:${port}`, priorBaseUrl: null, hadFile: true, at: NOW.toISOString() }));
      const before = listTree(fake.home);
      const result = await setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options);
      expect(listTree(fake.home)).toEqual(before);
      expect(runner.calls.filter((call) => call[0] !== "list")).toEqual([]);
      expect(result).toMatchObject({ ok: true, connected: true, alreadyConnected: true, changed: false, via: "terminal-session", plan: [], undo: [] });
      const text = transcript(result);
      expect(text).toContain("connected only while that terminal stays open");
      expect(text).toContain("Already connected.");
    });
  });

  describe("Claude Code, not always on", () => {
    it("changes nothing, explains mesh start in two lines, and says plainly it is not connected", async () => {
      const before = listTree(fake.home);
      const result = await setupMesh(args({ client: "claude-code", alwaysOn: false, yes: true }), options);
      expect(listTree(fake.home)).toEqual(before);
      expect(runner.calls.filter((call) => call[0] !== "list")).toEqual([]);
      expect(result).toMatchObject({ ok: false, connected: false, changed: false, plan: [], fix: `mesh start --port ${port}`, undo: [], flow: { state: "not_set_up" } });
      expect(result.error).toMatchObject({ code: "not_connected" });
      expect(result.next).toHaveLength(2);
      const text = transcript(result);
      expect(text).toContain("This changes nothing on your machine.");
      expect(text).toContain("NOT connected yet. Nothing was changed.");
      expect(text).toContain("State: not_set_up. Mesh is installed but not connected");
      expect(text).toContain(`Run mesh start --port ${port} in its own terminal and leave it open while you work.`);
      expect(text).toContain("puts the settings back when you stop it (Ctrl+C)");
    });

    it("where there is no background service (not macOS) it explains mesh start, and --always-on is refused", async () => {
      const linux = { ...options, platform: "linux" as const };
      const result = await setupMesh(args({ client: "claude-code", yes: true }), linux);
      expect(result).toMatchObject({ ok: false, alwaysOn: false, defaulted: [], changed: false, fix: `mesh start --port ${port}` });
      expect(said.join("\n")).toContain("always-on is macOS only");
      const error = await refusal(setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), linux));
      expect(error.code).toBe("unsupported_platform");
      expect(error.message).toContain("Nothing was changed.");
      expect(runner.calls.filter((call) => call[0] !== "list")).toEqual([]);
    });
  });

  describe("your own app", () => {
    it("not always on: prints the base URLs and the instruction for each kind of client, and changes nothing", async () => {
      const before = listTree(fake.home);
      const result = await setupMesh(args({ client: "app", alwaysOn: false, yes: true }), options);
      expect(listTree(fake.home)).toEqual(before);
      expect(runner.calls.filter((call) => call[0] !== "list")).toEqual([]);
      expect(result).toMatchObject({ ok: false, connected: false, changed: false, plan: [], fix: `mesh proxy --port ${port}`, undo: [] });
      expect(result.clients.map((entry) => entry.id)).toEqual(["anthropic", "openai", "openai-compatible", "framework"]);
      const text = transcript(result);
      expect(text).toContain("NOT connected yet. Nothing was changed.");
      expect(text).toContain(`Run mesh proxy --port ${port} in its own terminal`);
      expect(text).toContain(`ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
      expect(text).toContain(`OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`);
      expect(text).toContain("keep your own API key");
      expect(text).toContain("mesh setup --client app --always-on");
      for (const entry of result.clients) expect(text).toContain(entry.instruction);
      expectNoSecret(text);
    });

    it("with mesh proxy already running: ready for the app, nothing changed, exit 0", async () => {
      await proxy.listen();
      const before = listTree(fake.home);
      const result = await setupMesh(args({ client: "app", alwaysOn: false, yes: true }), options);
      expect(listTree(fake.home)).toEqual(before);
      expect(result).toMatchObject({ ok: true, connected: true, alreadyConnected: true, changed: false, via: "terminal-session" });
      expect(transcript(result)).toContain(`Mesh is running on http://127.0.0.1:${port}, ready for your app`);
    });

    it("always on: the service is set up and Claude Code's settings are not touched", async () => {
      const result = await setupMesh(args({ client: "app", alwaysOn: true, yes: true }), options);
      expect(result.plan.map((step) => step.id)).toEqual(["copy_launcher", "write_service_definition", "register_service"]);
      expect(result).toMatchObject({ ok: true, connected: true, changed: true, via: "service", undo: ["mesh uninstall"] });
      expect(existsSync(fake.plistPath)).toBe(true);
      expect(readFileSync(fake.claudeSettingsPath, "utf8")).toBe(originalSettings);
      // And mesh uninstall removes it without touching those settings either.
      expect(uninstallService(target)).toMatchObject({ removedDefinition: true, restoredClaudeCode: false });
      expect(readFileSync(fake.claudeSettingsPath, "utf8")).toBe(originalSettings);
    });
  });

  describe("what it refuses to touch", () => {
    it("a settings.json it cannot parse: refused in plain words, for a dry run too, and nothing is written", async () => {
      writeFileSync(fake.claudeSettingsPath, `{ "env": { "ANTHROPIC_API_KEY": "${PLANTED_SETTINGS_KEY}" `);
      const before = listTree(fake.home);
      for (const extra of [{ yes: true }, { dryRun: true }] as const) {
        const error = await refusal(setupMesh(args({ client: "claude-code", alwaysOn: true, ...extra }), options));
        expect(error.code).toBe("claude_settings_invalid");
        expect(error.message).toContain("cannot be read as JSON, so Mesh will not touch it");
        expect(error.message).toContain("Nothing was changed.");
        expectNoSecret(error.message);
      }
      expect(listTree(fake.home)).toEqual(before);
      expect(existsSync(fake.plistPath)).toBe(false);
      expect(runner.calls.filter((call) => call[0] !== "list")).toEqual([]);
      expectNoSecret(said.join("\n"));
    });

    it("a base URL that points somewhere else: not replaced, and never printed", async () => {
      writeFileSync(fake.claudeSettingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: PLANTED_URL, ANTHROPIC_API_KEY: PLANTED_SETTINGS_KEY } }));
      const before = listTree(fake.home);
      const error = await refusal(setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options));
      expect(error.code).toBe("claude_pointed_elsewhere");
      expect(error.message).toContain("Mesh will not replace it");
      expectNoSecret(error.message);
      expectNoSecret(said.join("\n"));
      expect(listTree(fake.home)).toEqual(before);
      // The own-app path leaves Claude Code alone, so it goes ahead and still prints none of it.
      const result = await setupMesh(args({ client: "app", alwaysOn: true, yes: true }), options);
      expect(result.connected).toBe(true);
      expect(settings().env?.ANTHROPIC_BASE_URL).toBe(PLANTED_URL);
      expectNoSecret(transcript(result));
      expectNoSecret(JSON.stringify(result));
      // And mesh uninstall leaves an address that is not Mesh's exactly where it is.
      expect(uninstallService(target).restoredClaudeCode).toBe(false);
      expect(settings().env?.ANTHROPIC_BASE_URL).toBe(PLANTED_URL);
    });

    it("a port another program holds, or a Mesh already running there in a terminal", async () => {
      const { createServer } = await import("node:http");
      const other = createServer((_request, response) => { response.writeHead(200); response.end("hello"); });
      await new Promise<void>((done) => other.listen(port, "127.0.0.1", done));
      try {
        const error = await refusal(setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options));
        expect(error.code).toBe("port_in_use");
        expect(error.message).toContain(`mesh setup --port ${port + 1}`);
      } finally {
        other.closeAllConnections();
        await new Promise<void>((done) => other.close(() => done()));
      }
      await proxy.listen();
      const running = await refusal(setupMesh(args({ client: "claude-code", alwaysOn: true, yes: true }), options));
      expect(running.code).toBe("mesh_already_running");
      expect(running.message).toContain("Nothing was changed.");
      expect(readFileSync(fake.claudeSettingsPath, "utf8")).toBe(originalSettings);
      expect(runner.calls.filter((call) => call[0] !== "list")).toEqual([]);
    });
  });

  describe("questions, flags and --json", () => {
    const answering = (answers: string[]): { ask: (question: string) => Promise<string>; asked: string[] } => {
      const asked: string[] = [];
      return { asked, ask: (question) => { asked.push(question); return Promise.resolve(answers.shift() ?? ""); } };
    };

    it("at a terminal: asks what you use, whether to stay on, and once before changing anything", async () => {
      const { ask, asked } = answering(["", "", ""]); // the defaults: Claude Code, always on, go ahead
      const result = await setupMesh(args(), { ...options, ask });
      expect(asked).toEqual(["  Answer 1 or 2 [1]: ", "  Always on? [Y/n]: ", "  Go ahead? [Y/n]: "]);
      expect(result).toMatchObject({ ok: true, connected: true, client: "claude-code", alwaysOn: true, defaulted: [] });
      // The plan was said before the last question was asked.
      expect(said.join("\n")).toContain("Mesh will make these changes:");
    });

    it("saying no to always-on changes nothing and explains mesh start", async () => {
      const before = listTree(fake.home);
      const { ask, asked } = answering(["1", "n"]);
      const result = await setupMesh(args(), { ...options, ask });
      expect(asked).toHaveLength(2); // nothing to change, so nothing to confirm
      expect(listTree(fake.home)).toEqual(before);
      expect(result).toMatchObject({ ok: false, alwaysOn: false, changed: false, declined: false, fix: `mesh start --port ${port}` });
    });

    it("saying no to the plan changes nothing", async () => {
      const before = listTree(fake.home);
      const { ask } = answering(["1", "y", "n"]);
      const result = await setupMesh(args(), { ...options, ask });
      expect(listTree(fake.home)).toEqual(before);
      expect(runner.calls.filter((call) => call[0] !== "list")).toEqual([]);
      expect(result).toMatchObject({ ok: false, declined: true, changed: false, connected: false });
      expect(renderSetupResult(result)).toContain("NOT connected. You said no, so nothing was changed.");
    });

    it("answering 2 takes the own-app path; --yes asks nothing at all", async () => {
      const app = answering(["2", "n"]);
      expect((await setupMesh(args(), { ...options, ask: app.ask })).client).toBe("app");
      const never = answering([]);
      await setupMesh(args({ yes: true, alwaysOn: false }), { ...options, ask: never.ask });
      await setupMesh(args({ dryRun: true }), { ...options, ask: never.ask });
      expect(never.asked).toEqual([]);
    });

    it("where nobody can be asked, a missing answer is a plain error naming the flags, and nothing changes", async () => {
      const before = listTree(fake.home);
      const missing = await refusal(setupMesh(args(), options));
      expect(missing.code).toBe("usage");
      for (const flag of ["--client claude-code", "--client app", "--always-on", "--no-always-on", "--yes", "--dry-run"]) expect(missing.message).toContain(flag);
      // Every answer given, but no --yes: it will not change the machine unasked.
      const unconfirmed = await refusal(setupMesh(args({ client: "claude-code", alwaysOn: true }), options));
      expect(unconfirmed.code).toBe("usage");
      expect(unconfirmed.message).toContain("Add --yes to go ahead");
      expect(listTree(fake.home)).toEqual(before);
      expect(runner.calls.filter((call) => call[0] !== "list")).toEqual([]);
    });

    it("as a real process with stdin closed: fails fast, does not hang, changes nothing", { timeout: 90_000 }, () => {
      const before = listTree(fake.home);
      const started = Date.now();
      const bare = runMeshProcess(fake, ["setup"], { timeoutMs: 20_000 });
      expect(bare.timedOut).toBe(false);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(bare.status).toBe(1);
      expect(bare.stdout).toBe("");
      expect(bare.stderr).toContain("mesh setup cannot ask questions here");
      expect(bare.stderr).toContain("--client claude-code or --client app");
      expect(bare.stderr).toContain("--yes");

      const json = runMeshProcess(fake, ["setup", "--json"], { timeoutMs: 20_000 });
      expect(json.timedOut).toBe(false);
      expect(json.status).toBe(1);
      expect(json.stdout.trim().includes("\n")).toBe(false);
      expect(JSON.parse(json.stdout)).toMatchObject({ schema: "mesh-setup/1", ok: false, error: { code: "usage" } });
      expect(listTree(fake.home)).toEqual(before);
    });

    it("--json prints exactly one object, asks nothing, and carries no key or credential", async () => {
      writeFileSync(fake.claudeSettingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: PLANTED_SETTINGS_KEY } }));
      const written: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write);
      const logged = vi.spyOn(console, "log").mockImplementation(() => {});
      const ask = vi.fn(() => Promise.reject(new Error("asked a question in JSON mode")));
      await runSetup(["--client", "claude-code", "--always-on", "--yes", "--json", "--port", String(port)], { ...options, ask });
      vi.restoreAllMocks();
      expect(ask).not.toHaveBeenCalled();
      expect(logged).not.toHaveBeenCalled();
      expect(said).toEqual([]);
      expect(written).toHaveLength(1);
      expect(written[0]!.endsWith("}\n")).toBe(true);
      const result = JSON.parse(written[0]!) as SetupResult;
      expect(Object.keys(result).sort()).toEqual([
        "alreadyConnected", "alwaysOn", "baseUrls", "changed", "client", "clients", "connected", "dashboard", "declined", "defaulted",
        "dryRun", "fix", "flow", "mesh", "next", "ok", "plan", "port", "rolledBack", "schema", "undo", "via", "weeklyReport",
      ]);
      expect(result).toMatchObject({ schema: "mesh-setup/1", ok: true, connected: true, via: "service", flow: { state: "connected_idle" } });
      expect(process.exitCode ?? 0).toBe(0);
      expectNoSecret(written[0]!);
      // The key that was already in the settings file is still there, untouched and unprinted.
      expect(settings().env?.ANTHROPIC_API_KEY).toBe(PLANTED_SETTINGS_KEY);
    });

    it("--json when it does not end connected: one object with the state and the next command, exit 1", async () => {
      const written: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write);
      await runSetup(["--client", "app", "--no-always-on", "--yes", "--json", "--port", String(port)], options);
      vi.restoreAllMocks();
      expect(written).toHaveLength(1);
      const result = JSON.parse(written[0]!) as SetupResult;
      expect(result).toMatchObject({ ok: false, connected: false, fix: `mesh proxy --port ${port}`, flow: { state: "not_set_up" }, error: { code: "not_connected" } });
      expect(process.exitCode).toBe(1);
    });

    it("rejects flags it does not know, and both always-on flags together", () => {
      expect(() => parseSetupArgs(["--client", "cursor"])).toThrow("--client must be claude-code or app.");
      expect(() => parseSetupArgs(["--always-on", "--no-always-on"])).toThrow("not both");
      expect(() => parseSetupArgs(["--force"])).toThrow("Unknown option: --force");
      expect(() => parseSetupArgs(["--port", "99999"])).toThrow("--port must be 1-65535.");
      expect(parseSetupArgs(["--client", "app", "--no-always-on", "--port", "9001", "--yes", "--dry-run", "--json"])).toEqual({
        client: "app", alwaysOn: false, port: 9001, yes: true, dryRun: true, json: true, help: false,
      });
    });
  });
});
