// Mesh Token Engineering Lab — command-line entry point.
//
//   pnpm lab:run            advance the persistent lab ledger to quiescence
//   pnpm lab:status         print the ledger + promoted portfolio
//   pnpm lab:verify         verify the hash-chained audit trail
//   pnpm lab:demo           run one complete end-to-end workflow and narrate it
//
// (or: node --import tsx lab/cli.ts <command> [--root <dir>])

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabLedger } from "./ledger.js";
import { runContinuous, runToQuiescence, step } from "./orchestrator.js";
import { capturesAvailable, qualifyOnCaptures } from "./captures.js";
import { readLiveNumbers } from "./numbers.js";
import { qualifyPayingShape } from "./paying-shape.js";
import { cadenceSweep, sessionLengthSweep } from "./sweeps.js";
import { fleetSavings } from "./workloads.js";
import type { OptimisationRecord } from "./types.js";

const DEFAULT_ROOT = "lab/ledger";

function parse(argv: string[]): { command: string; options: Record<string, string> } {
  const command = argv[0] ?? "status";
  const options: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (key.startsWith("--")) options[key.slice(2)] = argv[++i] ?? "true";
  }
  return { command, options };
}

function line(char = "─", width = 72): string {
  return char.repeat(width);
}

function printStatus(ledger: LabLedger): void {
  const records = ledger.listRecords();
  console.log(`\nLedger: ${records.length} optimisation(s)`);
  for (const r of records) {
    const save = r.actualSavingPercent ?? r.expectedSavingPercent ?? 0;
    console.log(
      `  ${r.id}  ${r.status.padEnd(12)} ${r.category.padEnd(14)} ${r.title}` +
        (r.status === "promoted" ? `  [+${save.toFixed(1)}% tokens]` : ""),
    );
  }
  const portfolio = ledger.readPortfolio();
  console.log(`\nPromoted portfolio: ${portfolio.levers.length} lever(s)`);
  for (const lever of portfolio.levers) {
    console.log(
      `  ${lever.id}  ${lever.title} — ${lever.measuredTokenReductionPercent.toFixed(1)}% tokens, ` +
        `${lever.measuredCostReductionPercent.toFixed(1)}% cost, quality drop ${(lever.measuredQualityDelta * 100).toFixed(2)}%`,
    );
  }
  const fleet = fleetSavings(ledger);
  const live = readLiveNumbers();
  console.log(`\n% SAVED FOR THE END USER`);
  console.log(
    live.headlinePercent !== undefined
      ? `  LIVE          ${live.headlinePercent.toFixed(1)}%  ${live.headlineDescription ?? ""}`.trimEnd() +
          `\n                (docs/NUMBERS.md, reconciled ${live.reconciled ?? "unknown"} — the only number measured on real traffic)`
      : `  LIVE          see docs/NUMBERS.md — the only numbers measured on real traffic`,
  );
  console.log(`  ── everything below is LAB SIMULATOR: experimental, not in docs/NUMBERS.md, never to be quoted externally ──`);
  if (capturesAvailable()) {
    const qualified = qualifyOnCaptures();
    console.log(
      `  FLOOR         ${qualified.totals.stamp.savingPercent.toFixed(1)}%  real wire captures, lossless levers ` +
        `(${qualified.sessions.length} sessions; small or already-cached traffic — the "do not pay us" band)`,
    );
    console.log(
      `  GATED         ${qualified.totals.blockRepair.savingPercent.toFixed(1)}%  same captures + experimental block-array prefix repair ` +
        `(cost measured, quality NOT; carried by one volatile session)`,
    );
  }
  const paying = qualifyPayingShape();
  const losslessArm = paying.arms.find((arm) => arm.lossless);
  const fullArm = paying.arms.at(-1)!;
  console.log(
    `  PAYING SHAPE  ${losslessArm?.savingPercent.toFixed(1)}% lossless · ${paying.bestWithinCeiling?.savingPercent.toFixed(1)}% best stack inside the ` +
      `${(paying.maxQualityDegradation * 100).toFixed(0)}% quality ceiling (uncached Claude agent, repo fixture, simulated grader)`,
  );
  if (paying.ceilingBreaker) {
    console.log(
      `                ceiling-breaker: ${paying.ceilingBreaker} — full stack reaches ${fullArm.savingPercent.toFixed(1)}% ` +
        `but drops quality ${(fullArm.qualityDrop * 100).toFixed(1)}pp (${fullArm.cleanTasks}/${fullArm.totalTasks} clean)`,
    );
  }
  console.log(
    `  MODELLED MIX  ${fleet.fleetPercentSaved.toFixed(1)}%  constructed fixtures × an ESTIMATE spend mix ` +
      `(addressable ${(fleet.addressableShare * 100).toFixed(0)}%, parked ${(fleet.parkedShare * 100).toFixed(0)}%)`,
  );
  // Where docs/NUMBERS.md has a LIVE per-agent figure, show it beside the modelled one.
  const liveFor: Record<string, number | undefined> = {
    "coding-agent": live.perAgent.coding,
    rag: live.perAgent.rag,
  };
  for (const w of fleet.workloads) {
    const tag =
      w.addressable === "parked-advisory-only"
        ? "PARKED (advisory only)"
        : w.savingsPercent > 0
          ? `${w.savingsPercent.toFixed(1)}% modelled (${w.bestLeverId})`
          : "0% — no proven lever yet";
    const liveTag = liveFor[w.domain] !== undefined ? `   | LIVE ${liveFor[w.domain]!.toFixed(1)}%` : "";
    console.log(`    ${(w.spendShare * 100).toFixed(0).padStart(3)}% spend  ${w.label.padEnd(34)} ${tag}${liveTag}`);
  }

  const coverage = ledger.coverageByShape();
  console.log(`\nCoverage by workload vertical (agentic first):`);
  for (const shape of ["always-on-agent", "autonomous-agent", "one-shot"] as const) {
    const c = coverage[shape];
    console.log(`  ${shape.padEnd(17)} ${c.total} lead(s) — ${c.promoted} promoted, ${c.needsGate} need a gate, ${c.inconclusive} inconclusive, ${c.rejected + c.failed} rejected/failed`);
  }

  const awaitingGate = ledger.listRecords({ status: "needs_gate" });
  if (awaitingGate.length > 0) {
    console.log(`\nMeasured but NOT promoted — lossy, awaiting a real replay gate (SIMULATOR evidence):`);
    for (const r of awaitingGate) {
      const quality = r.evaluation?.qualityUnmeasured
        ? "quality unmeasured"
        : `quality drop ${((r.evaluation?.qualityDelta ?? 0) * 100).toFixed(1)}% on a simulated grader`;
      console.log(`  ${r.id}  ${r.title} — ${(r.actualSavingPercent ?? 0).toFixed(1)} (${quality})`);
    }
  }

  const integrity = ledger.verifyIntegrity();
  console.log(`\nAudit trail: ${integrity.ok ? `OK (${integrity.length} events, hash-chain intact)` : `BROKEN at seq ${integrity.seq}: ${integrity.reason}`}`);
}

