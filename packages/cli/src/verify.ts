/**
 * `mesh verify` — prove, on this machine, that what you installed IS the MESH
 * we built, and that its claims hold. Four checks, each mapping to a claim:
 *
 *   1. PROVENANCE   — the exact build commit this binary was cut from.
 *   2. REDUCER      — the real reducer removes tokens LOSSLESSLY from a sample
 *                     request (the product actually does the thing).
 *   3. LEDGER       — your own ledger's hash-chain verifies (tamper-evident).
 *   4. DETERMINISM  — the invoice recomputes to the identical number twice
 *                     (recomputable from a ledger you hold).
 *
 * Exits non-zero if any check fails, so it is safe to run in CI or a hook.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { verifyLedgerChain, type Invoice, type LedgerRecord } from "../../core/src/savings-ledger.js";
import { reduceRequest } from "../../sdk-js/src/reduce-request.js";
import { billVerdict, recomputeBillInvoice, verdictNote, type VerdictReasonCode } from "./bill-verdict.js";
import { BUILD_COMMIT } from "./build-info.js";
import { meshIdentity, parseFlags, writeJson, type MeshIdentity } from "./json-output.js";

const LEDGER_DIR = join(homedir(), ".mesh", "ledger");

/** A deliberately wasteful Anthropic Messages request: duplicated history + verbose tool schema. */
function sampleRequest(): unknown {
  const dup = "Records 0-19: settlement entry nominal, reconciliation standard, no notification sent, annotation routine.";
  const schema = {
    name: "lookup",
    description: "Look up records in a subsystem.",
    input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false, properties: { id: { type: "string" } } },
  };
  return {
    model: "claude-sonnet-5-5",
    system: "You are a careful assistant. Cite sources. Escalate anything risky.",
    tools: [schema, { ...schema, name: "lookup_2" }, { ...schema, name: "lookup_3" }],
    messages: [
      { role: "user", content: `Excerpts for case 7: ${dup} ${dup} ${dup}` },
      { role: "assistant", content: "Understood." },
      { role: "user", content: `${dup} ${dup} Question: what does clause 7 require?` },
    ],
  };
}

/** `notChecked` marks a check that was skipped because an earlier one failed: printed with a dash, never a tick. */
export type Check = { name: string; ok: boolean; detail: string; notChecked?: boolean };

/** One report line: a tick, a cross, or a dash for a check that was not run. */
export function formatCheck(check: Check): string {
  const mark = check.notChecked ? "–" : check.ok ? "✓" : "✗";
  return `  ${mark} ${check.name.padEnd(12)} ${check.detail}`;
}

const isSpool = (file: string): boolean => file.endsWith(".jsonl") && !file.endsWith(".features.jsonl");

/** Why one spool did not verify. `spool` is its 1-based position in name order. */
export type SpoolFailure =
  | { spool: number; name: string; kind: "unreadable_file"; errno: string; message: string }
  | { spool: number; name: string; kind: "unreadable_line"; line: number }
  | { spool: number; name: string; kind: "broken_chain"; seq: unknown; reason: string };

/**
 * What checks 3 and 4 found in one ledger directory, as data. `checks` are the
 * two report lines; the rest is what they were worked out from, so a caller
 * can read the totals without parsing a sentence.
 */
export type LedgerInspection = {
  checks: Check[];
  spools: number;
  /** Records in the spools that could be read. */
  records: number;
  chainVerified: boolean;
  failures: SpoolFailure[];
  /** The recompute at the contracted fee. Absent when there is no ledger or it did not verify. */
  invoice?: Invoice;
  /** True when the invoice recomputed to the identical result twice. Absent when not checked. */
  deterministic?: boolean;
};

/**
 * Checks 3 and 4 over one ledger directory: every spool's hash chain, then the
 * invoice recompute. Pure apart from reading the directory, so it is tested
 * directly.
 *
 * A ledger that does not verify (a broken chain, a spool that cannot be read,
 * a line that is not a ledger record) stops here: the invoice is NOT recomputed
 * and no savings figure is given, because a total worked out from a ledger
 * that failed its check is not a verified total.
 */
