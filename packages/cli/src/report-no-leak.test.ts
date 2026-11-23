/**
 * `mesh report` as a real command, and what it must never repeat.
 *
 * The report (text, the detail, JSON, the HTML page, the notification) holds
 * money, counts, dates, and lever names and model ids in the detail. It never
 * holds a prompt, a tool argument, a request id, an application name, a spool
 * file name or a key. Here every free-text field of a ledger and of Theo's
 * memory is planted with a recognisable string, fake keys sit in the
 * environment and in Claude Code's settings, and none of it may appear in
 * any report output.
 *
 * Each command runs as a subprocess with an isolated HOME. Desktop
 * notifications are off for the whole test run (vitest.config.ts) and the
 * in-process delivery uses an injected notifier, so nothing real is shown,
 * read or opened.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chainLedgerRecord, type BillableEvent, type LedgerRecord } from "../../core/src/savings-ledger.js";
import { createTheoMemory } from "../../sdk-js/src/theo-agent.js";
import { addDays, mondayOf } from "./report.js";
import { deliverWeeklyReportIfDue, reportStatePath } from "./report-delivery.js";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

const MARK = "PLANTED";
const FAKE_ANTHROPIC_KEY = `sk-ant-api03-${MARK}-FAKE-KEY-0000`;
const FAKE_OPENAI_KEY = `sk-proj-${MARK}-FAKE-KEY-1111`;
const PLANTED_APP = `${MARK}-APP-ID-91bc`;
const SECRETS = [MARK, "sk-ant", "sk-proj", "/etc/passwd", "board memo", "ignore previous instructions", "salary review"];

/** The Wednesday of the last full week (UTC), so the default report covers the planted requests whenever this runs. */
const TODAY = new Date().toISOString().slice(0, 10);
const LAST_MONDAY = addDays(mondayOf(TODAY), -7);
const WEDNESDAY = addDays(LAST_MONDAY, 2);
const MONTH = WEDNESDAY.slice(0, 7);

function plantedEvents(day: string): BillableEvent[] {
  const base = {
    schemaVersion: 1 as const,
    applicationId: PLANTED_APP,
    invoicePeriod: day.slice(0, 7),
    executionMode: "standard" as const,
    status: "succeeded" as const,
  };
  return [
    {
      ...base,
      requestId: `${MARK}-REQUEST-ID-7f3a`,
      taskId: `${MARK}-TASK-ID-55de`,
      timestamp: `${day}T10:00:00.000Z`,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      pricingStatus: "priced",
      actualUsd: 412.10,
      catalogueVersion: `${MARK} catalogue version that is prose`,
      levers: [{
        leverId: "duplicate-context-removal",
        kind: "lossless",
        savedUsd: 86.20,
        detail: `${MARK} lever detail: tool arguments {"path":"/etc/passwd","query":"salary review"}`,
      }],
    },
    {
      ...base,
      requestId: `${MARK}-REQUEST-ID-8c41`,
      taskId: `${MARK}-TASK-ID-55de`,
      duplicateOfRequestId: `${MARK}-DUPLICATE-ID-02aa`,
      timestamp: `${day}T11:00:00.000Z`,
      provider: `${MARK} provider name with spaces`,
      model: `${MARK} model: summarise the Q3 board memo for me`,
      pricingStatus: "unpriced",
      pricingReason: `${MARK} pricing reason: the prompt said "ignore previous instructions"`,
      levers: [{ leverId: `${MARK} lever id that is prose, not an id`, kind: "lossless", savedUsd: 0.5 }],
    },
    {
      ...base,
      requestId: `${MARK}-REQUEST-ID-9d52`,
      timestamp: `${day}T12:00:00.000Z`,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      pricingStatus: "priced",
      actualUsd: 3,
      levers: [{
        leverId: "stale-history-compaction",
        kind: "lossy",
        savedUsd: 1.25,
        gateVerdict: { ref: `theo-gate:stale-history-compaction:${MARK} grader@2026-11-01T00:00:00.000Z`, verdict: "approved" },
        detail: `${MARK} second lever detail`,
      }],
    },
  ];
}

