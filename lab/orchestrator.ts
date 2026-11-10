// The continuous improvement loop.
//
// The orchestrator needs no human to start each stage. On every step it:
//   1. looks for the open work furthest along the pipeline and advances it one
//      stage (finish in-flight experiments before starting new ones);
//   2. if nothing is in flight, dispatches Scouts to discover new leads;
//   3. if there is nothing left to discover either, it is quiescent.
// Every agent records its own outcome in the ledger, and the Scout biases
// future discovery from those outcomes (categoryOutcomes) — so what works and
// what fails shapes what gets researched next.

import { builderRun } from "./agents/builder.js";
import { designRun } from "./agents/design.js";
import { evaluationRun } from "./agents/evaluation.js";
import { maintainerRun } from "./agents/maintainer.js";
import { redTeamRun } from "./agents/red-team.js";
import { researchRun } from "./agents/research.js";
import { scoutDispatch } from "./agents/scout.js";
import { CATALOG } from "./catalog.js";
import { fingerprint, type LabLedger } from "./ledger.js";
import { isTerminal, type LeadStatus } from "./types.js";

export type StepResult =
  | { action: "advance"; recordId: string; from: LeadStatus; to: LeadStatus; by: string }
  | { action: "scout"; created: string[]; generated?: number }
  | { action: "idle" };

// Process the furthest-along work first: a record mid-pipeline is finished
// before a fresh lead is researched, and leads before new scouting.
const STAGE_ORDER: LeadStatus[] = [
  "maintaining",
  "evaluating",
  "red_team",
  "building",
  "designed",
  "discovered",
];

export type OrchestratorOptions = {
  now?: () => string;
  /** How many leads a scouting pass may create. */
  scoutCount?: number;
  /** Disable scouting (process only in-flight work). */
  noScout?: boolean;
  /** Let the Scout generate parameter-sweep leads once the catalogue is drained. */
  generate?: boolean;
};

function runStage(ledger: LabLedger, status: LeadStatus, recordId: string): StepResult {
  const before = ledger.getRecord(recordId)!;
  let after;
  switch (status) {
    case "discovered":
      after = researchRun(ledger, before);
      break;
    case "designed":
      after = designRun(ledger, before);
      break;
    case "building":
      after = builderRun(ledger, before);
      break;
    case "red_team":
      after = redTeamRun(ledger, before);
      break;
    case "evaluating":
      after = evaluationRun(ledger, before);
      break;
    case "maintaining":
      after = maintainerRun(ledger, before);
      break;
    default:
      throw new Error(`No agent handles status ${status}.`);
  }
  return { action: "advance", recordId, from: status, to: after.status, by: after.history.at(-1)!.by };
}

/** Advance the pipeline by one unit of work. */
export function step(ledger: LabLedger, options: OrchestratorOptions = {}): StepResult {
  for (const status of STAGE_ORDER) {
    const next = ledger.listRecords({ status })[0];
    if (next) return runStage(ledger, status, next.id);
  }
  // Nothing in flight — discover new leads.
  if (!options.noScout) {
    const result = scoutDispatch(ledger, {
      count: options.scoutCount,
      now: options.now,
      generate: options.generate,
    });
    if (result.created.length > 0) {
      return { action: "scout", created: result.created, generated: result.generated };
    }
  }
  return { action: "idle" };
}

export type RunSummary = {
  steps: StepResult[];
  statusCounts: Record<string, number>;
  promoted: string[];
  integrity: ReturnType<LabLedger["verifyIntegrity"]>;
};

/** Run the loop until it is quiescent (no open work and nothing to discover). */
export function runToQuiescence(
  ledger: LabLedger,
  options: OrchestratorOptions & { maxSteps?: number } = {},
): RunSummary {
  const maxSteps = options.maxSteps ?? 500;
  const steps: StepResult[] = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const result = step(ledger, options);
    if (result.action === "idle") break;
    steps.push(result);
  }

  const records = ledger.listRecords();
  const statusCounts: Record<string, number> = {};
  for (const record of records) statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;

  return {
    steps,
    statusCounts,
    promoted: records.filter((r) => r.status === "promoted").map((r) => r.id),
    integrity: ledger.verifyIntegrity(),
  };
}

// ---------------------------------------------------------------------------
// Continuous operation
// ---------------------------------------------------------------------------

export type ContinuousOptions = OrchestratorOptions & {
  /** Delay between ticks (ms). */
  intervalMs?: number;
  /** Hard cap on ticks (default: unbounded). */
  maxTicks?: number;
  /**
   * Stop after this many consecutive idle ticks — i.e. once there is nothing
   * left to process, discover or generate. Default 3. Pass Infinity to run as a
   * true daemon that keeps polling forever.
   */
  maxIdleTicks?: number;
  /** Called after every tick (for live logging). */
  onStep?: (result: StepResult, tick: number) => void;
  /** Injectable delay (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type ContinuousSummary = RunSummary & { ticks: number; stoppedIdle: boolean };

/**
 * Run the Discover → … → Repeat loop continuously. Generation is on by default
 * so the Scout keeps finding real work after the catalogue is drained. Stops
 * after `maxIdleTicks` consecutive idle ticks (nothing left to do) unless that
 * is Infinity, in which case it runs until `maxTicks` or forever.
 */
export async function runContinuous(
  ledger: LabLedger,
  options: ContinuousOptions = {},
): Promise<ContinuousSummary> {
  const intervalMs = options.intervalMs ?? 200;
  const maxTicks = options.maxTicks ?? Number.POSITIVE_INFINITY;
  const maxIdleTicks = options.maxIdleTicks ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  const stepOptions: OrchestratorOptions = { ...options, generate: options.generate ?? true };

  const steps: StepResult[] = [];
  let tick = 0;
  let idle = 0;
  while (tick < maxTicks && idle < maxIdleTicks) {
    const result = step(ledger, stepOptions);
    tick += 1;
    options.onStep?.(result, tick);
    if (result.action === "idle") {
      idle += 1;
    } else {
      idle = 0;
      steps.push(result);
    }
    if (idle >= maxIdleTicks || tick >= maxTicks) break;
    await sleep(intervalMs);
  }

  const records = ledger.listRecords();
  const statusCounts: Record<string, number> = {};
  for (const record of records) statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;

  return {
    steps,
    statusCounts,
    promoted: records.filter((r) => r.status === "promoted").map((r) => r.id),
    integrity: ledger.verifyIntegrity(),
    ticks: tick,
    stoppedIdle: idle >= maxIdleTicks,
  };
}

/** True when nothing is left to process or discover. */
export function isQuiescent(ledger: LabLedger, options: OrchestratorOptions = {}): boolean {
  const inFlight = ledger.listRecords().some((r) => !isTerminal(r.status));
  if (inFlight) return false;
  if (options.noScout) return true;
  // Otherwise quiescent only if there is no undiscovered catalogue lead left.
  return !CATALOG.some(
    (entry) => !ledger.findByFingerprint(fingerprint(entry.category, entry.techniqueKey)),
  );
}
