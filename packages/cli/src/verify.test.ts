/**
 * `mesh verify` over a ledger that does not verify: it must not print a
 * ticked "determinism" line or call any total "verified", and it must exit
 * non-zero. The checks are tested directly, then the command is run as a real
 * subprocess with an isolated HOME (the module fixes ~/.mesh from homedir()).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chainLedgerRecord, type BillableEvent, type LedgerRecord } from "../../core/src/savings-ledger.js";
import { formatCheck, ledgerChecks } from "./verify.js";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

const saved = (requestId: string, savedUsd: number): BillableEvent => ({
  schemaVersion: 1,
  requestId,
  applicationId: "proxy",
  invoicePeriod: "2026-11",
  timestamp: "2026-11-10T10:00:00.000Z",
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
    records.push(chainLedgerRecord(saved(`r${index}`, savedUsd), records[records.length - 1]));
  });
  return records.map((record) => JSON.stringify(record));
}

describe("mesh verify: ledger and determinism checks", () => {
  let home: string;
  let ledger: string;
  let spool: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mesh-verify-"));
    ledger = join(home, ".mesh", "ledger");
    mkdirSync(ledger, { recursive: true });
    spool = join(ledger, "proxy-anthropic.jsonl");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const write = (lines: string[]): void => writeFileSync(spool, lines.join("\n") + "\n");
  /** Edit one saving in place without re-chaining: the tamper the chain exists to catch. */
  const editSaving = (lines: string[], index: number, savedUsd: number): string[] => {
    const copy = [...lines];
    const record = JSON.parse(copy[index]!) as LedgerRecord;
    (record.event.levers[0] as { savedUsd: number }).savedUsd = savedUsd;
    copy[index] = JSON.stringify(record);
    return copy;
  };

  it("an intact ledger: both checks pass and the total is printed as verified", () => {
    write(spoolLines([50, 52.4494]));
    const [ledgerCheck, determinism] = ledgerChecks(ledger);
    expect(ledgerCheck).toMatchObject({ name: "ledger", ok: true });
    expect(ledgerCheck!.detail).toBe("hash-chain verified across 1 spool(s), 2 record(s)");
    expect(determinism).toMatchObject({ name: "determinism", ok: true });
    expect(determinism!.notChecked).toBeUndefined();
    expect(determinism!.detail).toBe("invoice recomputes identically: $102.4494 verified (charge)");
    expect(formatCheck(determinism!)).toMatch(/^ {2}✓ determinism/);
  });

  it("one saving edited: the ledger fails, determinism is not checked, and no total is called verified", () => {
    write(editSaving(spoolLines([50, 2.4494]), 0, 100));
    const checks = ledgerChecks(ledger);
    expect(checks).toHaveLength(2);
    const [ledgerCheck, determinism] = checks;
    expect(ledgerCheck).toMatchObject({ name: "ledger", ok: false });
    expect(ledgerCheck!.detail).toContain("proxy-anthropic.jsonl: broken at seq 0");
    expect(determinism).toEqual({
      name: "determinism",
      ok: false,
      notChecked: true,
      detail: "not checked: the ledger did not verify",
    });
    expect(formatCheck(determinism!)).toBe("  – determinism  not checked: the ledger did not verify");
    expect(formatCheck(ledgerCheck!)).toMatch(/^ {2}✗ ledger/);
    const printed = checks.map(formatCheck).join("\n");
    expect(printed).not.toContain("verified (");
    expect(printed).not.toContain("recomputes identically");
    expect(printed).not.toContain("102.4494");
    expect(printed).not.toContain("✓");
  });

  it("a record removed from the middle is a broken chain, handled the same way", () => {
    const lines = spoolLines([1, 2, 3]);
    write([lines[0]!, lines[2]!]);
    const [ledgerCheck, determinism] = ledgerChecks(ledger);
    expect(ledgerCheck!.ok).toBe(false);
    expect(determinism).toMatchObject({ ok: false, notChecked: true });
  });

  it("a line that is not a ledger record fails the ledger check instead of being skipped", () => {
    const lines = spoolLines([1, 2]);
    write([lines[0]!, "{ this is not json", lines[1]!]);
    const [ledgerCheck, determinism] = ledgerChecks(ledger);
    expect(ledgerCheck).toMatchObject({ ok: false, detail: "proxy-anthropic.jsonl: line 2 is not a readable ledger record" });
    expect(determinism).toMatchObject({ ok: false, notChecked: true });
  });

  it("a spool that cannot be read fails the ledger check", () => {
    write(spoolLines([1]));
    mkdirSync(join(ledger, "broken.jsonl")); // a directory where a spool should be: reading it throws
    const [ledgerCheck, determinism] = ledgerChecks(ledger);
    expect(ledgerCheck!.ok).toBe(false);
    expect(ledgerCheck!.detail).toContain("broken.jsonl: could not be read");
    expect(determinism).toMatchObject({ ok: false, notChecked: true });
  });

  it("one bad spool among good ones still stops the recompute, and names every failure", () => {
    write(editSaving(spoolLines([5]), 0, 500));
    writeFileSync(join(ledger, "proxy-openai.jsonl"), spoolLines([7]).join("\n") + "\n");
    const [ledgerCheck, determinism] = ledgerChecks(ledger);
    expect(ledgerCheck!.ok).toBe(false);
    expect(ledgerCheck!.detail).toContain("proxy-anthropic.jsonl");
    expect(ledgerCheck!.detail).not.toContain("proxy-openai.jsonl");
    expect(determinism!.notChecked).toBe(true);
  });

  it("no ledger yet is not a failure; sidecar feature files are not spools", () => {
    rmSync(spool, { force: true });
    writeFileSync(join(ledger, "proxy-anthropic.features.jsonl"), "not a spool\n");
    const checks = ledgerChecks(ledger);
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks[1]!.detail).toBe("nothing to recompute yet");
    expect(ledgerChecks(join(home, "no-such-dir")).every((check) => check.ok)).toBe(true);
  });

  it("the command itself: an edited saving exits non-zero with no ticked determinism line", { timeout: 60_000 }, () => {
    write(editSaving(spoolLines([50, 2.4494]), 0, 100));
    const before = readFileSync(spool, "utf8");
    const result = spawnSync(process.execPath, ["--import", "tsx", MAIN, "verify"], {
      env: { ...process.env, HOME: home, MESH_NO_AUTO_UPDATE: "1" },
      encoding: "utf8",
      timeout: 45_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("✗ ledger");
    expect(result.stdout).toContain("– determinism  not checked: the ledger did not verify");
    expect(result.stdout).not.toContain("✓ determinism");
    expect(result.stdout).not.toContain("verified (");
    expect(result.stdout).not.toContain("102.4494");
    expect(result.stdout).toContain("SOME CHECKS FAILED");
    // Verifying never writes to the ledger.
    expect(readFileSync(spool, "utf8")).toBe(before);
  });

  it("the command itself: an intact ledger still passes and exits zero", { timeout: 60_000 }, () => {
    write(spoolLines([50, 52.4494]));
    const result = spawnSync(process.execPath, ["--import", "tsx", MAIN, "verify"], {
      env: { ...process.env, HOME: home, MESH_NO_AUTO_UPDATE: "1" },
      encoding: "utf8",
      timeout: 45_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ determinism  invoice recomputes identically: $102.4494 verified (charge)");
    expect(result.stdout).toContain("All checks passed.");
  });
});