function spoolLines(day: string): string[] {
  const records: LedgerRecord[] = [];
  for (const event of plantedEvents(day)) records.push(chainLedgerRecord(event, records[records.length - 1]));
  return records.map((record) => JSON.stringify(record));
}

/** Theo's memory with a planted string in every free-text field he keeps. */
function plantedTheoMemory(day: string): unknown {
  const memory = createTheoMemory(`${MARK} customer`, "recommend", `${day}T00:00:00.000Z`);
  memory.policy.user = `${MARK} policy user`;
  memory.policy.levers.push({
    lever: "stale-history-compaction",
    class: "lossy",
    gate: { savingPercent: 12, qualityDeltaPercent: -0.1, grader: `${MARK} grader`, provenAt: `${day}T00:00:00.000Z` },
  });
  memory.driftBaselines["stale-history-compaction"] = { retryRate: 0, failureRate: 0, at: `${addDays(day, -3)}T09:00:00.000Z` };
  memory.proposals.push({
    lever: `${MARK}-proposed-lever`,
    savingPercent: 33,
    qualityDeltaPercent: -0.2,
    grader: `${MARK} proposal grader`,
    provenAt: `${day}T09:00:00.000Z`,
    message: `${MARK} proposal message quoting a prompt: summarise the Q3 board memo`,
  });
  memory.hypotheses.push({ lever: `${MARK}-hypothesis`, class: "lossy", priorSharePercent: 40, rationale: `${MARK} rationale` });
  memory.experiments.push({ lever: `${MARK}-experiment`, ranAt: `${day}T09:30:00.000Z`, passed: false, savingPercent: 5, qualityDeltaPercent: -9, grader: `${MARK} g`, note: `${MARK} experiment note` });
  memory.log.push({ at: `${day}T09:00:00.000Z`, autonomy: "recommend", observed: `${MARK} observed workload line`, actions: 2 });
  return memory;
}

type Run = { status: number; stdout: string; stderr: string };

function runMesh(home: string, args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", MAIN, ...args], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TZ: "UTC",
        MESH_NO_AUTO_UPDATE: "1",
        MESH_NO_NOTIFY: "1",
        ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
        OPENAI_API_KEY: FAKE_OPENAI_KEY,
        ...extraEnv,
      },
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

/** A HOME with the planted ledger, planted Theo memory and planted Claude Code settings. */
function makeHome(label: string, lines: string[], day: string): string {
  const home = mkdtempSync(join(tmpdir(), `mesh-report-${label}-`));
  const ledger = join(home, ".mesh", "ledger");
  mkdirSync(join(ledger, "theo"), { recursive: true });
  // The proxy names a spool after the application id a request sent.
  writeFileSync(join(ledger, `${PLANTED_APP}-anthropic.jsonl`), lines.join("\n") + "\n");
  writeFileSync(join(ledger, "theo", "local.json"), JSON.stringify(plantedTheoMemory(day), null, 2));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    env: {
      ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
      ANTHROPIC_AUTH_TOKEN: `${MARK}-AUTH-TOKEN-2222`,
      ANTHROPIC_BASE_URL: `http://user:${MARK}-URL-PASSWORD@127.0.0.1:9/?key=${MARK}-URL-QUERY`,
    },
  }));
  return home;
}

function oneObject(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trimEnd().includes("\n")).toBe(false);
  expect(stdout).not.toMatch(/[\u001b\u009b]/);
  const parsed: unknown = JSON.parse(stdout);
  expect(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)).toBe(true);
  return parsed as Record<string, unknown>;
}

function expectClean(text: string, where: string): void {
  for (const secret of SECRETS) expect(text.includes(secret), `${where} contains ${secret}`).toBe(false);
}