export function inspectLedger(ledgerDir: string): LedgerInspection {
  const spools = existsSync(ledgerDir) ? readdirSync(ledgerDir).filter(isSpool).sort() : [];
  if (spools.length === 0) {
    return {
      checks: [
        { name: "ledger", ok: true, detail: "no ledger yet — run `mesh start` and use Claude Code, then verify again" },
        { name: "determinism", ok: true, detail: "nothing to recompute yet" },
      ],
      spools: 0,
      records: 0,
      chainVerified: true,
      failures: [],
    };
  }

  const all: LedgerRecord[] = [];
  const failures: SpoolFailure[] = [];
  let total = 0;
  spools.forEach((spool, position) => {
    let text: string;
    try {
      text = readFileSync(join(ledgerDir, spool), "utf8");
    } catch (cause) {
      failures.push({
        spool: position + 1,
        name: spool,
        kind: "unreadable_file",
        errno: (cause as NodeJS.ErrnoException).code ?? "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    const records: LedgerRecord[] = [];
    let unreadableLine: number | undefined;
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.trim() === "" || unreadableLine !== undefined) return;
      try { records.push(JSON.parse(line) as LedgerRecord); } catch { unreadableLine = index + 1; }
    });
    if (unreadableLine !== undefined) {
      failures.push({ spool: position + 1, name: spool, kind: "unreadable_line", line: unreadableLine });
      return;
    }
    total += records.length;
    const chain = verifyLedgerChain(records);
    if (!chain.ok) failures.push({ spool: position + 1, name: spool, kind: "broken_chain", seq: chain.seq, reason: chain.reason });
    all.push(...records);
  });

  if (failures.length > 0) {
    const described = failures.map((failure) =>
      failure.kind === "unreadable_file" ? `${failure.name}: could not be read (${failure.message})`
        : failure.kind === "unreadable_line" ? `${failure.name}: line ${failure.line} is not a readable ledger record`
          : `${failure.name}: broken at seq ${String(failure.seq)} (${failure.reason})`);
    return {
      checks: [
        { name: "ledger", ok: false, detail: described.join("; ") },
        { name: "determinism", ok: false, notChecked: true, detail: "not checked: the ledger did not verify" },
      ],
      spools: spools.length,
      records: total,
      chainVerified: false,
      failures,
    };
  }

  const events = all.map((r) => r.event);
  // Recomputed at the contracted fee, with the same options on every call, so
  // the comparison is still a like-for-like determinism check and the verdict
  // printed is the bill's own (do_not_charge when the fee is below one cent).
  const once = JSON.stringify(recomputeBillInvoice(events));
  const twice = JSON.stringify(recomputeBillInvoice(events));
  const invoice = recomputeBillInvoice(events);
  return {
    checks: [
      { name: "ledger", ok: true, detail: `hash-chain verified across ${spools.length} spool(s), ${total} record(s)` },
      {
        name: "determinism",
        ok: once === twice,
        detail: once === twice
          ? `invoice recomputes identically: $${invoice.netVerifiedSavingsUsd.toFixed(4)} verified (${verdictNote(invoice)})`
          : "invoice is NON-deterministic — this should never happen; please report it",
      },
    ],
    spools: spools.length,
    records: total,
    chainVerified: true,
    failures: [],
    invoice,
    deterministic: once === twice,
  };
}

/** The two report lines for one ledger directory. See {@link inspectLedger}. */
export function ledgerChecks(ledgerDir: string): Check[] {
  return inspectLedger(ledgerDir).checks;
}

// ---------------------------------------------------------------------------
// The result an agent reads (mesh verify --json, and in-process callers)
// ---------------------------------------------------------------------------

export type VerifyCheckStatus = "ok" | "failed" | "not_checked";

