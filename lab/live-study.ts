// What the LIVE run still leaves on the table.
//
// The hash-chained spools in evals/live-exports-2026-10-26/ are real provider
// usage (the run behind the LIVE number in docs/NUMBERS.md). They are
// content-blind — token counts, lever ids, dollars — which is all this study
// reads. Three questions:
//
//   liveResidual()  Where does the bill still sit AFTER Mesh? (LIVE)
//   guardStudy()    The coding agent's cache stamp was suppressed on turns 3–5.
//                   Why, and what did it cost?
//   stampStudy()    The support chat shipped the same tools + system prompt on
//                   every request and was never stamped. What would stamping
//                   have saved?
//
// Basis labels used here:
//   LIVE               verbatim provider usage from the spools
//   DERIVED-FROM-LIVE  arithmetic on that usage with the documented cache
//                      multipliers (write 1.25x, read 0.1x) — a counterfactual,
//                      NOT a re-run against the provider
//   SIMULATOR          replicas of the live request shapes (lab/live-shapes.ts)
//                      priced by the span model below

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CachePrefixVolatilityGuard } from "../packages/sdk-js/src/cache-volatility-guard.js";
import { reduceRequest, type MeshTokenReductionConfig } from "../packages/sdk-js/src/reduce-request.js";
import { approximateTokenCount } from "../packages/core/src/token-reduction.js";
import { LegacyVolatilityGuard } from "./experiments/legacy-guard.js";
import { SpanKeyedStamper, stampedSystemSpan } from "./experiments/span-keyed-stamp.js";
import {
  LIVE_CODING_CONFIG,
  LIVE_SUPPORT_CONFIG,
  liveCodingAgentRequests,
  liveSupportChatRequests,
} from "./live-shapes.js";

type AnyObject = Record<string, unknown>;

const WRITE_MULTIPLIER = 1.25;
const READ_MULTIPLIER = 0.1;

const LIVE_DIR = fileURLToPath(new URL("../evals/live-exports-2026-10-26/", import.meta.url));

type LiveEvent = {
  applicationId: string;
  actualUsd: number;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number };
  levers: { leverId: string; savedUsd?: number }[];
};

export function liveSpoolsAvailable(): boolean {
  return existsSync(`${LIVE_DIR}anthropic-coding-agent.jsonl`);
}

function readSpool(agent: string): LiveEvent[] {
  const path = `${LIVE_DIR}anthropic-${agent}.jsonl`;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { event: LiveEvent }).event);
}

/**
 * Per-token input and output rates, solved from the spools themselves (two
 * events with no cache activity give two equations), so no price is hard-coded.
 */
function ratesFrom(events: LiveEvent[]): { input: number; output: number } | undefined {
  const plain = events.filter((e) => e.usage.cachedInputTokens === 0 && e.usage.cacheWriteInputTokens === 0);
  for (let i = 0; i < plain.length; i += 1) {
    for (let j = i + 1; j < plain.length; j += 1) {
      const a = plain[i]!;
      const b = plain[j]!;
      const det = a.usage.inputTokens * b.usage.outputTokens - b.usage.inputTokens * a.usage.outputTokens;
      if (Math.abs(det) < 1e-9) continue;
      const input = (a.actualUsd * b.usage.outputTokens - b.actualUsd * a.usage.outputTokens) / det;
      const output = (a.usage.inputTokens * b.actualUsd - b.usage.inputTokens * a.actualUsd) / det;
      if (input > 0 && output > 0) return { input, output };
    }
  }
  return undefined;
}

export const LIVE_AGENTS = ["coding-agent", "support-chat", "rag-docqa", "batch-classifier", "already-lean"];

const liveRates = () => ratesFrom(LIVE_AGENTS.flatMap(readSpool));

// ---------------------------------------------------------------------------
// 1. Where the LIVE bill still sits
// ---------------------------------------------------------------------------

