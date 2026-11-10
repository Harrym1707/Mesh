// The paying-shape tier: an uncached, multi-turn Claude agent with a clock on
// top of a long preamble, described tools and kilobyte tool results — the
// shape docs/rnd/rnd-doctrine.md says actually pays Mesh.
//
// It drives the repo's shared agent fixture (evals/agent-fixture.ts) through
// the product's own reduceRequest + simulateCache, exactly as
// evals/run-cache-decomposition.ts does, so the lab's harness is cross-checked
// against the SIMULATOR rows recorded in docs/NUMBERS.md (37.9% cache lever
// alone; 57.3% full stack at 38/40 clean).
//
// What the lab adds is a QUALITY GATE and an ABLATION. The fixture's simulated
// model has real consequences — it picks the wrong tool once descriptions stop
// discriminating, fails a task whose latest tool result lost its reference, and
// loses completeness when an output cap truncates a long answer — so each lever
// can be added one at a time and judged against the lab's ceiling (default 2%
// quality degradation). The result is the best stack that stays INSIDE the
// ceiling, and the name of the lever that breaks it.
//
// Basis: SIMULATOR. The grader is a simulated model, not a provider; it does
// not model sensitivity to WHERE a date anchor sits, so a pass here does not
// clear prefix repair's own date-anchor gate (lever-backlog P3, condition 2).

import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  simulateCache,
  type SimulatedRequest,
} from "../packages/core/src/cache-simulator.js";
import { lookupPrice, publishedModelPrices } from "../packages/core/src/index.js";
import { approximateTokenCount } from "../packages/core/src/token-reduction.js";
import { reduceRequest, type MeshTokenReductionConfig } from "../packages/sdk-js/src/reduce-request.js";
import { answer, buildAnthropicRequest, wirePrompt, TASKS, TURNS_PER_TASK } from "../evals/agent-fixture.js";
import { DEFAULT_MAX_QUALITY_DEGRADATION } from "./constraints.js";

type AnyObject = Record<string, unknown>;

export type PayingShapeArm = {
  id: string;
  label: string;
  /** The lever this arm adds on top of the previous one. */
  adds: string;
  /** True when every lever in the arm leaves the model-read token sequence identical. */
  lossless: boolean;
  costUsd: number;
  /** Whole-bill saving vs the raw uncached baseline (input + output). */
  savingPercent: number;
  cleanTasks: number;
  totalTasks: number;
  /** Baseline clean rate minus this arm's clean rate. */
  qualityDrop: number;
  withinCeiling: boolean;
  cacheHitRate: number;
  stamped: number;
};

export type PayingShapeResult = {
  baseline: { costUsd: number; cleanTasks: number; totalTasks: number };
  arms: PayingShapeArm[];
  /** The highest-saving arm whose quality drop is within the ceiling. */
  bestWithinCeiling: PayingShapeArm | undefined;
  /** The first lever whose addition pushes quality past the ceiling, if any. */
  ceilingBreaker: string | undefined;
  /** Cache on vs off for the SAME full stack — the row docs/NUMBERS.md records as 37.9%. */
  cacheContributionPercent: number;
  maxQualityDegradation: number;
  spacingSeconds: number;
  basis: "SIMULATOR";
};

// Cumulative ablation ladder: each arm adds exactly one lever to the one before.
const LADDER: { id: string; label: string; adds: string; lossless: boolean; config: MeshTokenReductionConfig }[] = [
  {
    id: "lossless",
    label: "Lossless only",
    adds: "tool-schema compaction + duplicate removal + 5m cache stamp",
    lossless: true,
    config: { toolSchemas: true, duplicateContext: true, cacheTtl: "5m" },
  },
  {
    id: "repair",
    label: "+ cache-prefix repair",
    adds: "cache-prefix repair (moves the clock out of the prefix)",
    lossless: false,
    config: { toolSchemas: true, duplicateContext: true, cacheTtl: "5m", repairCachePrefix: true },
  },
  {
    id: "descriptions",
    label: "+ description truncation",
    adds: "tool-description truncation (40 tokens)",
    lossless: false,
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      cacheTtl: "5m",
      repairCachePrefix: true,
    },
  },
  {
    id: "freshCap",
    label: "+ fresh tool-result cap",
    adds: "fresh tool-result cap",
    lossless: false,
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      cacheTtl: "5m",
      repairCachePrefix: true,
      freshToolResultCap: true,
    },
  },
  {
    id: "history",
    label: "+ history compaction",
    adds: "history compaction",
    lossless: false,
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      cacheTtl: "5m",
      repairCachePrefix: true,
      freshToolResultCap: true,
      historyCompaction: true,
    },
  },
  {
    id: "outputCap",
    label: "+ output cap (full stack)",
    adds: "output cap (2,000 tokens)",
    lossless: false,
    config: {
      toolSchemas: { descriptions: "truncate", maximumDescriptionTokens: 40 },
      duplicateContext: true,
      cacheTtl: "5m",
      repairCachePrefix: true,
      freshToolResultCap: true,
      historyCompaction: true,
      maxOutputTokens: 2_000,
    },
  },
];

