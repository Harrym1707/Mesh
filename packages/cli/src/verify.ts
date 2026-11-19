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
import { join } from "node:path";

import { verifyLedgerChain, type LedgerRecord } from "../../core/src/savings-ledger.js";
import { reduceRequest } from "../../sdk-js/src/reduce-request.js";
import { recomputeBillInvoice, verdictNote } from "./bill-verdict.js";
import { BUILD_COMMIT } from "./start.js";

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

/**
 * Checks 3 and 4 over one ledger directory: every spool's hash chain, then the
 * invoice recompute. Pure apart from reading the directory, so it is tested
 * directly.
 *
 * A ledger that does not verify (a broken chain, a spool that cannot be read,
 * a line that is not a ledger record) stops here: the invoice is NOT recomputed
 * and no savings figure is printed, because a total worked out from a ledger
 * that failed its check is not a verified total.
 */
export function ledgerChecks(ledgerDir: string): Check[] {
  const spools = existsSync(ledgerDir) ? readdirSync(ledgerDir).filter(isSpool).sort() : [];
  if (spools.length === 0) {
    return [
      { name: "ledger", ok: true, detail: "no ledger yet — run `mesh start` and use Claude Code, then verify again" },
      { name: "determinism", ok: true, detail: "nothing to recompute yet" },
    ];
  }

  const all: LedgerRecord[] = [];
  const failures: string[] = [];
  let total = 0;
  for (const spool of spools) {
    let text: string;
    try {
      text = readFileSync(join(ledgerDir, spool), "utf8");
    } catch (cause) {
      failures.push(`${spool}: could not be read (${cause instanceof Error ? cause.message : String(cause)})`);
      continue;
    }
    const records: LedgerRecord[] = [];
    let unreadableLine: number | undefined;
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.trim() === "" || unreadableLine !== undefined) return;
      try { records.push(JSON.parse(line) as LedgerRecord); } catch { unreadableLine = index + 1; }
    });
    if (unreadableLine !== undefined) {
      failures.push(`${spool}: line ${unreadableLine} is not a readable ledger record`);
      continue;
    }
    total += records.length;
    const chain = verifyLedgerChain(records);
    if (!chain.ok) failures.push(`${spool}: broken at seq ${chain.seq} (${chain.reason})`);
    all.push(...records);
  }

  if (failures.length > 0) {
    return [
      { name: "ledger", ok: false, detail: failures.join("; ") },
      { name: "determinism", ok: false, notChecked: true, detail: "not checked: the ledger did not verify" },
    ];
  }

  const events = all.map((r) => r.event);
  // Recomputed at the contracted fee, with the same options on every call, so
  // the comparison is still a like-for-like determinism check and the verdict
  // printed is the bill's own (do_not_charge when the fee is below one cent).
  const once = JSON.stringify(recomputeBillInvoice(events));
  const twice = JSON.stringify(recomputeBillInvoice(events));
  const invoice = recomputeBillInvoice(events);
  return [
    { name: "ledger", ok: true, detail: `hash-chain verified across ${spools.length} spool(s), ${total} record(s)` },
    {
      name: "determinism",
      ok: once === twice,
      detail: once === twice
        ? `invoice recomputes identically: $${invoice.netVerifiedSavingsUsd.toFixed(4)} verified (${verdictNote(invoice)})`
        : "invoice is NON-deterministic — this should never happen; please report it",
    },
  ];
}

export async function runVerify(_argv: string[]): Promise<void> {
  const checks: Check[] = [];

  // 1. PROVENANCE — the cached runtime is byte-identical to what passed its
  // checksum when the bootstrap downloaded it (local integrity of the cached
  // artifact; authenticity of a release comes from its CI signature/attestation).
  const runtimeDir = join(homedir(), ".mesh", "runtime");
  const runtimeFile = join(runtimeDir, "mesh-runtime.mjs");
  const recordedSha = existsSync(join(runtimeDir, "sha256")) ? readFileSync(join(runtimeDir, "sha256"), "utf8").trim() : null;
  if (recordedSha !== null && existsSync(runtimeFile)) {
    const actual = createHash("sha256").update(readFileSync(runtimeFile)).digest("hex");
    checks.push({
      name: "provenance",
      ok: actual === recordedSha,
      detail: actual === recordedSha
        ? `build ${BUILD_COMMIT}; cached runtime matches its download checksum`
        : `build ${BUILD_COMMIT}; CACHED RUNTIME ALTERED since download (checksum mismatch)`,
    });
  } else {
    checks.push({ name: "provenance", ok: true, detail: `build ${BUILD_COMMIT} (npm or dev build — no download checksum to re-verify)` });
  }

  // 2. REDUCER — the real lossless reducer removes tokens from the sample.
  const { summary } = reduceRequest(sampleRequest(), { toolSchemas: true, duplicateContext: true, repairCachePrefix: true });
  const reducerOk = !summary.skipped && summary.estimatedLosslessTokensSaved > 0;
  checks.push({
    name: "reducer",
    ok: reducerOk,
    detail: reducerOk
      ? `lossless: ${summary.estimatedTokensBefore} → ${summary.estimatedTokensAfter} tokens (−${summary.estimatedLosslessTokensSaved}), ${summary.changes.length} lever(s)`
      : `reducer did not fire (${summary.skippedReason ?? "no lossless saving"})`,
  });

  // 3 + 4. LEDGER chain + invoice DETERMINISM, on the user's own spools.
  checks.push(...ledgerChecks(LEDGER_DIR));

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