function narrateRecord(ledger: LabLedger, id: string): void {
  const r = ledger.getRecord(id) as OptimisationRecord;
  console.log(`\n${line("═")}`);
  console.log(`${r.id} — ${r.title}`);
  console.log(`category=${r.category}  bucket=${r.bucket}  final=${r.status.toUpperCase()}`);
  console.log(line());
  console.log("Lifecycle:");
  for (const h of r.history) {
    console.log(`  ${(h.from ?? "∅").padEnd(11)} -> ${h.to.padEnd(11)} by ${h.by.padEnd(10)} ${h.note}`);
  }
  if (r.compatibility) {
    console.log(`\nResearch verdict: ${r.compatibility.verdict.toUpperCase()}`);
    for (const note of r.compatibility.notes) console.log(`  ${note}`);
  }
  if (r.redTeam) {
    console.log(`\nRed Team: ${r.redTeam.verdict.toUpperCase()} (${r.redTeam.unresolvedCritical} unresolved critical)`);
    for (const f of r.redTeam.findings) console.log(`  [${f.severity}] ${f.category}: ${f.description}`);
  }
  if (r.evaluation) {
    const e = r.evaluation;
    console.log(`\nEvaluation: ${e.verdict}`);
    console.log(`  tokens ${e.baseline.tokens} -> ${e.candidate.tokens} (${e.tokenReductionPercent.toFixed(1)}% reduction)`);
    console.log(`  cost $${e.baseline.costUsd.toFixed(4)} -> $${e.candidate.costUsd.toFixed(4)} (${e.costReductionPercent.toFixed(1)}% reduction)`);
    console.log(`  quality drop ${(e.qualityDelta * 100).toFixed(2)}%  candidate error rate ${(e.reliability.candidateErrorRate * 100).toFixed(1)}%`);
    for (const g of e.gates) console.log(`  ${g.passed ? "PASS" : "FAIL"} ${g.name}: observed ${g.observed} / required ${g.required}`);
  }
  if (r.promotion) {
    console.log(`\nMaintainer decision: ${r.promotion.decision}`);
    for (const g of r.promotion.checkedGates) console.log(`  ${g.passed ? "PASS" : "FAIL"} ${g.name}: ${g.detail}`);
    console.log(`  Reason: ${r.promotion.reason}`);
  }
}

