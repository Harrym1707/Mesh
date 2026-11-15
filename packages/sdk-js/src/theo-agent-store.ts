import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { savingsSnapshotFromSpoolDir } from "./savings-snapshot.js";
import type { TheoMemory } from "./theo-agent.js";

/**
 * The impure edge of the Theo agent: load and save his per-customer memory, and
 * read realised savings from the ledger. The reasoning in `theo-agent.ts` stays
 * pure; everything that touches the disk is here.
 *
 * Memory is a single JSON document per customer, kept alongside the ledger it is
 * about (default `<ledgerDir>/theo/<customer>.json`). It never contains prompt or
 * response content — only Theo's policy, hypotheses, experiment log and proposals.
 */

/** Default location for a customer's Theo memory, beside their ledger. */
export function defaultTheoMemoryPath(ledgerDir: string, customer: string): string {
  const safe = customer.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(ledgerDir, "theo", `${safe}.json`);
}

/** Load Theo's memory, or null if it is absent or unreadable. */
export function loadTheoMemory(path: string): TheoMemory | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TheoMemory;
    if (parsed && typeof parsed === "object" && parsed.schemaVersion === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Persist Theo's memory, creating the directory if needed. */
export function saveTheoMemory(path: string, memory: TheoMemory): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}

/**
 * Realised, verified figures for the report, read from the ledger spools the
 * proxy wrote. A tampered or truncated spool is excluded by the chain check
 * inside `savingsSnapshotFromSpoolDir`, so these numbers are never inflated.
 */
export function realisedFromSpoolDir(ledgerDir: string): {
  savingsUsd: number;
  spendUsd: number;
  requests: number;
  chainOk: boolean;
} {
  const snapshot = savingsSnapshotFromSpoolDir(ledgerDir);
  return {
    savingsUsd: snapshot.savedUsd,
    spendUsd: snapshot.spendUsd,
    requests: snapshot.requests,
    chainOk: snapshot.chainOk,
  };
}
