/**
 * Shared pieces for the tests of the flow detector's printers, bare `mesh`
 * and `mesh setup`. Test support only: nothing in the runtime imports this.
 *
 * Everything here works on a temporary home directory and a FAKE service
 * manager. launchd registers an agent for the logged-in user whatever HOME
 * says, so no test may reach the real `launchctl` with anything but a
 * read-only question; the fake runner records every call instead.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chainLedgerRecord, type BillableEvent, type LedgerRecord } from "../../core/src/savings-ledger.js";
import { LAUNCHD_LABEL, type ServiceRunner } from "./machine.js";

export type FakeHome = {
  home: string;
  meshHome: string;
  ledgerDir: string;
  claudeSettingsPath: string;
  wiringStatePath: string;
  plistPath: string;
  /** A directory holding a stand-in `launchctl` that answers "not registered" and changes nothing. */
  binDir: string;
};

/**
 * A home directory in the state the founder's machine was in on 2026-11-23:
 * the launcher at ~/.mesh/bin/mesh, a runtime folder, an empty ledger folder,
 * no service, a Claude Code settings file with no ANTHROPIC_BASE_URL.
 */
export function makeInstalledNeverConnectedHome(): FakeHome {
  const home = mkdtempSync(join(tmpdir(), "mesh-home-"));
  const meshHome = join(home, ".mesh");
  const ledgerDir = join(meshHome, "ledger");
  const claudeSettingsPath = join(home, ".claude", "settings.json");
  mkdirSync(join(meshHome, "bin"), { recursive: true });
  mkdirSync(join(meshHome, "runtime"), { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(meshHome, "bin", "mesh"), "#!/usr/bin/env node\n// stand-in launcher\n");
  chmodSync(join(meshHome, "bin", "mesh"), 0o755);
  writeFileSync(join(meshHome, "runtime", "mesh-runtime.mjs"), "// stand-in runtime\n");
  writeFileSync(join(meshHome, "runtime", "version"), "abc1234\n");
  writeFileSync(claudeSettingsPath, `${JSON.stringify({ theme: "dark", env: { FOO: "bar" } }, null, 2)}\n`);
  // A `launchctl` that says "not registered" and does nothing, for the
  // read-only commands run as a subprocess: their answer then does not depend
  // on whether the developer's own machine has the service.
  const binDir = join(home, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "launchctl"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(binDir, "launchctl"), 0o755);
  return {
    home,
    meshHome,
    ledgerDir,
    claudeSettingsPath,
    wiringStatePath: join(meshHome, "claude-wiring.json"),
    plistPath: join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    binDir,
  };
}

/** A service manager that registers nothing: it records each call and remembers whether the agent is "loaded". */
export type FakeServiceRunner = ServiceRunner & {
  calls: string[][];
  loaded: boolean;
  /** Called when the agent is loaded and unloaded, so a test can start and stop its stand-in proxy. */
  onLoad?: () => void;
  onUnload?: () => void;
};

export function fakeServiceRunner(): FakeServiceRunner {
  const runner: FakeServiceRunner = {
    calls: [],
    loaded: false,
    launchctl: (args) => {
      runner.calls.push([...args]);
      if (args[0] === "list") return runner.loaded;
      if (args[0] === "load") {
        // The real launchctl fails on a definition that is not there.
        const definition = args[args.length - 1]!;
        if (!existsSync(definition)) return false;
        runner.loaded = true;
        runner.onLoad?.();
        return true;
      }
      if (args[0] === "unload") {
        const was = runner.loaded;
        runner.loaded = false;
        if (was) runner.onUnload?.();
        return was;
      }
      return false;
    },
  };
  return runner;
}

/** A port nothing is listening on: bind one, note it, release it. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** Is anything accepting connections on this local port right now? */
export function portIsOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open: boolean): void => { socket.destroy(); done(open); };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * A stand-in for the proxy the service would run: it answers the health check
 * the way MESH does and nothing else. `listen` and `close` can be called more
 * than once.
 */
export function standInProxy(port: number): { listen: () => Promise<void>; close: () => Promise<void>; listening: () => boolean } {
  let server: Server | undefined;
  return {
    listening: () => server !== undefined,
    listen: async () => {
      if (server !== undefined) return;
      const next = createServer((request, response) => {
        if (request.url === "/mesh/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"status":"ok","service":"mesh-proxy"}');
          return;
        }
        response.writeHead(404);
        response.end();
      });
      await new Promise<void>((done) => next.listen(port, "127.0.0.1", done));
      server = next;
    },
    close: async () => {
      const current = server;
      server = undefined;
      if (current === undefined) return;
      current.closeAllConnections();
      await new Promise<void>((done) => current.close(() => done()));
    },
  };
}

/** One ledger event with one lossless saving. */
export function ledgerEvent(requestId: string, savedUsd: number, timestamp: string): BillableEvent {
  return {
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
  };
}

/** A hash-chained spool, one line per `[savedUsd, timestamp]`. */
export function spoolLines(requests: ReadonlyArray<readonly [number, string]>): string[] {
  const records: LedgerRecord[] = [];
  requests.forEach(([savedUsd, timestamp], index) => {
    records.push(chainLedgerRecord(ledgerEvent(`r${index}`, savedUsd, timestamp), records[records.length - 1]));
  });
  return records.map((record) => JSON.stringify(record));
}

export function writeSpool(ledgerDir: string, lines: readonly string[], name = "proxy-anthropic.jsonl"): void {
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, name), `${lines.join("\n")}\n`);
}

/** Every file under a directory with its size and content hash input, for a before/after comparison. */
export function listTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const shown = prefix === "" ? name : `${prefix}/${name}`;
      const stat = statSync(path);
      if (stat.isDirectory()) { out[`${shown}/`] = "dir"; walk(path, shown); }
      else out[shown] = readFileSync(path, "utf8");
    }
  };
  walk(root, "");
  return out;
}

const RUNTIME_ENTRY = fileURLToPath(new URL("./mesh-runtime.ts", import.meta.url));
const MAIN_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));

/**
 * Run a `mesh` command as its own process in a fake home, with stdin closed
 * (as under an agent, a pipe or CI) and a timeout, so a command that waited
 * for an answer would fail the test rather than hang it.
 */
export function runMeshProcess(
  fake: Pick<FakeHome, "home" | "binDir">,
  args: readonly string[],
  options: { entry?: "runtime" | "main"; env?: Record<string, string>; timeoutMs?: number } = {},
): { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", options.entry === "main" ? MAIN_ENTRY : RUNTIME_ENTRY, ...args],
    {
      env: {
        ...process.env,
        HOME: fake.home,
        USERPROFILE: fake.home,
        PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
        MESH_NO_NOTIFY: "1",
        MESH_NO_AUTO_UPDATE: "1",
        ...options.env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 30_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}
