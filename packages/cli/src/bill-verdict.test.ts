/**
 * The verdict the CLI prints is the bill's own. Covers the shared helper, the
 * ledger summary behind `mesh status` and the `mesh start` lines, and `mesh
 * verify` / `mesh status` as real subprocesses with an isolated HOME (their
 * modules fix ~/.mesh paths from homedir() at import time).
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chainLedgerRecord, recomputeInvoice, type BillableEvent, type LedgerRecord } from "../../core/src/savings-ledger.js";
import { CONTRACTED_FEE_PERCENT, feeIsBelowOneCent, recomputeBillInvoice, verdictNote } from "./bill-verdict.js";
import { snapshotLedger, summariseLedger } from "./start.js";

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
  actualUsd: 1,
  levers: [{ leverId: "duplicate-context-removal", kind: "lossless", savedUsd }],
  status: "succeeded",
});

/** Write one hash-chained spool into `ledgerDir` holding the given savings. */
function writeSpool(ledgerDir: string, savings: number[]): void {
  mkdirSync(ledgerDir, { recursive: true });
  const records: LedgerRecord[] = [];
  savings.forEach((savedUsd, index) => {
    records.push(chainLedgerRecord(saved(`r${index}`, savedUsd), records[records.length - 1]));
  });
  writeFileSync(join(ledgerDir, "proxy-anthropic.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function runMesh(home: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", MAIN, command],
      { env: { ...process.env, HOME: home, MESH_NO_AUTO_UPDATE: "1" }, timeout: 45_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`mesh ${command} failed: ${error.message}\n${stdout}\n${stderr}`));
        else resolve(stdout);
      },
    );
  });
}

describe("the bill's verdict, as the CLI recomputes it", () => {
  it("recomputes at the contracted 1% fee", () => {
    expect(CONTRACTED_FEE_PERCENT).toBe(1);
    const invoice = recomputeBillInvoice([saved("a", 21.6267)]);
    expect(invoice.feePercent).toBe(1);
    expect(invoice.amountDueCents).toBe(21);
    expect(invoice.verdict).toBe("charge");
  });

  it("net $0.3609: do_not_charge, with the reason, where a recompute without a fee said charge", () => {
    const events = [saved("a", 0.2), saved("b", 0.1609)];
    expect(recomputeInvoice(events).verdict).toBe("charge"); // the old, fee-less answer
    const invoice = recomputeBillInvoice(events);
    expect(invoice.verdict).toBe("do_not_charge");
    expect(invoice.amountDueCents).toBe(0);
    expect(feeIsBelowOneCent(invoice)).toBe(true);
    expect(verdictNote(invoice)).toBe("do_not_charge: the 1% fee is below one cent");
  });

  it("prints a bare verdict when there is nothing to explain", () => {
    expect(verdictNote(recomputeBillInvoice([saved("a", 21.6267)]))).toBe("charge");
    expect(verdictNote(recomputeBillInvoice([saved("a", 1)]))).toBe("charge");
    expect(verdictNote(recomputeBillInvoice([saved("a", 0.99)]))).toBe("do_not_charge: the 1% fee is below one cent");
    expect(verdictNote(recomputeBillInvoice([saved("a", 0)]))).toBe("do_not_charge");
    expect(verdictNote(recomputeBillInvoice([saved("a", -0.3)]))).toBe("do_not_charge");
    expect(feeIsBelowOneCent(recomputeBillInvoice([saved("a", -0.3)]))).toBe(false);
  });
});

describe("ledger summary and CLI output (isolated HOME)", () => {
  let home: string;
  let ledger: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mesh-verdict-"));
    ledger = join(home, ".mesh", "ledger");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("summariseLedger: positive savings whose fee is below one cent are do_not_charge, and still count as savings", () => {
    writeSpool(ledger, [0.2, 0.1609]);
    const s = summariseLedger(ledger);
    expect(s.events).toBe(2);
    expect(s.savedUsd).toBeCloseTo(0.3609, 10);
    expect(s.verdict).toBe("do_not_charge");
    expect(s.verdictNote).toBe("do_not_charge: the 1% fee is below one cent");
    expect(s.hasVerifiedSavings).toBe(true);
    expect(s.chainOk).toBe(true);
    // The sign-up invitation's snapshot is about savings and is unchanged.
    expect(snapshotLedger(ledger).verdict).toBe("charge");
  });

  it("summariseLedger: a billable ledger is charge; tiny, empty and missing ledgers are do_not_charge", () => {
    writeSpool(ledger, [21.6267]);
    expect(summariseLedger(ledger)).toMatchObject({ verdict: "charge", verdictNote: "charge", hasVerifiedSavings: true });

    writeSpool(ledger, [0.0024]);
    expect(summariseLedger(ledger)).toMatchObject({
      verdict: "do_not_charge",
      verdictNote: "do_not_charge: the 1% fee is below one cent",
      hasVerifiedSavings: false,
    });

    writeSpool(ledger, [-0.5]);
    expect(summariseLedger(ledger)).toMatchObject({ verdict: "do_not_charge", verdictNote: "do_not_charge", hasVerifiedSavings: false });

    expect(summariseLedger(join(home, "no-such-dir"))).toMatchObject({
      events: 0, verdict: "do_not_charge", verdictNote: "do_not_charge", hasVerifiedSavings: false,
    });
  });

  it("mesh verify prints the bill's verdict: do_not_charge with the reason at $0.3609, charge at $21.6267", { timeout: 100_000 }, async () => {
    writeSpool(ledger, [0.2, 0.1609]);
    const small = await runMesh(home, "verify");
    expect(small).toContain("invoice recomputes identically: $0.3609 verified (do_not_charge: the 1% fee is below one cent)");
    expect(small).not.toContain("verified (charge)");
    expect(small).toContain("All checks passed.");

    writeSpool(ledger, [21.6267]);
    const billable = await runMesh(home, "verify");
    expect(billable).toContain("invoice recomputes identically: $21.6267 verified (charge)");
    expect(billable).toContain("All checks passed.");
  });

  it("mesh status prints the bill's verdict and still invites sign-up when savings exist", { timeout: 100_000 }, async () => {
    writeSpool(ledger, [0.2, 0.1609]);
    const small = await runMesh(home, "status");
    expect(small).toContain("2 requests seen · $0.3609 verified saved (do_not_charge: the 1% fee is below one cent)");
    expect(small).toContain("keep these savings metered");

    writeSpool(ledger, [21.6267]);
    const billable = await runMesh(home, "status");
    expect(billable).toContain("1 requests seen · $21.6267 verified saved (charge)");
  });
});
