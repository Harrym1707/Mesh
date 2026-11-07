import { createHash } from "node:crypto";
import { canonicalJson } from "../price-catalogue.js";

/**
 * The generic append-only hash chain, extracted from the savings-ledger
 * pattern (`savings-ledger.ts`) so the security log and the rollout history
 * agree, byte for byte, with the way MESH already makes its billing ledger
 * tamper-evident and customer-recomputable.
 *
 * A chain is a list of records, each carrying its position (`seq`), the hash
 * of its predecessor (`prevHash`), and the hash of (position + predecessor +
 * canonical entry). Because every record commits to the one before it, a
 * perturbed field, a reordered record, or a removed record changes a hash and
 * is detectable — and the exact break point is named, never just "the chain is
 * invalid". The genesis record chains onto a fixed all-zero hash.
 *
 * `canonicalJson` gives stable key ordering, so the same entry always hashes
 * to the same digest regardless of how its object was constructed.
 *
 * TAMPER-EVIDENT, NOT TAMPER-PROOF. On its own a hash chain only proves
 * INTERNAL consistency: anyone who can rewrite the whole stored array can
 * recompute every hash and forge a self-consistent chain, and nothing here
 * would detect it. Detection of wholesale rewrites needs an EXTERNAL anchor —
 * a copy of the tip hash the attacker cannot also rewrite. `chain-anchor.ts`
 * provides that anchor by Ed25519-signing the tip (length + tipHash): a
 * verifier who trusts the signing key can then detect truncation or a rewrite
 * the chain alone cannot. Anchor the tip periodically (and/or ship tips to an
 * append-only external store) for a tamper-PROOF guarantee.
 */

export const CHAIN_GENESIS_HASH = "0".repeat(64);

export type ChainRecord<Entry> = {
  seq: number;
  prevHash: string;
  entryHash: string;
  entry: Entry;
};

/** Hash of one chained entry; covers its position, its predecessor and its content. */
export function chainEntryHash(seq: number, prevHash: string, entry: unknown): string {
  return createHash("sha256").update(`${seq}\n${prevHash}\n${canonicalJson(entry)}`).digest("hex");
}

/** Chain one entry onto the previous record (or onto genesis when there is none). */
export function chainRecord<Entry>(entry: Entry, previous?: ChainRecord<Entry>): ChainRecord<Entry> {
  const seq = previous ? previous.seq + 1 : 0;
  const prevHash = previous ? previous.entryHash : CHAIN_GENESIS_HASH;
  return { seq, prevHash, entryHash: chainEntryHash(seq, prevHash, entry), entry };
}

/** Append an entry to an existing chain, returning a NEW array (the input is not mutated). */
export function appendToChain<Entry>(
  records: readonly ChainRecord<Entry>[],
  entry: Entry,
): ChainRecord<Entry>[] {
  const previous = records.length > 0 ? records[records.length - 1] : undefined;
  return [...records, chainRecord(entry, previous)];
}

export type ChainVerification =
  | { ok: true; length: number }
  | { ok: false; seq: number; reason: string };

/**
 * Verify a chain end to end. A perturbed entry field, a reordered record, or a
 * missing record is reported with the exact sequence number where the chain
 * breaks, mirroring `verifyLedgerChain`.
 */
export function verifyChain<Entry>(records: readonly ChainRecord<Entry>[]): ChainVerification {
  let prevHash = CHAIN_GENESIS_HASH;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.seq !== index) {
      return { ok: false, seq: record.seq, reason: `Expected seq ${index}, found ${record.seq}.` };
    }
    if (record.prevHash !== prevHash) {
      return { ok: false, seq: record.seq, reason: "prevHash does not match the preceding record." };
    }
    const expected = chainEntryHash(record.seq, record.prevHash, record.entry);
    if (record.entryHash !== expected) {
      return { ok: false, seq: record.seq, reason: "entryHash does not match the entry content." };
    }
    prevHash = record.entryHash;
  }
  return { ok: true, length: records.length };
}
