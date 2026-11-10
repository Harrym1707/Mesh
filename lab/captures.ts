// Qualification on REAL wire captures.
//
// The lab's fixtures are constructed: they carry the redundancy a lever needs,
// so their savings are an UPPER BOUND, not a measurement of real traffic. This
// module is the counterweight. It replays the Mesh-owned framework wire captures
// (evals/wire-captures/*.jsonl — real LangChain / OpenAI SDK / Agents SDK /
// LiteLLM request bodies, fake keys, no customer content) through the product's
// OWN machinery:
//
//   reduceRequest  (packages/sdk-js)  — the real reducer the proxy runs
//   simulateCache  (packages/core)    — the real cache model: write premiums,
//                                        TTL expiry, per-provider minimums
//
// and reports what Mesh actually removes from each session's input bill, net of
// what the customer's traffic already gets:
//   - Anthropic without stamps  -> counterfactual is uncached (caching is opt-in)
//   - Anthropic already stamped -> counterfactual is the customer's own caching
//   - OpenAI                    -> counterfactual is AUTOMATIC caching
// Never bill a saving the customer already has (docs/rnd/rnd-doctrine.md).
//
// Arms:
//   text        lossless text reduction only (tool-schema + duplicate context)
//   stamp       + cache stamp at 5m TTL        (lossless: metadata only)
//   stampRepair + cache-prefix repair          (GATE-REQUIRED: it reorders lines
//                                               the model reads — lever-backlog P3)
//
// Captures carry no usable inter-arrival timing, so turn spacing is a labelled
// ESTIMATE (default 30s, the "busy multi-turn" spacing evals/ uses).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  OPENAI_CACHE,
  simulateCache,
  type CachePolicy,
  type SimulatedRequest,
} from "../packages/core/src/cache-simulator.js";
import type { TokenPrice } from "../packages/core/src/cost.js";
import { reduceRequest, type MeshTokenReductionConfig } from "../packages/sdk-js/src/reduce-request.js";
import { CachePrefixVolatilityGuard } from "../packages/sdk-js/src/cache-volatility-guard.js";
import { repairBlockArraySystem } from "./experiments/block-array-repair.js";

type AnyObject = Record<string, unknown>;

type CaptureRow = { path: string; headers: Record<string, string>; body: AnyObject };

export type CaptureArm = "text" | "stamp" | "stampRepair" | "blockRepair";

export const CAPTURE_ARMS: CaptureArm[] = ["text", "stamp", "stampRepair", "blockRepair"];

/**
 * Arms that change the order of what the model reads. Their COST effect is
 * measured here; their quality effect is not, so they are never part of the
 * lossless floor and can never be promoted from this harness.
 */
export const GATE_REQUIRED_ARMS: CaptureArm[] = ["stampRepair", "blockRepair"];

export type SessionQualification = {
  capture: string;
  client: string;
  path: string;
  turns: number;
  /** Largest request in the session, in estimated tokens. */
  maxRequestTokens: number;
  baselinePolicy: string;
  baselineCostUsd: number;
  arms: Record<CaptureArm, { costUsd: number; savingPercent: number; policy: string }>;
};

export type CaptureQualification = {
  sessions: SessionQualification[];
  /** Cost-weighted across every session. */
  totals: Record<CaptureArm, { savingPercent: number }>;
  spacingSeconds: number;
  basis: "derived-from-captures";
  notes: string[];
};

const CAPTURE_DIR = fileURLToPath(new URL("../evals/wire-captures/", import.meta.url));
export const CAPTURE_FILES = ["frameworks-2026-10-25.jsonl", "litellm-volatility-2026-10-25.jsonl"];

// Only ratios matter for a percentage; this is an illustrative input price.
const PRICE: TokenPrice = { inputPerMillion: 3, outputPerMillion: 15 };

const ARM_CONFIG: Record<CaptureArm, MeshTokenReductionConfig> = {
  text: { toolSchemas: true, duplicateContext: true },
  stamp: { toolSchemas: true, duplicateContext: true, cacheTtl: "5m" },
  stampRepair: { toolSchemas: true, duplicateContext: true, cacheTtl: "5m", repairCachePrefix: true },
  // EXPERIMENT: lab-local block-array repair first, then the product's stamp + string repair.
  blockRepair: { toolSchemas: true, duplicateContext: true, cacheTtl: "5m", repairCachePrefix: true },
};

/** Canonical wire serialisation (same shape as evals/agent-fixture.ts wirePrompt). */
function wirePrompt(request: AnyObject): string {
  const system = request.system ?? request.instructions ?? "";
  const systemText = typeof system === "string" ? system : JSON.stringify(system);
  return `${systemText}\n${JSON.stringify(request.tools ?? [])}\n` +
    JSON.stringify(request.input ?? request.messages ?? []);
}

function clientOf(row: CaptureRow): string {
  return String(row.headers["user-agent"] ?? row.headers["User-Agent"] ?? "unknown");
}

function turnLength(body: AnyObject): number {
  const turns = body.messages ?? body.input;
  return Array.isArray(turns) ? turns.length : 0;
}

