import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LEDGER_GENESIS_HASH,
  ledgerEventHash,
  type LedgerRecord,
} from "./savings-ledger.js";

/**
 * Server-side ledger storage with chain-verification-on-ingest.
 *
 * The proxy/SDK mirrors each hash-chained record it writes locally to the Mesh
 * API; this is where the API stores it, per account, in an append-only JSONL
 * spool. The one rule that makes "recompute it yourself" a guarantee rather
 * than a promise: a record is stored ONLY if it is self-consistent AND
 * continues the account's existing chain. A perturbed, forked, or gapped batch
 * is a hard reject — it is never partially stored and never silently repaired.
 *
 * The mirror is fire-and-forget with retry, so the same records arrive more
 * than once. Ingestion is therefore idempotent: records at or below the stored
 * tail are recognised as replays and skipped (with a fork check against the
 * tail), and only the genuine continuation is appended.
 */

/** The last stored record's position, all the store needs to extend the chain. */
export type LedgerTail = { seq: number; eventHash: string };

export type IngestVerification =
  | {
      ok: true;
      /** Records beyond the current tail that should be appended, in order. */
      newRecords: LedgerRecord[];
      /** Leading records recognised as already-stored replays. */
      skipped: number;
      /** The tail after appending newRecords. */
      tail: LedgerTail;
    }
  | { ok: false; reason: string; seq: number };

function selfConsistent(record: LedgerRecord): boolean {
  return (
    typeof record.seq === "number" &&
    typeof record.prevHash === "string" &&
    typeof record.eventHash === "string" &&
    record.eventHash === ledgerEventHash(record.seq, record.prevHash, record.event)
  );
}

/**
 * Verify that `records` form a valid continuation of `tail` (undefined = empty
 * chain, starting at genesis). Pure: no I/O, so the whole accept/replay/reject
 * decision is unit-testable. Allows a leading overlap of already-stored
 * sequences (idempotent retries) and rejects any gap, fork, or tampered hash.
 */
export function verifyIngestBatch(tail: LedgerTail | undefined, records: readonly LedgerRecord[]): IngestVerification {
  const currentTail: LedgerTail = tail ?? { seq: -1, eventHash: LEDGER_GENESIS_HASH };
  if (records.length === 0) {
    return { ok: true, newRecords: [], skipped: 0, tail: currentTail.seq < 0 ? { seq: -1, eventHash: LEDGER_GENESIS_HASH } : currentTail };
  }

  // 1. Each record hashes its own position + predecessor + content.
  for (const record of records) {
    if (!selfConsistent(record)) {
      return { ok: false, reason: "eventHash does not match the record's seq, prevHash and event.", seq: record.seq };
    }
  }
  // 2. The batch is internally contiguous and linked.
  for (let i = 1; i < records.length; i += 1) {
    const prev = records[i - 1]!;
    const here = records[i]!;
    if (here.seq !== prev.seq + 1) {
      return { ok: false, reason: `Non-contiguous seq ${prev.seq} -> ${here.seq} within the batch.`, seq: here.seq };
    }
    if (here.prevHash !== prev.eventHash) {
      return { ok: false, reason: "prevHash does not match the preceding record in the batch.", seq: here.seq };
    }
  }

  const expectedNextSeq = currentTail.seq + 1;
  const first = records[0]!;
  const last = records[records.length - 1]!;

  // Entirely at or below the tail: a pure replay. Verify the overlap does not
  // fork the stored chain at the tail, then skip all of it.
  if (last.seq < expectedNextSeq) {
    const atTail = records.find((record) => record.seq === currentTail.seq);
    if (atTail && atTail.eventHash !== currentTail.eventHash) {
      return { ok: false, reason: "Replayed record at the tail forks the stored chain.", seq: atTail.seq };
    }
    return { ok: true, newRecords: [], skipped: records.length, tail: currentTail };
  }

  // A continuation must include the record at expectedNextSeq, and it must link
  // to the stored tail. Anything starting beyond it is a gap.
  if (first.seq > expectedNextSeq) {
    return { ok: false, reason: `Gap: expected seq ${expectedNextSeq}, batch starts at ${first.seq}.`, seq: first.seq };
  }

  const continuationIndex = records.findIndex((record) => record.seq === expectedNextSeq);
  const continuation = records[continuationIndex]!;
  const expectedPrevHash = currentTail.seq < 0 ? LEDGER_GENESIS_HASH : currentTail.eventHash;
  if (continuation.prevHash !== expectedPrevHash) {
    return { ok: false, reason: "Continuation record does not link to the stored tail.", seq: continuation.seq };
  }

  // Fork check on any overlapping record at exactly the tail seq.
  const atTail = records.find((record) => record.seq === currentTail.seq);
  if (atTail && atTail.eventHash !== currentTail.eventHash) {
    return { ok: false, reason: "Replayed record at the tail forks the stored chain.", seq: atTail.seq };
  }

  const newRecords = records.slice(continuationIndex);
  return { ok: true, newRecords, skipped: continuationIndex, tail: { seq: last.seq, eventHash: last.eventHash } };
}

export type LedgerIngestResult =
  | { ok: true; stored: number; skipped: number; tailSeq: number }
  | { ok: false; reason: string; seq: number };

export interface LedgerStore {
  append(accountId: string, records: readonly LedgerRecord[]): LedgerIngestResult;
  readRecords(accountId: string): LedgerRecord[];
  tail(accountId: string): LedgerTail | undefined;
}

function sanitizeAccountId(accountId: string): string {
  const safe = accountId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  if (safe === "" || safe === "." || safe === "..") throw new Error("Invalid account id for ledger storage.");
  return safe;
}

/**
 * File-backed ledger store: one append-only JSONL spool per account under
 * `<dir>/<accountId>.jsonl`. Tails are cached in memory and lazily resumed from
 * the spool, so a server restart picks the chain up where it left off.
 */
export function openFileLedgerStore(dir: string): LedgerStore {
  const tails = new Map<string, LedgerTail>();
  const loaded = new Set<string>();

  const pathFor = (accountId: string): string => join(dir, `${sanitizeAccountId(accountId)}.jsonl`);

  const loadTail = (accountId: string): LedgerTail | undefined => {
    if (loaded.has(accountId)) return tails.get(accountId);
    loaded.add(accountId);
    const path = pathFor(accountId);
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
      if (lines.length > 0) {
        const tail = JSON.parse(lines[lines.length - 1]!) as LedgerRecord;
        tails.set(accountId, { seq: tail.seq, eventHash: tail.eventHash });
      }
    }
    return tails.get(accountId);
  };

  return {
    tail(accountId) {
      return loadTail(accountId);
    },
    readRecords(accountId) {
      const path = pathFor(accountId);
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as LedgerRecord);
    },
    append(accountId, records) {
      const verification = verifyIngestBatch(loadTail(accountId), records);
      if (!verification.ok) return verification;
      if (verification.newRecords.length > 0) {
        const path = pathFor(accountId);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const body = verification.newRecords.map((record) => JSON.stringify(record)).join("\n");
        appendFileSync(path, `${body}\n`, { encoding: "utf8", mode: 0o600 });
        tails.set(accountId, verification.tail);
      }
      return {
        ok: true,
        stored: verification.newRecords.length,
        skipped: verification.skipped,
        tailSeq: verification.tail.seq,
      };
    },
  };
}
