/**
 * The dispatcher, and the two guards that keep a test away from the real
 * service manager.
 *
 * launchd registers an agent for the logged-in user whatever HOME says, so:
 *   - MESH_NO_SERVICE is set for every test (vitest.config.ts). With it set
 *     the real runner never runs `launchctl`: "is it registered?" is answered
 *     no, and anything that would register, stop or remove the service throws.
 *   - `install`, `uninstall` and `stop` are only ever dispatched here with
 *     `--help`, in-process, with a fake runner and temporary paths injected,
 *     and the fake runner must have received no call at all.
 */
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installService, stopService, uninstallService } from "./daemon.js";
import { RUNTIME_COMMANDS, dispatch, isRuntimeCommand, unknownCommand } from "./dispatch.js";
import { CliError } from "./json-output.js";
import { serviceLoaded, serviceManagerDisabled, systemServiceRunner } from "./machine.js";
import {
  fakeServiceRunner,
  listTree,
  makeInstalledNeverConnectedHome,
  runMeshProcess,
  type FakeHome,
  type FakeServiceRunner,
} from "./setup-testkit.js";

const USAGE = "the usage text";

describe("the real service manager is out of reach of every test", () => {
  it("MESH_NO_SERVICE is set for the whole suite", () => {
    expect(process.env.MESH_NO_SERVICE).toBe("1");
    expect(serviceManagerDisabled()).toBe(true);
    expect(serviceManagerDisabled({})).toBe(false);
    expect(serviceManagerDisabled({ MESH_NO_SERVICE: "" })).toBe(false);
  });

  it("with it set, the real runner answers 'not registered' without asking and refuses everything else", () => {
    expect(systemServiceRunner.launchctl(["list", "dev.meshtoken.mesh"])).toBe(false);
    expect(serviceLoaded(systemServiceRunner, "darwin")).toBe(false);
    for (const args of [["load", "-w", "/nowhere.plist"], ["unload", "-w", "/nowhere.plist"], ["bootstrap", "gui/501", "/nowhere.plist"], ["remove", "x"]]) {
      expect(() => systemServiceRunner.launchctl(args)).toThrow("MESH_NO_SERVICE is set");
    }
  });

  it("install, stop and uninstall refuse the real runner before writing a single file", async () => {
    const fake = makeInstalledNeverConnectedHome();
    try {
      const before = listTree(fake.home);
      // Temporary paths, but no runner: the real one would be used.
      const target = { meshHome: fake.meshHome, plistPath: fake.plistPath, claudeSettingsPath: fake.claudeSettingsPath };
      const refused = await installService({ ...target, port: 8787, launcherPath: `${fake.meshHome}/bin/mesh` }).then(() => undefined, (cause: unknown) => cause);
      expect(refused).toBeInstanceOf(CliError);
      expect((refused as CliError).code).toBe("service_disabled");
      expect(() => uninstallService(target)).toThrow("MESH_NO_SERVICE is set");
      expect(() => stopService(target)).toThrow("MESH_NO_SERVICE is set");
      expect(listTree(fake.home)).toEqual(before);
    } finally {
      rmSync(fake.home, { recursive: true, force: true });
    }
  });
});

describe("dispatch", () => {
  let fake: FakeHome;
  let runner: FakeServiceRunner;
  let printed: string[];

  beforeEach(() => {
    fake = makeInstalledNeverConnectedHome();
    runner = fakeServiceRunner();
    printed = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { printed.push(args.join(" ")); });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(fake.home, { recursive: true, force: true });
  });

  it("--help, -h and help print the usage text the entry point passed in", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      printed = [];
      expect(await dispatch([flag], { usage: USAGE })).toBe(true);
      expect(printed).toEqual([USAGE]);
    }
  });

  it("an unknown first argument is not handled, and the error for it names the command", async () => {
    expect(await dispatch(["stauts"], { usage: USAGE })).toBe(false);
    expect(await dispatch(["--no-such-flag"], { usage: USAGE })).toBe(false);
    expect(printed).toEqual([]);
    const error = await unknownCommand("stauts");
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("unknown_command");
    expect(error.message).toBe("Unknown command: stauts. Run mesh --help for the list of commands.");
    expect(isRuntimeCommand("setup")).toBe(true);
    expect(isRuntimeCommand("analyse")).toBe(false);
    expect(new Set(RUNTIME_COMMANDS).size).toBe(RUNTIME_COMMANDS.length);
  });

  it("install, uninstall and stop with --help print their own usage and change nothing at all", async () => {
    const before = listTree(fake.home);
    const service = { meshHome: fake.meshHome, plistPath: fake.plistPath, claudeSettingsPath: fake.claudeSettingsPath, runner };
    for (const command of ["install", "uninstall", "stop"] as const) {
      for (const flag of ["--help", "-h"]) {
        printed = [];
        expect(await dispatch([command, flag], { usage: USAGE, service })).toBe(true);
        expect(printed.join("\n"), `${command} ${flag}`).toContain(`Usage: mesh ${command}`);
        expect(printed.join("\n"), `${command} ${flag}`).toContain("Changes nothing.");
        expect(printed.join("\n"), `${command} ${flag}`).not.toContain(USAGE);
      }
    }
    // --help wins wherever it is typed.
    printed = [];
    await dispatch(["install", "--port", "9999", "--help"], { usage: USAGE, service });
    expect(printed.join("\n")).toContain("Usage: mesh install");
    // The fake service manager was never asked anything, and no file changed.
    expect(runner.calls).toEqual([]);
    expect(runner.loaded).toBe(false);
    expect(listTree(fake.home)).toEqual(before);
  });

  it("restore --help prints its usage and leaves the settings it was given alone", async () => {
    const before = listTree(fake.home);
    const restore = { paths: { settingsPath: fake.claudeSettingsPath, statePath: fake.wiringStatePath }, runner };
    expect(await dispatch(["restore", "--help"], { usage: USAGE, restore })).toBe(true);
    expect(printed.join("\n")).toContain("Usage: mesh restore");
    expect(runner.calls).toEqual([]);
    expect(listTree(fake.home)).toEqual(before);
  });

  it("as a real process: an unknown command fails with a sentence, not the usage text; with --json, one error object", { timeout: 60_000 }, () => {
    for (const entry of ["runtime", "main"] as const) {
      const text = runMeshProcess(fake, ["stauts"], { entry });
      expect(text.status).toBe(1);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain("Unknown command: stauts. Run mesh --help for the list of commands.");
      const json = runMeshProcess(fake, ["stauts", "--json"], { entry });
      expect(json.status).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({ schema: "mesh-error/1", ok: false, error: { code: "unknown_command" } });
    }
  });
});
