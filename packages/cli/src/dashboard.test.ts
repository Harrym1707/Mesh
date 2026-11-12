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
import type { BillableEvent } from "../../core/src/savings-ledger.js";
import type { TheoLever, TheoPolicy } from "../../sdk-js/src/theo-policy.js";
import { computeHealth } from "./dashboard.js";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

const ev = (over: Partial<BillableEvent>): BillableEvent =>
  ({ requestId: "r", status: "succeeded", levers: [], ...over } as unknown as BillableEvent);
const policy = (levers: TheoLever[], qualityCeilingPercent = 2): TheoPolicy =>
  ({ schemaVersion: 1, user: "u", version: 1, qualityCeilingPercent, levers, updatedAt: "2026-11-10T00:00:00.000Z" });

describe("computeHealth — the quality/health view (pure)", () => {
  it("empty ledger → status 'none', zero signals, no proven quality", () => {
    const h = computeHealth([], policy([{ lever: "tool-schema-compaction", class: "lossless" }]), null);
    expect(h.status).toBe("none");
    expect(h.sampleSize).toBe(0);
    expect(h.retryRatePercent).toBe(0);
    expect(h.failureRatePercent).toBe(0);
    expect(h.activeLossyCount).toBe(0);
    expect(h.worstQualityDeltaPercent).toBe(0);
  });

  it("lossless-only + traffic → 'protected', retry/failure recomputed, lossless lever has no grader and no drift", () => {
    const events = [
      ev({ requestId: "a" }),
      ev({ requestId: "b", duplicateOfRequestId: "a" }), // a retry
      ev({ requestId: "c", status: "failed" }),
      ev({ requestId: "d" }),
    ];
    const h = computeHealth(events, policy([{ lever: "tool-schema-compaction", class: "lossless" }]), null);
    expect(h.status).toBe("protected");
    expect(h.sampleSize).toBe(4);
    expect(h.retryRatePercent).toBeCloseTo(25, 5); // 1 of 4
    expect(h.failureRatePercent).toBeCloseTo(25, 5); // 1 of 4
    expect(h.activeLossyCount).toBe(0);
    expect(h.worstQualityDeltaPercent).toBe(0);
    expect(h.levers[0]!.grader).toBeNull();
    expect(h.levers[0]!.drift).toBeNull(); // no baseline to compare against
  });

  it("lossy lever carries its gate proof (grader + measured delta) and reports 'ok' drift when steady", () => {
    const lever: TheoLever = {
      lever: "tool-schema-description-trim",
      class: "lossy",
      gate: { savingPercent: 12, qualityDeltaPercent: -0.3, grader: "task-completion", provenAt: "2026-11-01T00:00:00.000Z" },
    };
    const events = [ev({ requestId: "a" }), ev({ requestId: "b" })]; // no retries, no failures
    const h = computeHealth(events, policy([lever]), { driftBaselines: { "tool-schema-description-trim": { retryRate: 0.5, failureRate: 0.5 } } });
    expect(h.status).toBe("protected");
    expect(h.activeLossyCount).toBe(1);
    expect(h.worstQualityDeltaPercent).toBeCloseTo(-0.3, 5);
    expect(h.levers[0]!.grader).toBe("task-completion");
    expect(h.levers[0]!.drift).toBe("ok"); // current 0% retry is below baseline + threshold
  });

  it("a live retry-rate rise past the rollback line flips the lever to 'watch' and the whole view to 'watch'", () => {
    const lever: TheoLever = {
      lever: "tool-schema-description-trim",
      class: "lossy",
      gate: { savingPercent: 12, qualityDeltaPercent: -0.3, grader: "task-completion", provenAt: "2026-11-01T00:00:00.000Z" },
    };
    const events = [ev({ requestId: "a" }), ev({ requestId: "b", duplicateOfRequestId: "a" })]; // 50% retry
    const h = computeHealth(events, policy([lever]), { driftBaselines: { "tool-schema-description-trim": { retryRate: 0.0, failureRate: 0.0 } } });
    expect(h.levers[0]!.drift).toBe("watch"); // 50% >> baseline 0% + 5%
    expect(h.status).toBe("watch");
  });

  it("a rolled-back lever puts the view in 'watch' even with clean live signals", () => {
    const h = computeHealth([ev({ requestId: "a" })], policy([{ lever: "tool-schema-compaction", class: "lossless" }]), { rolledBack: ["history-compaction"] });
    expect(h.status).toBe("watch");
    expect(h.rolledBack).toEqual(["history-compaction"]);
  });
});

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
      health: { status: string; sampleSize: number; retryRatePercent: number; failureRatePercent: number; ceilingPercent: number; levers: unknown[] };
      chainOk: boolean; proxyUp: boolean; lineItems: unknown[]; workflows: unknown[];
    };
    expect(data.savings.netUsd).toBe(0);
    expect(data.savings.verdict).toBe("do_not_charge");
    expect(Array.isArray(data.theo.active)).toBe(true);
    expect(Array.isArray(data.theo.withheld)).toBe(true);
    expect(typeof data.theo.qualityCeilingPercent).toBe("number");
    expect(data.health.status).toBe("none"); // empty ledger → no traffic yet
    expect(data.health.sampleSize).toBe(0);
    expect(data.health.retryRatePercent).toBe(0);
    expect(data.health.failureRatePercent).toBe(0);
    expect(typeof data.health.ceilingPercent).toBe("number");
    expect(Array.isArray(data.health.levers)).toBe(true);
    expect(data.chainOk).toBe(true);
    expect(data.proxyUp).toBe(false); // --proxy-port 1 is dead
    expect(Array.isArray(data.workflows)).toBe(true); // per-session breakdown (empty ledger → [])
    expect(data.workflows).toHaveLength(0);

    const html = await (await fetch(`${base}/`)).text();
    expect(html.toLowerCase()).toContain("mesh");
    expect(html).toContain("/data"); // the page polls this endpoint
    expect(html).toContain("Workflows"); // the per-session panel is present
    expect(html).toContain("Quality &amp; health"); // the quality/health panel is present
  });
});
