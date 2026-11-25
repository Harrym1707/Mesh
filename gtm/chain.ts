// The hash chain of the go-to-market event log.
//
// This is the product's own chain, not a copy of it: the hash, the genesis
// value and the end-to-end verification are imported from
// packages/core/src/savings-ledger.ts (the same construction lab/ledger.ts
// re-implements privately). Those functions are typed to the billing ledger's
// event, though all they do with the event is hash its canonical JSON, so the
// one cast below is the whole adapter. A shared `chain<T>` in core would
// remove it; that is the Product team's to decide.

import { createHash } from "node:crypto";
import {
  LEDGER_GENESIS_HASH,
  ledgerEventHash,
  verifyLedgerChain,
  type BillableEvent,
  type LedgerRecord,
} from "../packages/core/src/savings-ledger.js";
import { canonicalJson } from "../packages/core/src/price-catalogue.js";
import type { GtmEvent, GtmEventRecord } from "./types.js";

export const GENESIS_HASH = LEDGER_GENESIS_HASH;

export function chainEvent(event: GtmEvent, previous?: { seq: number; eventHash: string }): GtmEventRecord {
  const seq = previous ? previous.seq + 1 : 0;
  const prevHash = previous ? previous.eventHash : GENESIS_HASH;
  return { seq, prevHash, eventHash: ledgerEventHash(seq, prevHash, event as unknown as BillableEvent), event };
}

export function verifyChain(records: readonly GtmEventRecord[]): { ok: true; length: number } | { ok: false; seq: number; reason: string } {
  return verifyLedgerChain(records as unknown as readonly LedgerRecord[]);
}

/** sha256 of a value's canonical JSON (sorted keys, no whitespace, undefined dropped). */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export { canonicalJson };
