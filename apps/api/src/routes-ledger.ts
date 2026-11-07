import type { IncomingMessage, ServerResponse } from "node:http";
import type { LedgerRecord } from "../../../packages/core/dist/src/index.js";
import type { ServerContext } from "./context.js";
import { authenticateAccount } from "./account-auth.js";
import { isRecord, readJsonBody, sendJson } from "./http-util.js";

/**
 * Metering ingestion: POST /v1/ledger/events.
 *
 * Authenticated by the Mesh account key (never the provider key). The body is
 * `{ records: LedgerRecord[] }` — the hash-chained billable events the proxy/SDK
 * mirrored from its local spool. The store verifies that the batch continues
 * the account's existing chain and is internally consistent; a broken chain is
 * a hard 409 and NOTHING is stored (the same invariant mesh-bill enforces at
 * invoice time, moved to the moment of ingest).
 *
 * Events carry usage-derived fields only — token counts, lever names, hashes.
 * No prompt content is read, stored, or accepted.
 */

const MAX_RECORDS_PER_BATCH = 2000;

/** Light structural check: a record must be shaped like a LedgerRecord. The
 * store then re-derives and checks the hash chain, which is the real guarantee. */
function looksLikeRecord(value: unknown): value is LedgerRecord {
  if (!isRecord(value)) return false;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 0) return false;
  if (typeof value.prevHash !== "string" || typeof value.eventHash !== "string") return false;
  const event = value.event;
  if (!isRecord(event)) return false;
  return event.schemaVersion === 1 && typeof event.requestId === "string" && event.requestId !== "";
}

export async function handleLedgerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ServerContext,
): Promise<boolean> {
  if (req.method !== "POST" || url.pathname !== "/v1/ledger/events") return false;

  const account = authenticateAccount(req, res, ctx);
  if (!account) return true;

  const body = await readJsonBody(req);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return true;
  }
  const payload = body.value;
  const records = isRecord(payload) ? payload.records : undefined;
  if (!Array.isArray(records)) {
    sendJson(res, 400, { error: "expected_records_array" });
    return true;
  }
  if (records.length > MAX_RECORDS_PER_BATCH) {
    sendJson(res, 413, { error: "too_many_records", max: MAX_RECORDS_PER_BATCH });
    return true;
  }
  if (!records.every(looksLikeRecord)) {
    sendJson(res, 400, { error: "malformed_ledger_record" });
    return true;
  }

  const result = ctx.ledger.append(account.id, records);
  if (!result.ok) {
    // A broken/forked/gapped chain is a hard stop — never partially stored.
    sendJson(res, 409, { error: "ledger_chain_rejected", reason: result.reason, seq: result.seq });
    return true;
  }
  sendJson(res, 202, { accepted: true, stored: result.stored, skipped: result.skipped, tailSeq: result.tailSeq });
  return true;
}