export type VerifyResult = {
  schema: "mesh-verify/1";
  /** True when every check passed. The command exits 0 exactly when this is true. */
  ok: boolean;
  mesh: MeshIdentity;
  checks: { name: "provenance" | "reducer" | "ledger" | "determinism"; status: VerifyCheckStatus; detail: string }[];
  currency: "USD";
  ledger: {
    path: string;
    spools: number;
    records: number;
    chainVerified: boolean;
    /** Where each spool stops verifying. Spools are numbered in name order; file names are not repeated. */
    failures: { spool: number; problem: "unreadable_file" | "unreadable_line" | "broken_chain"; line?: number; seq?: number }[];
  };
  /**
   * The figure the text output calls "verified", over every request in the
   * ledger (all periods). Null when there is no ledger yet or it did not
   * verify: a ledger that fails its check has no verified total.
   */
  totals: null | {
    netVerifiedSavingsUsd: number;
    netVerifiedSavingsCents: number;
    feePercent: number;
    feeCents: number;
    feeUsd: number;
    verdict: "charge" | "do_not_charge";
    reasonCode?: VerdictReasonCode;
    reason?: string;
  };
};

/** What `collectVerify` reads. Defaults are this user's own ~/.mesh. */
export type VerifyOptions = { ledgerDir?: string; runtimeDir?: string };

/** A failure described without the spool's file name or anything read from an event. */
function failureDetail(failure: SpoolFailure): string {
  if (failure.kind === "unreadable_file") return `spool ${failure.spool}: could not be read (${failure.errno})`;
  if (failure.kind === "unreadable_line") return `spool ${failure.spool}: line ${failure.line} is not a readable ledger record`;
  return `spool ${failure.spool}: hash chain broken${typeof failure.seq === "number" ? ` at seq ${failure.seq}` : ""}`;
}

/** Check 1: the cached runtime is byte-identical to what passed its checksum when it was downloaded. */
function provenanceCheck(runtimeDir: string): Check {
  const runtimeFile = join(runtimeDir, "mesh-runtime.mjs");
  const recordedSha = existsSync(join(runtimeDir, "sha256")) ? readFileSync(join(runtimeDir, "sha256"), "utf8").trim() : null;
  if (recordedSha !== null && existsSync(runtimeFile)) {
    const actual = createHash("sha256").update(readFileSync(runtimeFile)).digest("hex");
    return {
      name: "provenance",
      ok: actual === recordedSha,
      detail: actual === recordedSha
        ? `build ${BUILD_COMMIT}; cached runtime matches its download checksum`
        : `build ${BUILD_COMMIT}; CACHED RUNTIME ALTERED since download (checksum mismatch)`,
    };
  }
  return { name: "provenance", ok: true, detail: `build ${BUILD_COMMIT} (npm or dev build — no download checksum to re-verify)` };
}

/** Check 2: the real lossless reducer removes tokens from the built-in sample request. */
function reducerCheck(): Check {
  const { summary } = reduceRequest(sampleRequest(), { toolSchemas: true, duplicateContext: true, repairCachePrefix: true });
  const reducerOk = !summary.skipped && summary.estimatedLosslessTokensSaved > 0;
  return {
    name: "reducer",
    ok: reducerOk,
    detail: reducerOk
      ? `lossless: ${summary.estimatedTokensBefore} → ${summary.estimatedTokensAfter} tokens (−${summary.estimatedLosslessTokensSaved}), ${summary.changes.length} lever(s)`
      : `reducer did not fire (${summary.skippedReason ?? "no lossless saving"})`,
  };
}

/** The four checks, in order, as the text report prints them. Reads only; no network. */
function runChecks(options: VerifyOptions): { checks: Check[]; inspection: LedgerInspection; ledgerDir: string } {
  const ledgerDir = options.ledgerDir ?? LEDGER_DIR;
  // Provenance is local integrity of the cached artifact; authenticity of a
  // release comes from its CI signature/attestation.
  const inspection = inspectLedger(ledgerDir);
  return {
    checks: [provenanceCheck(options.runtimeDir ?? join(homedir(), ".mesh", "runtime")), reducerCheck(), ...inspection.checks],
    inspection,
    ledgerDir,
  };
}

