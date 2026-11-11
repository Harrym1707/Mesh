// Sweeps over the paying shape: where do the levers actually pay?
//
//   sessionLengthSweep  — the 5-turn fixture gave history compaction nothing to
//                         compact. Longer sessions show where it (and the fresh
//                         tool-result cap) start to matter, under the same gate.
//   cadenceSweep        — the gap BETWEEN turns of one conversation decides
//                         whether a 5-minute cache stamp reads or just pays the
//                         write premium, and where the 1-hour TTL earns its 2x
//                         write. This is the cadence-aware TTL lever (lever
//                         backlog P2) made measurable.
//
// Basis: SIMULATOR (repo agent fixture, simulated grader, product cache model).
// Turn gaps are synthetic — no capture carries real inter-arrival timing — so
// every cadence figure is an ESTIMATE of the mechanism, not of anyone's traffic.

import type { MeshTokenReductionConfig } from "../packages/sdk-js/src/reduce-request.js";
import { DEFAULT_MAX_QUALITY_DEGRADATION } from "./constraints.js";
import { PAYING_SHAPE_LADDER, runPayingShapeArm, type ArmShape } from "./paying-shape.js";

export type SweepCell = {
  label: string;
  costUsd: number;
  /** Whole-bill saving vs the raw uncached baseline for the SAME shape. */
  savingPercent: number;
  cleanTasks: number;
  totalTasks: number;
  qualityDrop: number;
  withinCeiling: boolean;
  cacheHitRate: number;
  policy: string;
};

function cell(
  label: string,
  config: MeshTokenReductionConfig,
  shape: ArmShape,
  raw: { costUsd: number; clean: number; tasks: number },
): SweepCell {
  const run = runPayingShapeArm(config, shape);
  const qualityDrop = raw.clean / raw.tasks - run.clean / run.tasks;
  return {
    label,
    costUsd: run.costUsd,
    savingPercent: ((raw.costUsd - run.costUsd) / raw.costUsd) * 100,
    cleanTasks: run.clean,
    totalTasks: run.tasks,
    qualityDrop,
    withinCeiling: qualityDrop <= DEFAULT_MAX_QUALITY_DEGRADATION + 1e-9,
    cacheHitRate: run.hitRate,
    policy: run.policy,
  };
}

function rung(id: string): MeshTokenReductionConfig {
  const found = PAYING_SHAPE_LADDER.find((r) => r.id === id);
  if (!found) throw new Error(`No ladder rung "${id}".`);
  return found.config;
}

export type SessionLengthRow = {
  turns: number;
  tasks: number;
  baselineCostUsd: number;
  lossless: SweepCell;
  /** Everything except history compaction and the output cap. */
  freshCap: SweepCell;
  /** + history compaction — the lever under test. */
  history: SweepCell;
  /** Extra saving history compaction adds over the fresh cap alone, in points. */
  historyAddsPoints: number;
};

/** How the stack behaves as sessions get longer (tasks kept small so it stays fast). */
export function sessionLengthSweep(turnCounts: number[] = [5, 12, 20], tasks = 10): SessionLengthRow[] {
  return turnCounts.map((turns) => {
    const shape: ArmShape = { turns, tasks };
    const raw = runPayingShapeArm(undefined, shape);
    const lossless = cell("lossless", rung("lossless"), shape, raw);
    const freshCap = cell("+ fresh tool-result cap", rung("freshCap"), shape, raw);
    const history = cell("+ history compaction", rung("history"), shape, raw);
    return {
      turns,
      tasks,
      baselineCostUsd: raw.costUsd,
      lossless,
      freshCap,
      history,
      historyAddsPoints: history.savingPercent - freshCap.savingPercent,
    };
  });
}

export type CadenceRow = {
  turnGapSeconds: number;
  baselineCostUsd: number;
  ttl5m: SweepCell;
  ttl1h: SweepCell;
  /** Which TTL is cheaper at this cadence, or "neither" if both lose to uncached. */
  better: "5m" | "1h" | "neither";
};

/**
 * Lossless stack at different turn gaps, 5-minute vs 1-hour TTL. Tasks are
 * spaced far enough apart that they never overlap, so the only variable is the
 * gap between turns of the same conversation.
 */
export function cadenceSweep(turnGaps: number[] = [3, 120, 480, 2_700], tasks = 10): CadenceRow[] {
  const lossless = rung("lossless");
  return turnGaps.map((turnGapSeconds) => {
    const shape: ArmShape = { turnGapSeconds, tasks, spacingSeconds: turnGapSeconds * 10 + 30 };
    const raw = runPayingShapeArm(undefined, shape);
    const ttl5m = cell("5m TTL", { ...lossless, cacheTtl: "5m" }, shape, raw);
    const ttl1h = cell("1h TTL", { ...lossless, cacheTtl: "1h" }, shape, raw);
    const best = ttl5m.savingPercent >= ttl1h.savingPercent ? ttl5m : ttl1h;
    return {
      turnGapSeconds,
      baselineCostUsd: raw.costUsd,
      ttl5m,
      ttl1h,
      better: best.savingPercent <= 0 ? "neither" : best === ttl5m ? "5m" : "1h",
    };
  });
}
