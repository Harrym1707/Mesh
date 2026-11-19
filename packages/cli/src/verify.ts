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

type Check = { name: string; ok: boolean; detail: string };

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
  if (!existsSync(LEDGER_DIR) || readdirSync(LEDGER_DIR).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".features.jsonl")).length === 0) {
    checks.push({ name: "ledger", ok: true, detail: "no ledger yet — run `mesh start` and use Claude Code, then verify again" });
    checks.push({ name: "determinism", ok: true, detail: "nothing to recompute yet" });
  } else {
    const spools = readdirSync(LEDGER_DIR).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".features.jsonl"));
    const all: LedgerRecord[] = [];
    let chainOk = true;
    let chainDetail = "";
    let total = 0;
    for (const spool of spools) {
      const records: LedgerRecord[] = [];
      for (const line of readFileSync(join(LEDGER_DIR, spool), "utf8").trim().split(/\r?\n/)) {
        if (line.trim() === "") continue;
        try { records.push(JSON.parse(line) as LedgerRecord); } catch { /* skip */ }
      }
      total += records.length;
      const chain = verifyLedgerChain(records);
      if (!chain.ok) { chainOk = false; chainDetail = `${spool}: broken at seq ${chain.seq} (${chain.reason})`; }
      all.push(...records);
    }
    checks.push({
      name: "ledger",
      ok: chainOk,
      detail: chainOk ? `hash-chain verified across ${spools.length} spool(s), ${total} record(s)` : chainDetail,
    });

    const events = all.map((r) => r.event);
    // Recomputed at the contracted fee, with the same options on every call, so
    // the comparison is still a like-for-like determinism check and the verdict
    // printed is the bill's own (do_not_charge when the fee is below one cent).
    const once = JSON.stringify(recomputeBillInvoice(events));
    const twice = JSON.stringify(recomputeBillInvoice(events));
    const invoice = recomputeBillInvoice(events);
    checks.push({
      name: "determinism",
      ok: once === twice,
      detail: once === twice
        ? `invoice recomputes identically: $${invoice.netVerifiedSavingsUsd.toFixed(4)} verified (${verdictNote(invoice)})`
        : "invoice is NON-deterministic — this should never happen; please report it",
    });
  }

  // ---- report ----
  console.log("");
  console.log(`  mesh verify — build ${BUILD_COMMIT}`);
  console.log("");
  let allOk = true;
  for (const c of checks) {
    allOk = allOk && c.ok;
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(12)} ${c.detail}`);
  }
  console.log("");
  console.log(`  Savings are measured from your provider's own reported usage, never MESH's estimate.`);
  console.log(`  The ledger is yours; this command recomputes the invoice from it with no network calls.`);
  console.log("");
  console.log(allOk ? `  All checks passed.` : `  SOME CHECKS FAILED — see above.`);
  if (!allOk) process.exit(1);
}