function runDemo(): void {
  console.log(line("═"));
  console.log("MESH TOKEN ENGINEERING LAB — end-to-end demonstration");
  console.log(line("═"));
  const root = mkdtempSync(join(tmpdir(), "mesh-lab-demo-"));
  // Deterministic clock so the demo is reproducible.
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const ledger = new LabLedger(root, { now });

  console.log("\n1. The orchestrator finds no open work, so it dispatches Scouts.");
  const first = step(ledger, { now });
  if (first.action === "scout") {
    console.log(`   Scouts discovered ${first.created.length} lead(s): ${first.created.join(", ")}`);
  }

  console.log("\n2. The orchestrator runs the full pipeline to quiescence:");
  console.log("   Scout → Research → Design → Build → Red Team → Evaluate → Maintain");
  const summary = runToQuiescence(ledger, { now });
  for (const s of summary.steps) {
    if (s.action === "advance") {
      console.log(`   ${s.recordId}: ${s.from} -> ${s.to}  (${s.by})`);
    } else if (s.action === "scout") {
      console.log(`   scouts discovered: ${s.created.join(", ")}`);
    }
  }

  console.log(`\n3. Outcomes by status: ${JSON.stringify(summary.statusCounts)}`);
  console.log(`   Audit trail integrity: ${summary.integrity.ok ? `OK (${summary.integrity.length} hash-chained events)` : "BROKEN"}`);

  // Narrate one promoted record end-to-end (the Definition-of-Done workflow),
  // plus one rejected and one inconclusive so every path is visible.
  const promoted = ledger.listRecords({ status: "promoted" })[0];
  const rejected = ledger.listRecords({ status: "rejected" })[0];
  const inconclusive = ledger.listRecords({ status: "inconclusive" })[0];

  console.log(`\n4. The complete end-to-end workflow for one promoted optimisation:`);
  if (promoted) narrateRecord(ledger, promoted.id);
  if (rejected) {
    console.log(`\n5. An idea Research rejected early (content-blind / Mesh-side constraint):`);
    narrateRecord(ledger, rejected.id);
  }
  if (inconclusive) {
    console.log(`\n6. An idea with no runnable implementation yet (evaluated INCONCLUSIVE):`);
    narrateRecord(ledger, inconclusive.id);
  }

  console.log(`\n${line("═")}`);
  printStatus(ledger);
  console.log(`\nDemo ledger written to: ${root}`);
  console.log("(ephemeral; delete it with: rm -rf " + root + ")");
  rmSync(root, { recursive: true, force: true });
}

const { command, options } = parse(process.argv.slice(2));

