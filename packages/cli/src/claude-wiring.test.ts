import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkWiring, loopbackPort, readWiringState, repairWiring, wireClaudeCode, type WiringPaths } from "./claude-wiring.js";

const PROXY = "http://127.0.0.1:8787";
const DEAD = (): boolean => false;
const ALIVE = (): boolean => true;
const portDown = { portUp: async (): Promise<boolean> => false };
const portUp = { portUp: async (): Promise<boolean> => true };

let paths: WiringPaths;
const settings = (): Record<string, any> => JSON.parse(readFileSync(paths.settingsPath, "utf8")) as Record<string, any>;
const writeSettings = (value: unknown): void => {
  mkdirSync(join(paths.settingsPath, ".."), { recursive: true });
  writeFileSync(paths.settingsPath, `${JSON.stringify(value, null, 2)}\n`);
};

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "mesh-wiring-"));
  paths = { settingsPath: join(home, ".claude", "settings.json"), statePath: join(home, ".mesh", "claude-wiring.json") };
});

describe("wireClaudeCode — point Claude Code at the proxy and always back", () => {
  it("a user with no settings file is left with no settings file", () => {
    const restore = wireClaudeCode(paths, PROXY, { pid: 100 });
    expect(settings().env.ANTHROPIC_BASE_URL).toBe(PROXY);
    restore();
    expect(existsSync(paths.settingsPath)).toBe(false); // not a file still pointing at a dead proxy
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it("restores a previous base URL and leaves unrelated settings alone", () => {
    writeSettings({ theme: "dark", env: { FOO: "bar", ANTHROPIC_BASE_URL: "https://gateway.example" } });
    const restore = wireClaudeCode(paths, PROXY, { pid: 100 });
    expect(readWiringState(paths.statePath)).toMatchObject({ pid: 100, proxyUrl: PROXY, priorBaseUrl: "https://gateway.example", hadFile: true });
    restore();
    expect(settings()).toEqual({ theme: "dark", env: { FOO: "bar", ANTHROPIC_BASE_URL: "https://gateway.example" } });
  });

  it("restore is safe to call twice and leaves a value the user set meanwhile", () => {
    writeSettings({ theme: "dark" });
    const restore = wireClaudeCode(paths, PROXY, { pid: 100 });
    writeSettings({ theme: "dark", env: { ANTHROPIC_BASE_URL: "https://set-by-user.example" } });
    restore();
    restore();
    expect(settings().env.ANTHROPIC_BASE_URL).toBe("https://set-by-user.example");
  });

  it("after a hard kill, the next session restores the user's REAL previous value, not the dead proxy", () => {
    writeSettings({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } });
    wireClaudeCode(paths, "http://127.0.0.1:1111", { pid: 100 }); // killed: its restore never runs

    const restore = wireClaudeCode(paths, "http://127.0.0.1:2222", { pid: 200, isAlive: DEAD });
    expect(settings().env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:2222");
    restore();
    expect(settings().env.ANTHROPIC_BASE_URL).toBe("https://gateway.example");
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it("after a hard kill with no previous settings, the next session leaves nothing behind", () => {
    wireClaudeCode(paths, "http://127.0.0.1:1111", { pid: 100 }); // killed
    const restore = wireClaudeCode(paths, "http://127.0.0.1:2222", { pid: 200, isAlive: DEAD });
    restore();
    expect(existsSync(paths.settingsPath)).toBe(false);
  });

  it("a second session beside a live one restores to the first one's proxy and keeps its record", () => {
    writeSettings({ theme: "dark" });
    wireClaudeCode(paths, "http://127.0.0.1:1111", { pid: 100 });
    const restoreSecond = wireClaudeCode(paths, "http://127.0.0.1:2222", { pid: 200, isAlive: ALIVE });
    restoreSecond();
    expect(settings().env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1111");
    expect(readWiringState(paths.statePath)?.pid).toBe(100); // the first session's record is intact
  });

  it("refuses to touch a settings file that is not valid JSON", () => {
    mkdirSync(join(paths.settingsPath, ".."), { recursive: true });
    writeFileSync(paths.settingsPath, "{ not json");
    expect(() => wireClaudeCode(paths, PROXY, { pid: 100 })).toThrow(/isn't valid JSON/);
    expect(readFileSync(paths.settingsPath, "utf8")).toBe("{ not json");
    expect(existsSync(paths.statePath)).toBe(false);
  });
});

describe("checkWiring / repairWiring — after a session that could not restore", () => {
  it("reports a stranded session and repairs it to the recorded previous value", async () => {
    writeSettings({ theme: "dark", env: { ANTHROPIC_BASE_URL: "https://gateway.example" } });
    wireClaudeCode(paths, PROXY, { pid: 100 }); // killed

    const health = await checkWiring(paths, { ...portDown, isAlive: DEAD });
    expect(health.status).toBe("stranded");

    const result = await repairWiring(paths, { ...portDown, isAlive: DEAD });
    expect(result.changed).toBe(true);
    expect(settings()).toEqual({ theme: "dark", env: { ANTHROPIC_BASE_URL: "https://gateway.example" } });
    expect(existsSync(paths.statePath)).toBe(false);
    expect((await checkWiring(paths, portDown)).status).toBe("ok");
  });

  it("a running session is healthy and is not touched", async () => {
    wireClaudeCode(paths, PROXY, { pid: 100 });
    expect((await checkWiring(paths, { ...portUp, isAlive: ALIVE })).status).toBe("ok");
    const result = await repairWiring(paths, { ...portUp, isAlive: ALIVE });
    expect(result.changed).toBe(false);
    expect(settings().env.ANTHROPIC_BASE_URL).toBe(PROXY);
  });

  it("with no record (an older build), a local address nothing listens on is flagged and removed", async () => {
    writeSettings({ theme: "dark", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } });
    expect((await checkWiring(paths, portDown)).status).toBe("dead-local");
    const result = await repairWiring(paths, portDown);
    expect(result.changed).toBe(true);
    expect(settings()).toEqual({ theme: "dark" });
  });

  it("never removes a remote base URL, reachable or not", async () => {
    writeSettings({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } });
    expect((await checkWiring(paths, portDown)).status).toBe("ok");
    expect((await repairWiring(paths, portDown)).changed).toBe(false);
    expect(settings().env.ANTHROPIC_BASE_URL).toBe("https://gateway.example");
  });

  it("recognises only loopback http addresses as local", () => {
    expect(loopbackPort("http://127.0.0.1:8787")).toBe(8787);
    expect(loopbackPort("http://localhost:4000/v1")).toBe(4000);
    expect(loopbackPort("https://127.0.0.1:8787")).toBeUndefined();
    expect(loopbackPort("https://api.anthropic.com")).toBeUndefined();
    expect(loopbackPort("not a url")).toBeUndefined();
  });
});
