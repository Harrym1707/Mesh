/**
 * `mesh dashboard` — exercised as a real subprocess with an isolated HOME and
 * ledger, because the module fixes ~/.mesh paths from homedir() at import time.
 * We start the server, read the port it prints, hit /data and /, then stop it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

function startDashboard(home: string, ledger: string): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    // --port 0 → an OS-assigned free port, which the server prints in its URL.
    const child = spawn(process.execPath, ["--import", "tsx", MAIN, "dashboard", "--no-open", "--port", "0", "--proxy-port", "1", "--ledger", ledger], {
      env: { ...process.env, HOME: home },
    });
    let out = "";
    const onData = (c: Buffer): void => {
      out += c.toString("utf8");
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { child.stdout.off("data", onData); resolve({ child, port: Number(m[1]) }); }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    setTimeout(() => reject(new Error(`dashboard did not start: ${out}`)), 15_000);
  });
}

describe("mesh dashboard (subprocess, isolated HOME + ledger)", () => {
  let home: string;
  let ledger: string;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mesh-dash-"));
    ledger = join(home, ".mesh", "ledger");
  });
  afterEach(() => {
    if (child) child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });

  it("serves /data (empty ledger → zero savings, Theo defaults) and the HTML page", { timeout: 30_000 }, async () => {
    const started = await startDashboard(home, ledger);
    child = started.child;
    const base = `http://127.0.0.1:${started.port}`;

    const data = await (await fetch(`${base}/data`, { cache: "no-store" })).json() as {
      savings: { netUsd: number; verdict: string };
      theo: { active: unknown[]; withheld: unknown[]; qualityCeilingPercent: number };
      chainOk: boolean; proxyUp: boolean; lineItems: unknown[]; workflows: unknown[];
    };
    expect(data.savings.netUsd).toBe(0);
    expect(data.savings.verdict).toBe("do_not_charge");
    expect(Array.isArray(data.theo.active)).toBe(true);
    expect(Array.isArray(data.theo.withheld)).toBe(true);
    expect(typeof data.theo.qualityCeilingPercent).toBe("number");
    expect(data.chainOk).toBe(true);
    expect(data.proxyUp).toBe(false); // --proxy-port 1 is dead
    expect(Array.isArray(data.workflows)).toBe(true); // per-session breakdown (empty ledger → [])
    expect(data.workflows).toHaveLength(0);

    const html = await (await fetch(`${base}/`)).text();
    expect(html.toLowerCase()).toContain("mesh");
    expect(html).toContain("/data"); // the page polls this endpoint
    expect(html).toContain("Workflows"); // the per-session panel is present
  });
});