switch (command) {
  case "demo":
    runDemo();
    break;
  case "run": {
    const ledger = new LabLedger(options.root ?? DEFAULT_ROOT);
    const summary = runToQuiescence(ledger, { scoutCount: options.scoutCount ? Number(options.scoutCount) : undefined });
    console.log(`Ran ${summary.steps.length} step(s). Status: ${JSON.stringify(summary.statusCounts)}`);
    printStatus(ledger);
    break;
  }
  case "watch": {
    const ledger = new LabLedger(options.root ?? DEFAULT_ROOT);
    const intervalMs = options.interval ? Number(options.interval) : 200;
    const maxTicks = options.ticks ? Number(options.ticks) : Number.POSITIVE_INFINITY;
    const maxIdleTicks = options.forever
      ? Number.POSITIVE_INFINITY
      : options.idle
        ? Number(options.idle)
        : 3;
    console.log(
      `Scouting continuously (interval ${intervalMs}ms, ` +
        (options.forever ? "forever — Ctrl-C to stop" : `stop after ${maxIdleTicks} idle ticks`) +
        ")...",
    );
    const summary = await runContinuous(ledger, {
      intervalMs,
      maxTicks,
      maxIdleTicks,
      onStep: (result, tick) => {
        if (result.action === "advance") {
          console.log(`  t${tick} ${result.recordId}: ${result.from} -> ${result.to} (${result.by})`);
        } else if (result.action === "scout") {
          const tag = result.generated ? ` (${result.generated} generated)` : "";
          console.log(`  t${tick} scouts discovered${tag}: ${result.created.join(", ")}`);
        }
      },
    });
    console.log(`\nStopped after ${summary.ticks} tick(s)${summary.stoppedIdle ? " (idle — nothing left to do)" : ""}.`);
    printStatus(ledger);
    break;
  }
  case "sweep": {
    // On demand: these re-run the cache simulation many times. --full adds the
    // 20-turn sessions, which take several minutes.
    const tasks = options.tasks ? Number(options.tasks) : 5;
    const turnCounts = options.full ? [5, 12, 20] : [5, 12];
    console.log("PAYING-SHAPE SWEEPS — SIMULATOR (repo agent fixture, simulated grader); turn gaps are synthetic ESTIMATES\n");
    console.log(`Session length (${tasks} tasks; whole-bill saving vs raw uncached, clean tasks):`);
    for (const row of sessionLengthSweep(turnCounts, tasks)) {
      const f = (c: { savingPercent: number; cleanTasks: number; totalTasks: number }) =>
        `${c.savingPercent.toFixed(1)}% (${c.cleanTasks}/${c.totalTasks})`;
      console.log(
        `  ${String(row.turns).padStart(2)} turns  lossless ${f(row.lossless)}  + fresh cap ${f(row.freshCap)}  ` +
          `+ history ${f(row.history)}  [history adds ${row.historyAddsPoints.toFixed(1)} pt]`,
      );
    }
    console.log(`\nTurn cadence × cache TTL (lossless stack, ${tasks} tasks × 5 turns):`);
    for (const row of cadenceSweep([3, 120, 480, 2_700], tasks)) {
      console.log(
        `  gap ${String(row.turnGapSeconds).padStart(4)}s  5m TTL ${row.ttl5m.savingPercent.toFixed(1)}% (hits ${(row.ttl5m.cacheHitRate * 100).toFixed(0)}%)  ` +
          `1h TTL ${row.ttl1h.savingPercent.toFixed(1)}% (hits ${(row.ttl1h.cacheHitRate * 100).toFixed(0)}%)  → ${row.better}`,
      );
    }
    break;
  }
  case "status": {
    const ledger = new LabLedger(options.root ?? DEFAULT_ROOT);
    printStatus(ledger);
    break;
  }
  case "verify": {
    const ledger = new LabLedger(options.root ?? DEFAULT_ROOT);
    const integrity = ledger.verifyIntegrity();
    if (integrity.ok) {
      console.log(`Audit trail OK: ${integrity.length} hash-chained events.`);
    } else {
      console.log(`Audit trail BROKEN at seq ${integrity.seq}: ${integrity.reason}`);
      process.exitCode = 2;
    }
    break;
  }
  default:
    console.log(
      "Usage: lab <demo|run|watch|status|sweep|verify> [--root <dir>]\n" +
        "  watch [--interval <ms>] [--idle <n>] [--ticks <n>] [--forever]\n" +
        "  sweep [--tasks <n>] [--full]",
    );
    process.exitCode = 1;
}