describe("mesh report: the command, and nothing private in any output", () => {
  let home: string;
  let brokenHome: string;
  let switchHome: string;
  let fixedHome: string;
  const runs = new Map<string, Run>();
  const htmlPath = (): string => join(home, "page", "report.html");

  beforeAll(async () => {
    const lines = spoolLines(WEDNESDAY);
    home = makeHome("intact", lines, WEDNESDAY);
    switchHome = makeHome("switch", lines, WEDNESDAY);
    fixedHome = makeHome("fixed", spoolLines("2026-11-18"), "2026-11-18");
    const edited = [...lines];
    const record = JSON.parse(edited[0]!) as LedgerRecord;
    (record.event.levers[0] as { savedUsd: number }).savedUsd = 999;
    edited[0] = JSON.stringify(record);
    brokenHome = makeHome("broken", edited, WEDNESDAY);

    const plan: Array<[string, string, string[], Record<string, string>?]> = [
      ["text", home, ["report"]],
      ["detail", home, ["report", "--detail"]],
      ["json", home, ["report", "--json"]],
      ["week", home, ["report", "--week", WEDNESDAY, "--json"]],
      ["this-week", home, ["report", "--this-week", "--detail"]],
      ["month", home, ["report", "--month", MONTH, "--detail"]],
      ["month-json", home, ["report", "--month", MONTH, "--json"]],
      ["html", home, ["report", "--html", htmlPath()]],
      ["open", home, ["report", "--open"]],
      ["help", home, ["report", "--help"]],
      ["status", home, ["status", "--json", "--port", "9"]],
      ["broken", brokenHome, ["report", "--json"]],
      ["broken-text", brokenHome, ["report", "--detail"]],
      ["broken-html", brokenHome, ["report", "--html"]],
      ["bad-flag", home, ["report", "--json", "--jsno"]],
      ["bad-flag-text", home, ["report", "--jsno"]],
      ["bad-week", home, ["report", "--week", "2026-13-40", "--json"]],
      ["two-spans", home, ["report", "--this-week", "--month", "--json"]],
      ["tz-la", fixedHome, ["report", "--week", "2026-11-18", "--json"], { TZ: "America/Los_Angeles" }],
      ["tz-tokyo", fixedHome, ["report", "--week", "2026-11-18", "--json"], { TZ: "Asia/Tokyo" }],
    ];
    const results = await Promise.all(plan.map(([, where, args, env]) => runMesh(where, args, env ?? {})));
    plan.forEach(([name], index) => runs.set(name, results[index]!));
    // After the reads above, so the schedule's own state file does not change them.
    runs.set("deliver", await runMesh(home, ["report", "--deliver", "--json"]));
    runs.set("deliver-again", await runMesh(home, ["report", "--deliver"]));
    // The switch, in order, on its own home.
    runs.set("off", await runMesh(switchHome, ["report", "--off"]));
    runs.set("off-deliver", await runMesh(switchHome, ["report", "--deliver"]));
    runs.set("off-json", await runMesh(switchHome, ["report", "--json"]));
    runs.set("on", await runMesh(switchHome, ["report", "--on", "--json"]));
    runs.set("on-json", await runMesh(switchHome, ["report", "--json"]));
  }, 240_000);

  afterAll(() => {
    for (const dir of [home, brokenHome, switchHome, fixedHome]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const run = (name: string): Run => runs.get(name)!;

  it("no output of any kind repeats a planted string or a key", () => {
    for (const [name, result] of runs) {
      expect(result.stdout.length + result.stderr.length, `${name} printed nothing`).toBeGreaterThan(0);
      expectClean(result.stdout, `${name} stdout`);
      expectClean(result.stderr, `${name} stderr`);
    }
    // Every page written, by --html, --open and the delivery.
    const pages = [htmlPath(), ...readdirSync(join(home, ".mesh", "reports")).map((file) => join(home, ".mesh", "reports", file))];
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const page of pages) expectClean(readFileSync(page, "utf8"), page.replace(home, "~"));
    for (const dir of [home, brokenHome, switchHome]) {
      if (existsSync(reportStatePath(join(dir, ".mesh")))) expectClean(readFileSync(reportStatePath(join(dir, ".mesh")), "utf8"), "the state file");
    }
  });

  it("the text report: the money statement, Theo's lines, the month, where the detail is", () => {
    const { status, stdout, stderr } = run("text");
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).not.toMatch(/[\u001b\u009b]/);
    const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    expect(lines.slice(1, 8)).toEqual([
      "You paid your provider $415.10.",
      "Without Mesh: $503.05.",
      "Mesh saved you $87.95.",
      "Mesh's fee on that: $0.87.",
      "You keep $87.08.",
      "3 requests, ledger verified.",
      "1 request on a model not in the price list is not counted.",
    ]);
    expect(lines[0]).toMatch(/^Mesh, your week \(.+\)\.$/);
    // Theo: a proposal is waiting, and the accepted change earned what the ledger records against it.
    expect(lines[8]).toBe("Theo, your token engineer, found a further saving that needs your OK: mesh theo --proposals");
    expect(lines[9]).toMatch(/^A change Theo proposed and you accepted on \d+ \w+ saved \$1\.25 this week \(verified, included above\)\.$/);
    expect(lines.at(-1)).toBe("Details: mesh report --detail");
    expect(stdout).not.toContain("stale-history-compaction");
    // --detail has the names and ids that look like one; the prose ones are withheld.
    const detail = run("detail").stdout;
    expect(detail).toContain("duplicate-context-removal");
    expect(detail).toContain("stale-history-compaction");
    expect(detail).toContain("anthropic/claude-sonnet-5-5");
    expect(detail).toContain("(withheld)");
    expect(detail).toContain("proved by Theo on your traffic");
  });

  it("--json: one mesh-report/1 object with the documented shape", () => {
    const { status, stdout, stderr } = run("json");
    expect(status).toBe(0);
    expect(stderr).toBe("");
    const out = oneObject(stdout);
    expect(Object.keys(out).sort()).toEqual([
      "case", "currency", "detail", "feeBelowOneCent", "feeCents", "feePercent", "feeUsd", "generatedAt", "headline", "keepUsd",
      "kind", "ledgerVerified", "mesh", "monthLine", "monthToDate", "notifications", "ok", "oneLine", "paidProviderUsd",
      "period", "requests", "savedUsd", "schema", "theo", "unpricedRequests", "withoutMeshUsd",
    ]);
    expect(out).toMatchObject({
      schema: "mesh-report/1",
      ok: true,
      mesh: { version: expect.any(String), build: expect.any(String) },
      kind: "week",
      case: "saved",
      currency: "USD",
      ledgerVerified: true,
      requests: 3,
      paidProviderUsd: 415.1,
      savedUsd: 87.95,
      feePercent: 1,
      feeCents: 87,
      feeUsd: 0.87,
      feeBelowOneCent: false,
      unpricedRequests: 1,
      notifications: "on",
      period: {
        kind: "week",
        id: LAST_MONDAY,
        startDate: LAST_MONDAY,
        endDate: addDays(LAST_MONDAY, 6),
        timeZone: "UTC",
        startsAt: `${LAST_MONDAY}T00:00:00.000Z`,
        endsBefore: `${addDays(LAST_MONDAY, 7)}T00:00:00.000Z`,
        finished: true,
        relative: "last",
      },
      monthToDate: { label: "this month so far", verdict: expect.stringMatching(/^(charge|do_not_charge)$/), feeCents: expect.any(Number) },
      theo: { state: "ran", mode: "recommend", checks: 1, waitingProposals: 1, waitingEstimatedWeeklyUsd: null, heldBack: 1, rolledBack: 0, earning: { changes: 1, savedUsd: 1.25, acceptedByYou: true } },
      oneLine: "Mesh saved you $87.95 last week (fee $0.87). Theo found more: mesh theo --proposals. Details: mesh report",
    });
    expect((out.withoutMeshUsd as number)).toBeCloseTo(503.05, 9);
    expect((out.keepUsd as number)).toBeCloseTo(87.08, 9);
    expect((out.headline as string[])[3]).toBe("Mesh saved you $87.95.");
    const detail = out.detail as { levers: { lever: string }[]; models: { model: string }[]; notes: string[] };
    expect(detail.levers.map((lever) => lever.lever)).toEqual(["(withheld)", "duplicate-context-removal", "stale-history-compaction"]);
    expect(detail.models.map((model) => model.model).sort()).toEqual(["(withheld)", "claude-sonnet-5-5"]);
    // --week with a date in the same week is the same report.
    const week = oneObject(run("week").stdout);
    expect(week.period).toEqual(out.period);
    expect(week.savedUsd).toBe(out.savedUsd);
    // The month, in the same shape.
    const month = oneObject(run("month-json").stdout);
    expect(month).toMatchObject({ schema: "mesh-report/1", kind: "month", period: { kind: "month", id: MONTH, timeZone: "UTC" }, savedUsd: 87.95, feeCents: 87 });
    expect(run("month").stdout).toMatch(/Mesh, your month/);
  });

  it("the week follows the machine's time zone", () => {
    const la = oneObject(run("tz-la").stdout) as { period: { timeZone: string; startsAt: string; endsBefore: string; id: string } };
    expect(la.period).toMatchObject({ id: "2026-11-16", timeZone: "America/Los_Angeles", startsAt: "2026-11-16T08:00:00.000Z", endsBefore: "2026-11-23T08:00:00.000Z" });
    const tokyo = oneObject(run("tz-tokyo").stdout) as { period: { timeZone: string; startsAt: string; endsBefore: string; id: string } };
    expect(tokyo.period).toMatchObject({ id: "2026-11-16", timeZone: "Asia/Tokyo", startsAt: "2026-11-15T15:00:00.000Z", endsBefore: "2026-11-22T15:00:00.000Z" });
  });

  it("--html writes one self-contained page: no external URL, no script, light and dark, phone-ready", () => {
    expect(run("html").status).toBe(0);
    expect(run("html").stdout).toContain(`Page written: ${htmlPath()}`);
    const page = readFileSync(htmlPath(), "utf8");
    expect(page.startsWith("<!doctype html>")).toBe(true);
    for (const banned of ["http", "//", "<script", "javascript:", "src=", "href=", "url(", "@import", "<link", "<iframe", "<img", "onclick", "onload"]) {
      expect(page.toLowerCase().includes(banned), `page contains ${banned}`).toBe(false);
    }
    expect(page).toContain("prefers-color-scheme:dark");
    expect(page).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    // The plain part first, the detail below.
    expect(page.indexOf("Mesh saved you")).toBeGreaterThan(0);
    expect(page.indexOf("Mesh saved you")).toBeLessThan(page.indexOf("The detail"));
    expect(page.indexOf("needs your OK")).toBeLessThan(page.indexOf("The detail"));
    expect(page).toContain("$87.95");
    expect(page).toContain("Nothing was sent anywhere.");
    expect(page.length).toBeLessThan(20_000);
    // --open off a terminal prints the path and opens nothing.
    const opened = run("open");
    expect(opened.status).toBe(0);
    expect(opened.stdout.trim()).toBe(join(home, ".mesh", "reports", `${LAST_MONDAY}.html`));
    expect(existsSync(opened.stdout.trim())).toBe(true);
  });

  it("a ledger that does not verify: no figure, exit 1 in text and JSON alike", () => {
    const broken = run("broken");
    expect(broken.status).toBe(1);
    const out = oneObject(broken.stdout);
    expect(out).toMatchObject({ schema: "mesh-report/1", ok: false, case: "not_verified", ledgerVerified: false, savedUsd: null, feeCents: null, monthToDate: null, detail: null, theo: null });
    expect(broken.stdout).not.toContain("999");
    const text = run("broken-text");
    expect(text.status).toBe(1);
    expect(text.stdout).toContain("Mesh could not verify your ledger this week");
    expect(text.stdout).toContain("Run: mesh verify");
    expect(text.stdout).not.toMatch(/\$\d/);
    expect(run("broken-html").status).toBe(1);
  });

  it("a wrong flag: one failure object with a code, exit 1, as in text mode", () => {
    const bad = run("bad-flag");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe("");
    expect(oneObject(bad.stdout)).toEqual({
      schema: "mesh-report/1",
      ok: false,
      mesh: { version: expect.any(String), build: expect.any(String) },
      error: { code: "usage", message: "Unknown option: --jsno. See mesh report --help." },
    });
    const text = run("bad-flag-text");
    expect(text.status).toBe(1);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("Unknown option: --jsno");
    expect(oneObject(run("bad-week").stdout)).toMatchObject({ ok: false, error: { code: "usage" } });
    expect(oneObject(run("two-spans").stdout)).toMatchObject({ ok: false, error: { code: "usage" } });
    expect(run("help").stdout).toContain("Usage: mesh report");
  });

  it("--off and --on switch the weekly notification and say what they did", () => {
    expect(run("off").status).toBe(0);
    expect(run("off").stdout).toContain("The weekly report is switched off.");
    expect(run("off").stdout).toContain("mesh report --on");
    // Switched off, the weekly check does nothing: no page, no notification.
    expect(run("off-deliver").stdout).toContain("Nothing delivered: the weekly report is switched off");
    expect(existsSync(join(switchHome, ".mesh", "reports"))).toBe(false);
    expect(oneObject(run("off-json").stdout)).toMatchObject({ notifications: "off", case: "saved" });
    expect(oneObject(run("on").stdout)).toEqual({ schema: "mesh-report/1", ok: true, mesh: { version: expect.any(String), build: expect.any(String) }, notifications: "on" });
    expect(oneObject(run("on-json").stdout)).toMatchObject({ notifications: "on" });
  });

  it("another command, off a terminal, is unchanged: one object on stdout and nothing on stderr", () => {
    const status = run("status");
    expect(status.stderr).toBe("");
    expect(oneObject(status.stdout)).toMatchObject({ schema: "mesh-status/1" });
  });

  it("--deliver runs the weekly check once; a second run does nothing", () => {
    const first = oneObject(run("deliver").stdout) as { delivery: { delivered: boolean; reason?: string; text?: string; notification?: { via: string } } };
    // On a Monday before 08:00 nothing is due yet; any other time the page is written and the notifier is off.
    if (first.delivery.delivered) {
      expect(first.delivery.text).toBe("Mesh saved you $87.95 last week (fee $0.87). Theo found more: mesh theo --proposals. Details: mesh report --open");
      expect(first.delivery.notification).toEqual({ via: "none", ok: false, exitCode: null });
      expect(run("deliver-again").stdout).toContain("already delivered");
    } else {
      expect(first.delivery.reason).toBe("before_monday_morning");
    }
  });

  it("the string handed to the notifier, and the page beside it, carry nothing private", async () => {
    const shown: string[] = [];
    const meshHome = join(fixedHome, ".mesh");
    const result = await deliverWeeklyReportIfDue({
      meshHome,
      now: new Date("2026-11-24T12:00:00.000Z"),
      timeZone: "UTC",
      notify: (title, text) => { shown.push(title, text); return Promise.resolve({ via: "osascript", ok: true, exitCode: 0 }); },
    });
    expect(result).toMatchObject({ delivered: true, week: "2026-11-16" });
    expect(shown).toEqual(["Mesh", "Mesh saved you $87.95 last week (fee $0.87). Theo found more: mesh theo --proposals. Details: mesh report --open"]);
    for (const text of shown) expectClean(text, "the notification");
    expect(shown[1]!.endsWith("mesh report --open")).toBe(true);
    if (result.delivered) expectClean(readFileSync(result.page, "utf8"), "the delivered page");
    expectClean(readFileSync(reportStatePath(meshHome), "utf8"), "the state file");
    expectClean(JSON.stringify(result), "the delivery result");
  });
});