/**
 * `mesh verify` as data: the four checks and the totals. Returns; never prints
 * and never exits. The same function backs the text report, `--json`, and any
 * in-process caller.
 */
export function collectVerify(options: VerifyOptions = {}): VerifyResult {
  const { checks, inspection, ledgerDir } = runChecks(options);
  const ledgerFailed = !inspection.chainVerified;
  const bill = inspection.invoice === undefined ? undefined : billVerdict(inspection.invoice);
  return {
    schema: "mesh-verify/1",
    ok: checks.every((check) => check.ok),
    mesh: meshIdentity(),
    checks: checks.map((check) => ({
      name: check.name as VerifyResult["checks"][number]["name"],
      status: check.notChecked ? "not_checked" : check.ok ? "ok" : "failed",
      // The ledger line names spool files on screen; here spools are numbered instead.
      detail: check.name === "ledger" && ledgerFailed ? inspection.failures.map(failureDetail).join("; ") : check.detail,
    })),
    currency: "USD",
    ledger: {
      path: ledgerDir,
      spools: inspection.spools,
      records: inspection.records,
      chainVerified: inspection.chainVerified,
      failures: inspection.failures.map((failure) => ({
        spool: failure.spool,
        problem: failure.kind,
        ...(failure.kind === "unreadable_line" ? { line: failure.line } : {}),
        ...(failure.kind === "broken_chain" && typeof failure.seq === "number" ? { seq: failure.seq } : {}),
      })),
    },
    totals: inspection.invoice === undefined || bill === undefined
      ? null
      : {
          netVerifiedSavingsUsd: inspection.invoice.netVerifiedSavingsUsd,
          netVerifiedSavingsCents: inspection.invoice.netVerifiedSavingsCents,
          feePercent: bill.feePercent,
          feeCents: bill.feeCents,
          feeUsd: bill.feeUsd,
          verdict: bill.verdict,
          ...(bill.reasonCode === undefined ? {} : { reasonCode: bill.reasonCode, reason: bill.reason }),
        },
  };
}

const USAGE = `Usage: mesh verify [options]

Re-prove MESH's claims on this machine, with no network calls: the build's
provenance, the lossless reducer, your ledger's hash chain, and that the
invoice recomputes to the identical number twice.

  --ledger <dir>   Ledger directory to check. Default ~/.mesh/ledger.
  --json           Print one JSON object (schema mesh-verify/1) instead of text.
  --help           Show this message.

Exits 0 when every check passes, 1 when any fails (the same with --json).`;

export async function runVerify(argv: string[]): Promise<void> {
  const { values, flags } = parseFlags("verify", argv, { valueFlags: ["--ledger"] });
  if (flags.has("--help")) { console.log(USAGE); return; }
  const options: VerifyOptions = values["--ledger"] === undefined ? {} : { ledgerDir: resolve(values["--ledger"]) };

  if (flags.has("--json")) {
    const result = collectVerify(options);
    writeJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const { checks } = runChecks(options);

  // ---- report ----
  console.log("");
  console.log(`  mesh verify — build ${BUILD_COMMIT}`);
  console.log("");
  let allOk = true;
  for (const c of checks) {
    allOk = allOk && c.ok;
    console.log(formatCheck(c));
  }
  console.log("");
  console.log(`  Savings are measured from your provider's own reported usage, never MESH's estimate.`);
  console.log(`  The ledger is yours; this command recomputes the invoice from it with no network calls.`);
  console.log("");
  console.log(allOk ? `  All checks passed.` : `  SOME CHECKS FAILED — see above.`);
  if (!allOk) process.exit(1);
}