export type ResidualRow = {
  agent: string;
  requests: number;
  actualUsd: number;
  /** Shares of the post-Mesh bill, 0–1. */
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

/** Composition of the post-Mesh bill per live agent. Basis: LIVE. */
export function liveResidual(): { rows: ResidualRow[]; total: ResidualRow } | undefined {
  const rates = liveRates();
  if (!rates) return undefined;
  const rows: ResidualRow[] = [];
  const sum = { fresh: 0, read: 0, write: 0, out: 0, actual: 0, requests: 0 };
  for (const agent of LIVE_AGENTS) {
    const events = readSpool(agent);
    if (events.length === 0) continue;
    let fresh = 0;
    let read = 0;
    let write = 0;
    let out = 0;
    let actual = 0;
    for (const e of events) {
      const u = e.usage;
      fresh += (u.inputTokens - u.cachedInputTokens - u.cacheWriteInputTokens) * rates.input;
      read += u.cachedInputTokens * rates.input * READ_MULTIPLIER;
      write += u.cacheWriteInputTokens * rates.input * WRITE_MULTIPLIER;
      out += u.outputTokens * rates.output;
      actual += e.actualUsd;
    }
    const total = fresh + read + write + out;
    rows.push({
      agent,
      requests: events.length,
      actualUsd: actual,
      freshInput: fresh / total,
      cacheRead: read / total,
      cacheWrite: write / total,
      output: out / total,
    });
    sum.fresh += fresh;
    sum.read += read;
    sum.write += write;
    sum.out += out;
    sum.actual += actual;
    sum.requests += events.length;
  }
  const all = sum.fresh + sum.read + sum.write + sum.out;
  return {
    rows,
    total: {
      agent: "ALL",
      requests: sum.requests,
      actualUsd: sum.actual,
      freshInput: sum.fresh / all,
      cacheRead: sum.read / all,
      cacheWrite: sum.write / all,
      output: sum.out / all,
    },
  };
}

// ---------------------------------------------------------------------------
// Span pricing for the replicas (input side, in token-equivalents)
// ---------------------------------------------------------------------------

const withoutCacheControl = (value: unknown): string =>
  JSON.stringify(value ?? null, (key, inner) => (key === "cache_control" ? undefined : inner));

const carriesStamp = (value: unknown): boolean => JSON.stringify(value ?? null).includes('"cache_control"');

/**
 * The prompt in provider order (tools → system → messages) and the prefixes a
 * breakpoint covers. With a volatile tail the reducer stamps only the stable
 * system span, so the tail sits between it and the history and the history
 * prefix can never match — which is exactly what the live run shows.
 */
function promptSpans(request: AnyObject): { content: string; spans: string[] } {
  const tools = withoutCacheControl(request.tools ?? []);
  const system = request.system;
  let stable = "";
  let rest = "";
  if (Array.isArray(system) && carriesStamp(system)) {
    const span = stampedSystemSpan(system) as unknown[];
    stable = withoutCacheControl(span);
    rest = system.length > span.length ? withoutCacheControl(system.slice(span.length)) : "";
  } else {
    rest = typeof system === "string" ? system : withoutCacheControl(system);
  }
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const history = messages.map(withoutCacheControl).join("\n");
  const content = `${tools}\n${stable}\n${rest}\n${history}`;
  const spans: string[] = [];
  if (stable !== "") spans.push(`${tools}\n${stable}`);
  if (messages.length > 0 && carriesStamp(messages.at(-1))) spans.push(content);
  return { content, spans };
}

export type PricedSession = {
  /** Input cost in token-equivalents (fresh 1.0x, write 1.25x, read 0.1x). */
  cost: number;
  uncachedCost: number;
  perRequest: { stamped: boolean; read: number; write: number; fresh: number }[];
};

/** Price a sequence of (reduced) Anthropic-shaped requests sent seconds apart. */
export function priceSession(requests: AnyObject[]): PricedSession {
  const written: string[] = [];
  let cost = 0;
  let uncachedCost = 0;
  const perRequest: PricedSession["perRequest"] = [];
  for (const request of requests) {
    const { content, spans } = promptSpans(request);
    const total = approximateTokenCount(content);
    uncachedCost += total;
    // A request with no breakpoint neither reads nor writes.
    let readChars = 0;
    if (spans.length > 0) {
      for (const prior of written) {
        if (content.startsWith(prior)) readChars = Math.max(readChars, prior.length);
      }
    }
    const lastSpanChars = spans.length > 0 ? spans.at(-1)!.length : 0;
    const read = approximateTokenCount(content.slice(0, readChars));
    const write = lastSpanChars > readChars ? approximateTokenCount(content.slice(readChars, lastSpanChars)) : 0;
    const fresh = Math.max(0, total - read - write);
    cost += read * READ_MULTIPLIER + write * WRITE_MULTIPLIER + fresh;
    perRequest.push({ stamped: spans.length > 0, read, write, fresh });
    for (const span of spans) if (!written.includes(span)) written.push(span);
  }
  return { cost, uncachedCost, perRequest };
}

/** The guard as it shipped for the live run: raw hash, all-or-nothing. */
function throughLegacyGuard(requests: AnyObject[], config: MeshTokenReductionConfig): AnyObject[] {
  const guard = new LegacyVolatilityGuard();
  return requests.map(
    (request) => reduceRequest(request, { ...config, cacheVolatilityGuard: guard }).request as AnyObject,
  );
}

/** The guard in the product today: span-compared, one decision per breakpoint. */
function throughProductGuard(requests: AnyObject[], config: MeshTokenReductionConfig): AnyObject[] {
  const guard = new CachePrefixVolatilityGuard();
  return requests.map(
    (request) => reduceRequest(request, { ...config, cacheVolatilityGuard: guard }).request as AnyObject,
  );
}

function throughSpanStamper(
  requests: AnyObject[],
  config: MeshTokenReductionConfig,
  stampOnFirstSight: boolean,
): AnyObject[] {
  const stamper = new SpanKeyedStamper(config, { stampOnFirstSight });
  return requests.map((request) => stamper.reduce(request).request);
}

const saving = (from: number, to: number) => ((from - to) / from) * 100;

// ---------------------------------------------------------------------------
// 2. A stable prefix the guard refuses to stamp (the live coding agent)
// ---------------------------------------------------------------------------

export type GuardStudy = {
  /** SIMULATOR: system breakpoint placed per turn on the live coding-agent replica. */
  /** Under the guard as shipped for the live run (reproduces the spool). */
  legacyStamps: boolean[];
  /** Under the guard in the product now. */
  productStamps: boolean[];
  spanOnRepeatStamps: boolean[];
  spanFirstSightStamps: boolean[];
  /** SIMULATOR: input cost, token-equivalents. */
  legacyCost: number;
  productCost: number;
  spanOnRepeatCost: number;
  spanFirstSightCost: number;
  /** SIMULATOR: input saving of each arm against the legacy guard. */
  productInputSavingPercent: number;
  onRepeatInputSavingPercent: number;
  firstSightInputSavingPercent: number;
  live?: {
    /** LIVE: stamped / suppressed per turn, straight from the spool's lever ids. */
    stampPattern: ("stamped" | "suppressed" | "none")[];
    /** LIVE: the prefix the provider read back on the one turn that was allowed to. */
    provenCachedTokens: number;
    suppressedTurns: number;
    actualUsd: number;
    /** DERIVED-FROM-LIVE: stamp once the span has repeated (turn 1 fresh, turn 2 writes, rest read). */
    onRepeatUsd: number;
    onRepeatPercentOfBill: number;
    /** DERIVED-FROM-LIVE: stamp at first sight on a remembered route (turn 1 writes, rest read). */
    firstSightUsd: number;
    firstSightPercentOfBill: number;
  };
};

export function guardStudy(): GuardStudy {
  const raw = liveCodingAgentRequests();
  const legacy = priceSession(throughLegacyGuard(raw, LIVE_CODING_CONFIG));
  const product = priceSession(throughProductGuard(raw, LIVE_CODING_CONFIG));
  const onRepeat = priceSession(throughSpanStamper(raw, LIVE_CODING_CONFIG, false));
  const firstSight = priceSession(throughSpanStamper(raw, LIVE_CODING_CONFIG, true));

  const study: GuardStudy = {
    legacyStamps: legacy.perRequest.map((r) => r.stamped),
    productStamps: product.perRequest.map((r) => r.stamped),
    spanOnRepeatStamps: onRepeat.perRequest.map((r) => r.stamped),
    spanFirstSightStamps: firstSight.perRequest.map((r) => r.stamped),
    legacyCost: legacy.cost,
    productCost: product.cost,
    spanOnRepeatCost: onRepeat.cost,
    spanFirstSightCost: firstSight.cost,
    productInputSavingPercent: saving(legacy.cost, product.cost),
    onRepeatInputSavingPercent: saving(legacy.cost, onRepeat.cost),
    firstSightInputSavingPercent: saving(legacy.cost, firstSight.cost),
  };

  const events = readSpool("coding-agent");
  const rates = liveRates();
  if (events.length > 0 && rates) {
    const stampPattern = events.map((e) =>
      e.levers.some((l) => l.leverId === "cache-ttl-suppressed")
        ? ("suppressed" as const)
        : e.levers.some((l) => l.leverId.startsWith("cache-ttl-"))
          ? ("stamped" as const)
          : ("none" as const),
    );
    const prefix = Math.max(...events.map((e) => e.usage.cachedInputTokens));
    const actualUsd = events.reduce((sum, e) => sum + e.actualUsd, 0);
    // What the stable prefix was ACTUALLY billed at, turn by turn, from verbatim usage.
    const actualMultiple = events.reduce(
      (sum, e) =>
        sum + (e.usage.cacheWriteInputTokens > 0 ? WRITE_MULTIPLIER : e.usage.cachedInputTokens > 0 ? READ_MULTIPLIER : 1),
      0,
    );
    const n = events.length;
    const onRepeatMultiple = 1 + WRITE_MULTIPLIER + (n - 2) * READ_MULTIPLIER;
    const firstSightMultiple = WRITE_MULTIPLIER + (n - 1) * READ_MULTIPLIER;
    const onRepeatUsd = (actualMultiple - onRepeatMultiple) * prefix * rates.input;
    const firstSightUsd = (actualMultiple - firstSightMultiple) * prefix * rates.input;
    study.live = {
      stampPattern,
      provenCachedTokens: prefix,
      suppressedTurns: stampPattern.filter((p) => p === "suppressed").length,
      actualUsd,
      onRepeatUsd,
      onRepeatPercentOfBill: (onRepeatUsd / actualUsd) * 100,
      firstSightUsd,
      firstSightPercentOfBill: (firstSightUsd / actualUsd) * 100,
    };
  }
  return study;
}

// ---------------------------------------------------------------------------
// 3. A reusable prefix that was never stamped (the live support chat)
// ---------------------------------------------------------------------------

export type StampStudy = {
  requests: number;
  /** SIMULATOR: share of each request that is the shared tools + system prefix. */
  prefixShare: number;
  /** SIMULATOR: input cost, token-equivalents. */
  unstampedCost: number;
  spanOnRepeatCost: number;
  spanFirstSightCost: number;
  onRepeatInputSavingPercent: number;
  firstSightInputSavingPercent: number;
  live?: {
    actualUsd: number;
    inputTokensPerRequest: number;
    /** The shared prefix size used: the span the provider cached in the coding run, when available. */
    prefixTokens: number;
    /** DERIVED-FROM-LIVE: reading that prefix instead of paying full price for it. */
    onRepeatUsd: number;
    onRepeatPercentOfBill: number;
    firstSightUsd: number;
    firstSightPercentOfBill: number;
  };
};

export function stampStudy(): StampStudy {
  const raw = liveSupportChatRequests();
  // The live support chat ran with no stamp at all: cacheTtl is a per-workload
  // caller flag in the product and this workload did not carry it.
  const unstampedRequests = raw.map((request) => reduceRequest(request, LIVE_SUPPORT_CONFIG).request as AnyObject);
  const stampable: MeshTokenReductionConfig = { ...LIVE_SUPPORT_CONFIG, cacheTtl: "5m" };

  const unstamped = priceSession(unstampedRequests);
  const firstSightRequests = throughSpanStamper(raw, stampable, true);
  const onRepeat = priceSession(throughSpanStamper(raw, stampable, false));
  const firstSight = priceSession(firstSightRequests);

  const spans = promptSpans(firstSightRequests[0]!);
  const prefixShare =
    spans.spans.length > 0 ? approximateTokenCount(spans.spans[0]!) / approximateTokenCount(spans.content) : 0;

  const study: StampStudy = {
    requests: raw.length,
    prefixShare,
    unstampedCost: unstamped.cost,
    spanOnRepeatCost: onRepeat.cost,
    spanFirstSightCost: firstSight.cost,
    onRepeatInputSavingPercent: saving(unstamped.cost, onRepeat.cost),
    firstSightInputSavingPercent: saving(unstamped.cost, firstSight.cost),
  };

  const events = readSpool("support-chat");
  const rates = liveRates();
  if (events.length > 0 && rates && prefixShare > 0) {
    const actualUsd = events.reduce((sum, e) => sum + e.actualUsd, 0);
    const input = events[0]!.usage.inputTokens;
    // The support chat ships the SAME tools + system prompt as the coding agent,
    // and the provider demonstrably cached that span in the coding run. Prefer
    // that LIVE-proven size over the replica's estimated share.
    const proven = Math.max(0, ...readSpool("coding-agent").map((e) => e.usage.cachedInputTokens));
    const prefix = proven > 0 ? Math.min(proven, input) : input * prefixShare;
    const n = events.length;
    // Actual: every request billed fresh (multiple n). Counterfactuals as in the guard study.
    const onRepeatUsd = (n - (1 + WRITE_MULTIPLIER + (n - 2) * READ_MULTIPLIER)) * prefix * rates.input;
    const firstSightUsd = (n - (WRITE_MULTIPLIER + (n - 1) * READ_MULTIPLIER)) * prefix * rates.input;
    study.live = {
      actualUsd,
      inputTokensPerRequest: input,
      prefixTokens: prefix,
      onRepeatUsd,
      onRepeatPercentOfBill: (onRepeatUsd / actualUsd) * 100,
      firstSightUsd,
      firstSightPercentOfBill: (firstSightUsd / actualUsd) * 100,
    };
  }
  return study;
}
