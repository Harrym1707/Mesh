import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { ShadowEvent, ShadowUsage } from "./recorder.js";

/**
 * Offline analyzer for shadow-coalescing event logs (recorder.ts).
 *
 * It reconstructs single-flight semantics from the observed start/end timestamps:
 * the first request to arrive on a key holds a notional latch until its own
 * response completes; every byte-identical request that arrives inside that window
 * is a FOLLOWER that a real coalescer would have served from the one shared
 * response. The leader is unchanged by followers; once it ends, the next arrival
 * opens a fresh latch.
 *
 * Everything here is MODELLED on independently-run requests (shadow mode ran them
 * all), so a follower's "saving" is its own observed usage — the call we would not
 * have made — and its "hold time" is how long it would have waited for the leader's
 * observed latency. Under a real latch, load and latency could differ; the band is
 * therefore an estimate of avoidable calls, not a realised saving. Realised savings
 * only ever come from the ledger once the lever is live.
 */

export type CoalescingParams = {
  /**
   * Max time a follower may wait for the leader before a real latch would give up
   * (client TTFB tolerance). Followers whose modelled hold exceeds this are counted
   * as "over cap" — NOT coalesced — because a tripped client retry is a duplicate
   * full-price call that erases the saving.
   */
  maxHoldMs: number;
  /** Include requests flagged `gated` (non-deterministic). Default false: report the safe band only. */
  includeGated?: boolean;
};

export type CoalescingReport = {
  params: CoalescingParams;
  totalEvents: number;
  recordedRequests: number;
  /** Requests with a usable coalescing key (keyed, not structurally excluded). */
  keyedRequests: number;
  gatedRequests: number;
  ineligibleByReason: Record<string, number>;
  leaders: number;
  /** Followers within the hold cap — the calls a real latch would eliminate. */
  coalescedFollowers: number;
  /** Followers whose modelled hold exceeded maxHoldMs — not counted as a saving. */
  followersOverCap: number;
  /** coalescedFollowers / keyedRequests * 100 — share of keyable traffic a latch removes. */
  callEliminationPercentOfKeyed: number;
  /** coalescedFollowers / recordedRequests * 100 — share of all measured traffic. */
  callEliminationPercentOfAll: number;
  wouldSave: Required<ShadowUsage>;
  /** Modelled hold time (ms) for coalesced followers. */
  holdMs: { p50: number; p90: number; p99: number; max: number };
  /** Per-scope rollup (hashed scope → counts). */
  byScope: Array<{ scopeHash: string; keyed: number; coalesced: number; percent: number }>;
  notes: string[];
};

type RequestRecord = {
  id: number;
  keyHash?: string;
  scopeHash?: string;
  gated?: string;
  ineligible?: string;
  startedAt?: number;
  endedAt?: number;
  usage?: ShadowUsage;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

export function analyzeCoalescing(events: ShadowEvent[], params: CoalescingParams): CoalescingReport {
  const includeGated = params.includeGated ?? false;

  // Pair starts with ends.
  const byId = new Map<number, RequestRecord>();
  for (const event of events) {
    const record = byId.get(event.id) ?? { id: event.id };
    if (event.phase === "start") {
      record.keyHash = event.keyHash;
      record.scopeHash = event.scopeHash;
      record.gated = event.gated;
      record.ineligible = event.ineligible;
      record.startedAt = event.t;
    } else {
      record.endedAt = event.t;
      if (event.usage) record.usage = event.usage;
      if (record.keyHash === undefined && event.keyHash) record.keyHash = event.keyHash;
    }
    byId.set(event.id, record);
  }

  const records = [...byId.values()].filter((r) => r.startedAt !== undefined);
  records.sort((a, b) => a.startedAt! - b.startedAt! || a.id - b.id);

  const ineligibleByReason: Record<string, number> = {};
  let keyedRequests = 0;
  let gatedRequests = 0;
  for (const record of records) {
    if (record.ineligible) ineligibleByReason[record.ineligible] = (ineligibleByReason[record.ineligible] ?? 0) + 1;
    if (record.keyHash) keyedRequests += 1;
    if (record.gated) gatedRequests += 1;
  }

  // Single-flight reconstruction, in arrival order.
  const latchByKey = new Map<string, { endedAt: number }>();
  const holds: number[] = [];
  const wouldSave: Required<ShadowUsage> = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
  const scopeKeyed = new Map<string, number>();
  const scopeCoalesced = new Map<string, number>();
  let leaders = 0;
  let coalescedFollowers = 0;
  let followersOverCap = 0;

  for (const record of records) {
    if (!record.keyHash) continue;
    if (record.gated && !includeGated) continue; // safe band only unless asked
    const scope = record.scopeHash ?? "unknown";
    scopeKeyed.set(scope, (scopeKeyed.get(scope) ?? 0) + 1);

    const started = record.startedAt!;
    const ended = record.endedAt ?? started; // an unfinished request holds no latch
    const latch = latchByKey.get(record.keyHash);
    if (latch && started < latch.endedAt) {
      // Follower: it would attach to the in-flight leader and wait for the leader's response.
      const holdMs = latch.endedAt - started;
      if (holdMs <= params.maxHoldMs) {
        coalescedFollowers += 1;
        holds.push(holdMs);
        scopeCoalesced.set(scope, (scopeCoalesced.get(scope) ?? 0) + 1);
        const u = record.usage ?? {};
        wouldSave.inputTokens += u.inputTokens ?? 0;
        wouldSave.cachedInputTokens += u.cachedInputTokens ?? 0;
        wouldSave.outputTokens += u.outputTokens ?? 0;
        wouldSave.costUsd += u.costUsd ?? 0;
      } else {
        followersOverCap += 1;
      }
      // The leader is unchanged by a follower; do not extend the latch.
    } else {
      // Leader: opens a fresh latch for this key until its own response completes.
      leaders += 1;
      latchByKey.set(record.keyHash, { endedAt: ended });
    }
  }

  holds.sort((a, b) => a - b);
  const recordedRequests = records.length;
  const byScope = [...scopeKeyed.entries()]
    .map(([scopeHash, keyed]) => {
      const coalesced = scopeCoalesced.get(scopeHash) ?? 0;
      return { scopeHash, keyed, coalesced, percent: keyed === 0 ? 0 : (coalesced / keyed) * 100 };
    })
    .sort((a, b) => b.coalesced - a.coalesced);

  const notes: string[] = [
    "Modelled, not realised: followers ran independently in shadow mode; their usage is the call a real latch would avoid.",
    "Hold time assumes the follower waits for the leader's OBSERVED latency; a real latch changes load and may differ.",
    includeGated
      ? "Includes `gated` (non-deterministic) requests — these need explicit caller opt-in before a latch is safe."
      : "Safe band only: `gated` (non-deterministic) requests excluded. Pass --include-gated to see the opt-in band too.",
  ];
  if (keyedRequests === 0) notes.push("No keyable requests found — nothing to coalesce in this log.");

  return {
    params: { maxHoldMs: params.maxHoldMs, includeGated },
    totalEvents: events.length,
    recordedRequests,
    keyedRequests,
    gatedRequests,
    ineligibleByReason,
    leaders,
    coalescedFollowers,
    followersOverCap,
    callEliminationPercentOfKeyed: keyedRequests === 0 ? 0 : (coalescedFollowers / keyedRequests) * 100,
    callEliminationPercentOfAll: recordedRequests === 0 ? 0 : (coalescedFollowers / recordedRequests) * 100,
    wouldSave,
    holdMs: {
      p50: percentile(holds, 50),
      p90: percentile(holds, 90),
      p99: percentile(holds, 99),
      max: holds.length ? holds[holds.length - 1]! : 0,
    },
    byScope,
    notes,
  };
}

/** Parse a JSONL file of ShadowEvent (one JSON object per line). */
export function readEventLog(path: string): ShadowEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ShadowEvent);
}

