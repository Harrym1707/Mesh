import { recomputeInvoice, type BillableEvent, type LedgerLeverKind } from "./savings-ledger.js";

/**
 * Group ledger events into working sessions, so the dashboard can show Theo's
 * activity per workflow instead of only in aggregate.
 *
 * MESH's proxy sees a stream of stateless API requests; the LLM APIs carry no
 * task or conversation id, and Claude Code does not send one, so the ledger has
 * no semantic "task" to group by (the `taskId` slot on an event exists for an
 * out-of-band quality signal, and the proxy never fills it). The honest grouping
 * available from the ledger alone is therefore two real dimensions:
 *
 *  - `applicationId` — the `x-mesh-application` header, when a client sets it;
 *  - activity gaps — a run of requests with no long pause between them is one
 *    working session, split when the gap exceeds `gapMinutes`.
 *
 * This is a time-grouped working session, not an inferred semantic task, and the
 * UI labels it as such. Each session's savings come from `recomputeInvoice` over
 * exactly that session's events, so a session total is verified the same way the
 * headline is — never an apportioned estimate.
 */

export type WorkflowSessionLever = {
  leverId: string;
  kind: LedgerLeverKind;
  events: number;
  savedUsd: number;
};

export type WorkflowSession = {
  /** Stable within a ledger: application id + the session's first timestamp. */
  id: string;
  applicationId: string;
  startedAt: string;
  endedAt: string;
  requests: number;
  /** Distinct models seen, in first-seen order. */
  models: string[];
  netVerifiedSavingsUsd: number;
  verdict: "charge" | "do_not_charge";
  /** The Theo levers that fired this session, with their verified saving. */
  levers: WorkflowSessionLever[];
  succeeded: number;
  failed: number;
};

const DEFAULT_GAP_MINUTES = 30;

/**
 * Cluster events into sessions, most recent first. Pure and deterministic: the
 * same events and options always produce the same sessions.
 */
export function groupWorkflowSessions(
  events: readonly BillableEvent[],
  options: { gapMinutes?: number; limit?: number } = {},
): WorkflowSession[] {
  const gapMs = (options.gapMinutes ?? DEFAULT_GAP_MINUTES) * 60_000;

  const byApp = new Map<string, BillableEvent[]>();
  for (const event of events) {
    const app = event.applicationId || "proxy";
    const bucket = byApp.get(app);
    if (bucket === undefined) byApp.set(app, [event]);
    else bucket.push(event);
  }

  const sessions: WorkflowSession[] = [];
  for (const [app, appEvents] of byApp) {
    const sorted = [...appEvents].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);
    let bucket: BillableEvent[] = [];
    let prevTs = Number.NaN;
    const flush = (): void => {
      if (bucket.length > 0) sessions.push(summarise(app, bucket));
      bucket = [];
    };
    for (const event of sorted) {
      const ts = Date.parse(event.timestamp);
      if (bucket.length > 0 && Number.isFinite(ts) && Number.isFinite(prevTs) && ts - prevTs > gapMs) flush();
      bucket.push(event);
      prevTs = ts;
    }
    flush();
  }

  sessions.sort((a, b) => (a.endedAt < b.endedAt ? 1 : a.endedAt > b.endedAt ? -1 : 0));
  return options.limit !== undefined ? sessions.slice(0, options.limit) : sessions;
}

function summarise(applicationId: string, events: BillableEvent[]): WorkflowSession {
  const invoice = recomputeInvoice(events);
  const models: string[] = [];
  for (const event of events) if (!models.includes(event.model)) models.push(event.model);
  const timestamps = events.map((event) => event.timestamp).sort();
  return {
    id: `${applicationId}:${timestamps[0]}`,
    applicationId,
    startedAt: timestamps[0]!,
    endedAt: timestamps[timestamps.length - 1]!,
    requests: events.length,
    models,
    netVerifiedSavingsUsd: invoice.netVerifiedSavingsUsd,
    verdict: invoice.verdict,
    levers: invoice.lineItems.map((item) => ({
      leverId: item.leverId,
      kind: item.kind,
      events: item.events,
      savedUsd: item.savedUsd,
    })),
    succeeded: events.filter((event) => event.status === "succeeded").length,
    failed: events.filter((event) => event.status === "failed").length,
  };
}
