import type { LedgerRecord } from "../../core/dist/src/savings-ledger.js";
import type { MeshLedgerMirrorConfig } from "./types.js";

/**
 * The client half of ledger mirroring: ship each locally-appended, hash-chained
 * record to the Mesh metering API, without ever touching the request path.
 *
 * Contract (mirrors the existing fire-and-forget telemetry/ledger writes):
 * - `enqueue` returns immediately; the network happens on a detached flush.
 * - Records beyond the server's confirmed tail are buffered and re-sent as one
 *   contiguous batch, so a dropped or out-of-order push self-heals on the next
 *   append rather than leaving a permanent gap at the server.
 * - The local spool is authoritative; the mirror is best-effort. On persistent
 *   failure or an overfull buffer it goes quiet — it never throws, never blocks,
 *   and never corrupts the local chain.
 */
export class LedgerMirror {
  private readonly endpoint: string;
  private readonly accountKey: string;
  private readonly doFetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly maxPending: number;

  /** Records with seq > confirmedTailSeq, awaiting confirmation. */
  private pending: LedgerRecord[] = [];
  private confirmedTailSeq = -1;
  private disabled = false;
  /** A flush is requested again if records arrive while one is in flight. */
  private dirty = false;
  /** The in-flight flush, so callers (and tests) can await completion. */
  private current?: Promise<void>;

  constructor(config: MeshLedgerMirrorConfig) {
    this.endpoint = `${config.apiUrl.replace(/\/$/, "")}/v1/ledger/events`;
    this.accountKey = config.accountKey;
    this.doFetch = config.fetch ?? fetch;
    this.maxRetries = config.maxRetries ?? 3;
    this.maxPending = config.maxPending ?? 5000;
  }

  /** Buffer a record and schedule a flush. Never blocks or throws. */
  enqueue(record: LedgerRecord): void {
    if (this.disabled) return;
    if (record.seq <= this.confirmedTailSeq) return; // already confirmed stored
    this.pending.push(record);
    if (this.pending.length > this.maxPending) {
      // The local spool still holds everything; a bulk re-sync can replay it
      // later. Stop here rather than grow without bound or drop into a gap.
      this.disabled = true;
      this.pending = [];
      return;
    }
    void this.flush();
  }

  /** Flush the pending buffer to the API, retrying a few times. Awaitable. */
  flush(): Promise<void> {
    if (this.disabled) return Promise.resolve();
    if (this.current) {
      // A flush is already running; ask it to re-check after it finishes.
      this.dirty = true;
      return this.current;
    }
    this.current = this.run().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  private async run(): Promise<void> {
    do {
      this.dirty = false;
      const batch = this.pending.filter((record) => record.seq > this.confirmedTailSeq);
      if (batch.length === 0) break;
      const confirmed = await this.send(batch);
      if (confirmed === undefined) break; // give up this round; next enqueue retries
      this.confirmedTailSeq = Math.max(this.confirmedTailSeq, confirmed);
      this.pending = this.pending.filter((record) => record.seq > this.confirmedTailSeq);
    } while (this.dirty || this.pending.length > 0);
  }

  /** POST one batch; returns the server's tailSeq on success, or undefined. */
  private async send(batch: LedgerRecord[]): Promise<number | undefined> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const res = await this.doFetch(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.accountKey}` },
          body: JSON.stringify({ records: batch }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const json = (await res.json().catch(() => ({}))) as { tailSeq?: number };
          return typeof json.tailSeq === "number" ? json.tailSeq : batch[batch.length - 1]!.seq;
        }
        // 4xx other than 429 is a client/auth error that retrying won't fix.
        if (res.status !== 429 && res.status < 500) {
          if (res.status === 401 || res.status === 403) this.disabled = true;
          return undefined;
        }
      } catch {
        // Network error — fall through to backoff/retry.
      }
      if (attempt < this.maxRetries) await delay(250 * 2 ** attempt);
    }
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