type ArmRun = { costUsd: number; clean: number; hitRate: number; stamped: number; total: number };

function runArm(config: MeshTokenReductionConfig | undefined, spacingSeconds: number): ArmRun {
  // Same price lookup and stamping rule as evals/run-cache-decomposition.ts, so
  // the two harnesses agree to the cent.
  const price = lookupPrice(publishedModelPrices, { provider: "openai", model: "gpt-5", at: "2026-10-13" });
  if (price.status !== "priced") throw new Error("price lookup failed");

  const simulated: SimulatedRequest[] = [];
  let clean = 0;
  let stamped = 0;
  for (let task = 0; task < TASKS; task += 1) {
    const clockHour = 8 + (task % 10);
    let fullyGood = true;
    for (let turn = 0; turn < TURNS_PER_TASK; turn += 1) {
      const original = buildAnthropicRequest(task, turn, clockHour);
      let sent = original as AnyObject;
      if (config !== undefined) {
        const reduced = reduceRequest(original, config);
        sent = reduced.request as AnyObject;
        if (reduced.summary.changes.some((change) => change.lever.startsWith("cache-ttl-"))) stamped += 1;
      }
      const outcome = answer(sent);
      if (!outcome.correct || outcome.completeness < 0.95) fullyGood = false;
      simulated.push({
        atSeconds: task * spacingSeconds + turn * 3,
        prompt: wirePrompt(sent),
        outputTokens: outcome.outputTokens,
      });
    }
    if (fullyGood) clean += 1;
  }
  const policy = stamped === simulated.length && stamped > 0 ? ANTHROPIC_CACHE_5M : ANTHROPIC_NO_CACHE;
  const result = simulateCache(simulated, policy, price.price, { countTokens: approximateTokenCount });
  return { costUsd: result.totalCostUsd, clean, hitRate: result.hitRate, stamped, total: simulated.length };
}

type LadderRuns = { raw: ArmRun; rungs: ArmRun[]; fullUncached: ArmRun };

// The fixture is deterministic, so the (expensive) simulation is run once per
// spacing; re-judging against a different ceiling costs nothing.
const ladderCache = new Map<number, LadderRuns>();

function runLadder(spacingSeconds: number): LadderRuns {
  const cached = ladderCache.get(spacingSeconds);
  if (cached) return cached;
  const { cacheTtl: _omitted, ...uncachedFull } = LADDER.at(-1)!.config;
  const runs: LadderRuns = {
    raw: runArm(undefined, spacingSeconds),
    rungs: LADDER.map((rung) => runArm(rung.config, spacingSeconds)),
    // Cache contribution, clean: the SAME full stack with the stamp off.
    fullUncached: runArm(uncachedFull, spacingSeconds),
  };
  ladderCache.set(spacingSeconds, runs);
  return runs;
}

/** Run the ablation ladder on the paying shape and judge each arm against the ceiling. */
export function qualifyPayingShape(
  options: { spacingSeconds?: number; maxQualityDegradation?: number } = {},
): PayingShapeResult {
  const spacingSeconds = options.spacingSeconds ?? 30;
  const maxQualityDegradation = options.maxQualityDegradation ?? DEFAULT_MAX_QUALITY_DEGRADATION;

  const { raw, rungs, fullUncached } = runLadder(spacingSeconds);
  const baselineRate = raw.clean / TASKS;

  const arms: PayingShapeArm[] = LADDER.map((rung, index) => {
    const run = rungs[index]!;
    const qualityDrop = baselineRate - run.clean / TASKS;
    return {
      id: rung.id,
      label: rung.label,
      adds: rung.adds,
      lossless: rung.lossless,
      costUsd: run.costUsd,
      savingPercent: ((raw.costUsd - run.costUsd) / raw.costUsd) * 100,
      cleanTasks: run.clean,
      totalTasks: TASKS,
      qualityDrop,
      withinCeiling: qualityDrop <= maxQualityDegradation + 1e-9,
      cacheHitRate: run.hitRate,
      stamped: run.stamped,
    };
  });

  const passing = arms.filter((arm) => arm.withinCeiling);
  const bestWithinCeiling = passing.length
    ? passing.reduce((best, arm) => (arm.savingPercent > best.savingPercent ? arm : best))
    : undefined;
  const ceilingBreaker = arms.find((arm) => !arm.withinCeiling)?.adds;

  // Cache contribution, clean: the SAME full stack with the stamp off vs on.
  const fullCached = arms.at(-1)!;
  const cacheContributionPercent = ((fullUncached.costUsd - fullCached.costUsd) / fullUncached.costUsd) * 100;

  return {
    baseline: { costUsd: raw.costUsd, cleanTasks: raw.clean, totalTasks: TASKS },
    arms,
    bestWithinCeiling,
    ceilingBreaker,
    cacheContributionPercent,
    maxQualityDegradation,
    spacingSeconds,
    basis: "SIMULATOR",
  };
}
