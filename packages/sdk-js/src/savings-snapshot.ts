import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recomputeInvoice,
  verifyLedgerChain,
  type BillableEvent,
  type LedgerRecord,
} from "../../core/dist/src/index.js";
import type { SavingsSnapshot } from "./cta.js";

/**
 * Build a {@link SavingsSnapshot} from ledger events or spools. Kept apart from
 * the pure CTA formatters in `./cta.js` because recomputing an invoice pulls in
 * the billing engine — the CLI, which bundles core from source, imports only
 * the formatters and builds its snapshot from its own ledger read.
 */

const EMPTY: SavingsSnapshot = {
  requests: 0,
  savedUsd: 0,
  spendUsd: 0,
  verdict: "do_not_charge",
  chainOk: true,
};

/** Fold a set of ledger events into a snapshot. `chainOk` carries through. */
export function savingsSnapshotFromEvents(
  events: readonly BillableEvent[],
  chainOk = true,
): SavingsSnapshot {
  if (!chainOk) return { ...EMPTY, chainOk: false };
  if (events.length === 0) return EMPTY;
  const invoice = recomputeInvoice(events, { feePercent: 1 });
  // Spend is what the provider actually charged for the metered (reduced)
  // traffic; the baseline is that plus the verified savings.
  const spendUsd = events.reduce((sum, event) => sum + (event.actualUsd ?? 0), 0);
  return {
    requests: invoice.eventsConsidered,
    savedUsd: invoice.netVerifiedSavingsUsd,
    spendUsd,
    verdict: invoice.verdict,
    chainOk: true,
  };
}

function readLedgerRecords(path: string): LedgerRecord[] | null {
  try {
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
    return lines.map((line) => JSON.parse(line) as LedgerRecord);
  } catch {
    return null;
  }
}

/**
 * Summarise every ledger spool in a directory (the proxy writes one JSONL per
 * app + provider). Any spool whose hash chain does not verify is excluded and
 * flips `chainOk` to false, so a tampered or truncated spool is never silently
 * folded into the number.
 */
export function savingsSnapshotFromSpoolDir(dir: string): SavingsSnapshot {
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) => f.endsWith(".jsonl") && !f.endsWith(".features.jsonl"),
    );
  } catch {
    return EMPTY;
  }
  if (files.length === 0) return EMPTY;

  const events: BillableEvent[] = [];
  let chainOk = true;
  for (const file of files) {
    const records = readLedgerRecords(join(dir, file));
    if (records === null || records.length === 0) continue;
    if (!verifyLedgerChain(records).ok) {
      chainOk = false;
      continue;
    }
    for (const record of records) events.push(record.event);
  }

  if (events.length === 0) return { ...EMPTY, chainOk };
  return { ...savingsSnapshotFromEvents(events, true), chainOk };
}