function formatReport(report: CoalescingReport): string {
  const pct = (n: number) => `${n.toFixed(2)}%`;
  const lines: string[] = [];
  lines.push("# Shadow coalescing report (MODELLED — not a realised or billable saving)");
  lines.push("");
  lines.push(`max hold: ${report.params.maxHoldMs} ms   include-gated: ${report.params.includeGated}`);
  lines.push(`events: ${report.totalEvents}   recorded requests: ${report.recordedRequests}`);
  lines.push(`keyable: ${report.keyedRequests}   gated (non-deterministic): ${report.gatedRequests}`);
  lines.push(`ineligible: ${JSON.stringify(report.ineligibleByReason)}`);
  lines.push("");
  lines.push(`leaders: ${report.leaders}`);
  lines.push(`coalesced followers (within cap): ${report.coalescedFollowers}`);
  lines.push(`followers over hold cap (NOT coalesced): ${report.followersOverCap}`);
  lines.push(`call-elimination: ${pct(report.callEliminationPercentOfKeyed)} of keyable, ` +
    `${pct(report.callEliminationPercentOfAll)} of all recorded`);
  lines.push(`would-avoid usage: ${report.wouldSave.inputTokens} in (${report.wouldSave.cachedInputTokens} cached) / ` +
    `${report.wouldSave.outputTokens} out / $${report.wouldSave.costUsd.toFixed(4)}`);
  lines.push(`modelled hold ms: p50 ${report.holdMs.p50} / p90 ${report.holdMs.p90} / ` +
    `p99 ${report.holdMs.p99} / max ${report.holdMs.max}`);
  lines.push("");
  lines.push("top scopes by coalesced:");
  for (const scope of report.byScope.slice(0, 10)) {
    lines.push(`  ${scope.scopeHash.slice(0, 12)}…  keyable ${scope.keyed}  coalesced ${scope.coalesced}  ${pct(scope.percent)}`);
  }
  lines.push("");
  for (const note of report.notes) lines.push(`note: ${note}`);
  return lines.join("\n");
}

function main(argv: string[]): void {
  const positional: string[] = [];
  let maxHoldMs = 5_000;
  let includeGated = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--max-hold-ms") { maxHoldMs = Number(argv[++i]); continue; }
    if (arg === "--include-gated") { includeGated = true; continue; }
    positional.push(arg);
  }
  const path = positional[0];
  if (!path) {
    console.error("usage: tsx evals/coalescing-shadow/analyze.ts <events.jsonl> [--max-hold-ms N] [--include-gated]");
    process.exitCode = 1;
    return;
  }
  const report = analyzeCoalescing(readEventLog(path), { maxHoldMs, includeGated });
  console.log(formatReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