/** A new conversation starts when the client changes or the history stops growing. */
function splitSessions(rows: CaptureRow[]): CaptureRow[][] {
  const sessions: CaptureRow[][] = [];
  let current: CaptureRow[] = [];
  for (const row of rows) {
    const previous = current.at(-1);
    const continues =
      previous !== undefined &&
      clientOf(previous) === clientOf(row) &&
      previous.path === row.path &&
      turnLength(row.body) > turnLength(previous.body);
    if (!continues && current.length > 0) {
      sessions.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}

function isAnthropic(path: string): boolean {
  return path.includes("/messages");
}

function carriesCacheControl(body: AnyObject): boolean {
  return JSON.stringify(body).includes('"cache_control"');
}

function sessionCost(bodies: AnyObject[], policy: CachePolicy, spacingSeconds: number): number {
  const requests: SimulatedRequest[] = bodies.map((body, index) => ({
    atSeconds: index * spacingSeconds,
    prompt: wirePrompt(body),
    outputTokens: 0, // input side only
  }));
  return simulateCache(requests, policy, PRICE).totalCostUsd;
}

function qualifySession(capture: string, rows: CaptureRow[], spacingSeconds: number): SessionQualification {
  const path = rows[0]!.path;
  const anthropic = isAnthropic(path);
  const rawBodies = rows.map((r) => r.body);

  // The customer's own counterfactual.
  const customerStamped = anthropic && rawBodies.every(carriesCacheControl);
  const baselinePolicy = anthropic ? (customerStamped ? ANTHROPIC_CACHE_5M : ANTHROPIC_NO_CACHE) : OPENAI_CACHE;
  const baselineCostUsd = sessionCost(rawBodies, baselinePolicy, spacingSeconds);

  const arms = {} as SessionQualification["arms"];
  for (const arm of CAPTURE_ARMS) {
    const config = ARM_CONFIG[arm];
    // The proxy installs the volatility guard whenever cacheTtl is set; do the same.
    const guard = config.cacheTtl ? new CachePrefixVolatilityGuard() : undefined;
    const source =
      arm === "blockRepair" ? rawBodies.map((body) => repairBlockArraySystem(body).request) : rawBodies;
    const reduced = source.map(
      (body) => reduceRequest(body, guard ? { ...config, cacheVolatilityGuard: guard } : config).request as AnyObject,
    );
    // Caching applies on Anthropic only when every request in the session ends
    // up stamped (by the customer or by Mesh); a part-stamped stream is priced
    // at the customer's own policy rather than assumed cached.
    const policy = anthropic
      ? reduced.every(carriesCacheControl)
        ? ANTHROPIC_CACHE_5M
        : baselinePolicy
      : OPENAI_CACHE;
    const costUsd = sessionCost(reduced, policy, spacingSeconds);
    arms[arm] = {
      costUsd,
      savingPercent: baselineCostUsd > 0 ? ((baselineCostUsd - costUsd) / baselineCostUsd) * 100 : 0,
      policy: policy.name,
    };
  }

  const maxRequestTokens = Math.max(
    ...rawBodies.map((body) => reduceRequest(body, { toolSchemas: false }).summary.estimatedTokensBefore),
  );

  return {
    capture,
    client: clientOf(rows[0]!),
    path,
    turns: rows.length,
    maxRequestTokens,
    baselinePolicy: baselinePolicy.name,
    baselineCostUsd,
    arms,
  };
}

export function capturesAvailable(): boolean {
  return CAPTURE_FILES.every((file) => existsSync(`${CAPTURE_DIR}${file}`));
}

/** Replay every real capture through the product's reducer + cache model. */
export function qualifyOnCaptures(options: { spacingSeconds?: number } = {}): CaptureQualification {
  const spacingSeconds = options.spacingSeconds ?? 30;
  const sessions: SessionQualification[] = [];
  for (const file of CAPTURE_FILES) {
    const path = `${CAPTURE_DIR}${file}`;
    if (!existsSync(path)) continue;
    const rows = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CaptureRow);
    for (const session of splitSessions(rows)) sessions.push(qualifySession(file, session, spacingSeconds));
  }

  const baselineTotal = sessions.reduce((sum, s) => sum + s.baselineCostUsd, 0);
  const totals = {} as CaptureQualification["totals"];
  for (const arm of CAPTURE_ARMS) {
    const armTotal = sessions.reduce((sum, s) => sum + s.arms[arm].costUsd, 0);
    totals[arm] = { savingPercent: baselineTotal > 0 ? ((baselineTotal - armTotal) / baselineTotal) * 100 : 0 };
  }

  return {
    sessions,
    totals,
    spacingSeconds,
    basis: "derived-from-captures",
    notes: [
      `Turn spacing ${spacingSeconds}s is an ESTIMATE (captures carry no usable inter-arrival timing).`,
      "Savings are net of the customer's own caching (Anthropic stamps already present, OpenAI automatic caching).",
      "stampRepair and blockRepair reorder lines the model reads: cost effect measured, quality effect NOT — gate-required before any saving is billed.",
      "All figures are SIMULATOR (the product's cache model on captured request bodies), not LIVE provider usage.",
    ],
  };
}
