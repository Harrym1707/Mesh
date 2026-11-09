import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ingestTraffic,
  leversFromMeasurement,
  measureTraffic,
  profileFromMeasurement,
  projectSavings,
  publishedModelPrices,
  lookupPrice,
  trafficFingerprint,
  type SavingsProjection,
  type TrafficMeasurement,
  type WorkloadMeasurement,
} from "../../core/src/index.js";

/**
 * mesh analyse: measure a traffic sample and report what a reduction is worth.
 *
 * Runs entirely locally. Prompt text is read to count tokens and find shared
 * prefixes, and never written to the report: breaker examples are redacted
 * unless --show-examples is passed explicitly.
 *
 * Numbers come in two kinds and the report keeps them apart. Measured values
 * (spend, token counts, shared prefix, output distribution) come from the
 * sample. Projected savings apply published reduction factors to those measured
 * segments, and are a hypothesis to verify by replay, not a realised saving.
 */

const USAGE = `Usage: mesh analyse --input <file.jsonl> [options]

  --input <path>      Traffic log to read. Repeatable. JSONL, or a JSON array.
  --date <YYYY-MM-DD> Billing date for rows that carry none. Default: today.
  --workload <name>   Override the workload grouping for every row.
  --json <path>       Write the full report as JSON, for diffing across runs.
  --markdown <path>   Write a human-readable report.
  --show-examples     Include literal cache-breaking values. Off by default:
                      these are taken from your prompts.
  --help              Show this message.

Accepts OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, and bare
usage rows, nested under request/response or flattened. Rows it cannot read are
reported rather than silently dropped.`;

type Args = {
  inputs: string[];
  date: string;
  workload?: string;
  json?: string;
  markdown?: string;
  showExamples: boolean;
};

function parse(argv: string[]): Args {
  const args: Args = { inputs: [], date: new Date().toISOString().slice(0, 10), showExamples: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--help" || key === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (key === "--show-examples") {
      args.showExamples = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value.`);
    index += 1;
    switch (key) {
      case "--input": args.inputs.push(resolve(value)); break;
      case "--date": args.date = value; break;
      case "--workload": args.workload = value; break;
      case "--json": args.json = resolve(value); break;
      case "--markdown": args.markdown = resolve(value); break;
      default: throw new Error(`Unknown option: ${key}`);
    }
  }
  if (args.inputs.length === 0) throw new Error("At least one --input is required. See --help.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("--date must be YYYY-MM-DD.");
  return args;
}

async function readRows(paths: string[]): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const path of paths) {
    const text = await readFile(path, "utf8");
    const trimmed = text.trim();
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error(`${path} is not a JSON array or JSONL.`);
      rows.push(...parsed);
      continue;
    }
    for (const [offset, line] of trimmed.split(/\r?\n/).entries()) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        throw new Error(`${path}:${offset + 1} is not valid JSON.`);
      }
    }
  }
  return rows;
}

function usd(value: number): string {
  return value >= 100 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`;
}

function pct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function tokens(value: number): string {
  return Math.round(value).toLocaleString();
}

function redact(example: string): string {
  return example.replace(/[0-9a-z]/gi, "x");
}

function workloadLines(
  measurement: TrafficMeasurement,
  projections: Map<string, SavingsProjection>,
  repairs: Map<string, SavingsProjection>,
  showExamples: boolean,
): string[] {
  const lines: string[] = [];
  for (const workload of measurement.workloads) {
    const projection = projections.get(workload.workload);
    lines.push("");
    const shown = workload.resolvedModel === undefined || workload.resolvedModel === workload.model
      ? workload.model
      : `${workload.model} -> ${workload.resolvedModel}`;
    lines.push(`### ${workload.workload} (${workload.provider}/${shown})`);
    lines.push("");
    lines.push(`- Requests: ${workload.requests.toLocaleString()}`);
    lines.push(
      workload.baselineCostUsd === undefined
        ? `- Baseline spend: not priced. ${workload.unpricedReason}`
        : `- Baseline spend: ${usd(workload.baselineCostUsd)} ` +
          `(${tokens(workload.inputTokens)} in / ${tokens(workload.outputTokens)} out)`,
    );
    if (workload.alreadyCachedInputTokens > 0) {
      lines.push(
        `- Already cached: ${tokens(workload.alreadyCachedInputTokens)} input tokens ` +
        `(${pct((workload.alreadyCachedInputTokens / workload.inputTokens) * 100)}). ` +
        "Excluded from the projection below; this saving is already yours.",
      );
    }
    if (workload.meanToolSchemaTokens > 0) {
      lines.push(
        `- Tool schemas: ${tokens(workload.meanToolSchemaTokens)} tokens per request, resent every turn ` +
        `(${pct((workload.meanToolSchemaTokens / (workload.inputTokens / workload.requests)) * 100)} of input).`,
      );
    }
    if (workload.caching) {
      const caching = workload.caching;
      const alreadyCachedShare = workload.inputTokens === 0
        ? 0
        : workload.alreadyCachedInputTokens / workload.inputTokens;
      lines.push(
        `- Cacheable prefix today: ${tokens(caching.sharedPrefixTokens)} tokens ` +
        `(${pct(caching.cacheablePrefixShare * 100)} of a request).`,
      );
      if (alreadyCachedShare > 0.5) {
        lines.push(
          `- Prefix caching is already working here: ${pct(alreadyCachedShare * 100)} of input arrives cached, ` +
          "so little caching headroom remains and none is claimed below.",
        );
      }
      if (caching.recoverablePrefixTokens > caching.sharedPrefixTokens * 1.5) {
        lines.push(
          `- **Recoverable prefix: ${tokens(caching.recoverablePrefixTokens)} tokens.** Per-request values are ` +
          "breaking the cache; move them out of the prefix and this much becomes cacheable.",
        );
      }
      if (caching.prefixBreakers.length > 0) {
        // Grouped by kind: the distinct values are the same problem repeated.
        const byKind = new Map<string, { values: number; occurrences: number; example: string }>();
        for (const breaker of caching.prefixBreakers) {
          const entry = byKind.get(breaker.kind) ?? { values: 0, occurrences: 0, example: breaker.example };
          entry.values += 1;
          entry.occurrences += breaker.occurrences;
          byKind.set(breaker.kind, entry);
        }
        lines.push("- Cache breakers found:");
        for (const [kind, entry] of byKind) {
          const example = showExamples ? entry.example : redact(entry.example);
          lines.push(
            `  - **${kind}**: ${entry.values} distinct value(s) across ${entry.occurrences} occurrence(s), ` +
            `e.g. \`${example}\``,
          );
        }
      }
    }
    if (workload.duplicateContextTokens > 0) {
      lines.push(`- Duplicate context blocks: ${tokens(workload.duplicateContextTokens)} tokens, removable losslessly.`);
    }
    if (workload.outputCap) {
      const cap = workload.outputCap;
      lines.push(
        `- Output: mean ${tokens(cap.meanOutputTokens)}, max ${tokens(cap.maxObserved)}. ` +
        `A cap of ${tokens(cap.recommendedCap)} would truncate ${pct(cap.truncationRate * 100)} of responses.`,
      );
    }
    if (projection) {
      const measured = workload.baselineCostUsd;
      const share = (value: number): string =>
        measured === undefined || measured === 0 ? "n/a" : pct((value / measured) * 100);
      lines.push("");
      lines.push(`| Lever | Risk | Saving | Share of measured spend |`);
      lines.push(`|---|---|---:|---:|`);
      for (const contribution of projection.contributions) {
        if (contribution.costRemovedUsd <= 0) continue;
        lines.push(
          `| ${contribution.lever} | ${contribution.risk} | ${usd(contribution.costRemovedUsd)} | ` +
          `${share(contribution.costRemovedUsd)} |`,
        );
      }
      lines.push(
        `| **Total** | | **${usd(projection.savingUsd)}** | **${share(projection.savingUsd)}** |`,
      );
      lines.push("");
      const free = projection.contributions
        .filter((contribution) => contribution.risk === "deterministic")
        .reduce((total, contribution) => total + contribution.costRemovedUsd, 0);
      lines.push(
        `Risk-free: ${share(free)}. Needs replay verification: ${share(projection.savingUsd - free)}.`,
      );
      const repair = repairs.get(workload.workload);
      if (repair && repair.savingUsd > projection.savingUsd * 1.05) {
        lines.push("");
        lines.push(
          `**Plus prefix repair: ${usd(repair.savingUsd)} (${share(repair.savingUsd)}), ` +
          `up from ${share(projection.savingUsd)}.** Moving the per-request values above out of the prompt ` +
          "prefix makes the rest of it cacheable. The prompt is reordered; the content sent is unchanged.",
        );
      }
      for (const warning of projection.warnings) lines.push(`- Note: ${warning}`);
    }
  }
  return lines;
}

function buildReport(
  measurement: TrafficMeasurement,
  projections: Map<string, SavingsProjection>,
  repairs: Map<string, SavingsProjection>,
  fingerprint: string,
  adapterCounts: Record<string, number>,
  issues: Array<{ line: number; reason: string }>,
  showExamples: boolean,
): string {
  const totalSaving = [...projections.values()].reduce((sum, projection) => sum + projection.savingUsd, 0);
  // Summed from the contributions themselves. Dividing each projection's own
  // percentage by its profile baseline double-counted, because a profile
  // baseline prices every input token fresh while the measured baseline already
  // charges cached tokens at the cache rate.
  const deterministic = [...projections.values()].reduce((sum, projection) =>
    sum + projection.contributions
      .filter((contribution) => contribution.risk === "deterministic")
      .reduce((inner, contribution) => inner + contribution.costRemovedUsd, 0), 0);
  const baseline = measurement.totalBaselineCostUsd;

  return [
    "# MESH cost analysis",
    "",
    `Sample: ${measurement.requests.toLocaleString()} requests, fingerprint \`${fingerprint}\`.`,
    `Parsed by: ${Object.entries(adapterCounts).map(([name, count]) => `${name} (${count})`).join(", ") || "none"}.`,
    "",
    "## Headline",
    "",
    baseline === 0
      ? "Baseline spend could not be priced, so no saving is projected. See the unpriced models below."
      : [
        `- Measured baseline spend: **${usd(baseline)}**`,
        `- Projected saving: **${usd(totalSaving)} (${pct((totalSaving / baseline) * 100)})**`,
        `- Of which risk-free: **${usd(deterministic)} (${pct((deterministic / baseline) * 100)})**`,
      ].join("\n"),
    "",
    measurement.promptTextAvailable
      ? "Prompt text was available, so prefix-cache headroom is measured rather than assumed."
      : "Usage-only sample: no prompt text, so prefix-cache headroom could not be measured. " +
        "That is normally the largest risk-free lever, so this figure is a floor.",
    "",
    `Input already arriving cached across the sample: ${pct(measurement.alreadyCachedShare * 100)}. ` +
    "That saving is excluded from every projection here.",
    "",
    "## Measured and projected",
    "",
    "Measured values come from your sample. Projected savings apply published reduction factors to those " +
    "measured segments; they are a hypothesis to verify by replay, not a realised saving. Risk-free levers " +
    "(caching, dropping unused tools, schema minification, exact duplicate removal) send the same or provably " +
    "equivalent tokens, so the answer cannot change.",
    ...workloadLines(measurement, projections, repairs, showExamples),
    "",
    ...(measurement.unpricedModels.length > 0
      ? [
        "## Unpriced models",
        "",
        "Excluded from the baseline rather than counted as zero. Add dated catalogue entries to include them.",
        ...measurement.unpricedModels.map((model) => `- \`${model}\``),
        "",
      ]
      : []),
    ...(measurement.notes.length > 0 ? ["## Notes", "", ...measurement.notes.map((note) => `- ${note}`), ""] : []),
    ...(issues.length > 0
      ? [
        "## Rows that could not be read",
        "",
        ...issues.slice(0, 20).map((issue) => `- line ${issue.line}: ${issue.reason}`),
        ...(issues.length > 20 ? [`- ...and ${issues.length - 20} more`] : []),
        "",
      ]
      : []),
  ].join("\n");
}

export async function runAnalyse(argv: string[]): Promise<void> {
const args = parse(argv);
const rows = await readRows(args.inputs);
if (rows.length === 0) throw new Error("No rows were found in the supplied input.");

const ingested = ingestTraffic(
  args.workload === undefined
    ? rows
    : rows.map((row) => (typeof row === "object" && row !== null && !Array.isArray(row)
      ? { ...(row as Record<string, unknown>), workload: args.workload }
      : row)),
  args.date,
);
if (ingested.records.length === 0) {
  console.error(`Could not read any of the ${rows.length} rows. First problems:`);
  for (const issue of ingested.issues.slice(0, 5)) console.error(`  line ${issue.line}: ${issue.reason}`);
  process.exit(1);
}

const measurement = measureTraffic(ingested.records, publishedModelPrices);
const projections = new Map<string, SavingsProjection>();
const repairs = new Map<string, SavingsProjection>();
for (const workload of measurement.workloads) {
  // Price against the resolved catalogue key, not the raw logged identifier.
  if (workload.resolvedModel === undefined) continue;
  const price = lookupPrice(publishedModelPrices, {
    provider: workload.provider,
    model: workload.resolvedModel,
    at: args.date,
  });
  if (price.status === "unpriced") continue;
  const levers = leversFromMeasurement(workload);
  // Measured levers only: see leversFromMeasurement on why published factors
  // must not be applied blind to a customer's traffic.
  const profile = profileFromMeasurement(workload as WorkloadMeasurement);
  projections.set(workload.workload, projectSavings(profile, levers, price.price));
  const repaired = profileFromMeasurement(workload as WorkloadMeasurement, { repairPrefix: true });
  repairs.set(workload.workload, projectSavings(repaired, levers, price.price));
}

const fingerprint = trafficFingerprint(ingested.records);
const report = buildReport(
  measurement,
  projections,
  repairs,
  fingerprint,
  ingested.adapterCounts,
  ingested.issues,
  args.showExamples,
);
console.log(report);

if (args.json) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(args.json), { recursive: true });
  await writeFile(args.json, `${JSON.stringify({
    fingerprint,
    generatedFor: args.date,
    adapterCounts: ingested.adapterCounts,
    issues: ingested.issues,
    measurement,
    projections: Object.fromEntries(projections),
    withPrefixRepair: Object.fromEntries(repairs),
  }, null, 2)}\n`);
  console.log(`\nJSON report written to ${args.json}`);
}
if (args.markdown) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(args.markdown), { recursive: true });
  await writeFile(args.markdown, `${report}\n`);
  console.log(`Markdown report written to ${args.markdown}`);
}
}

// ---------------------------------------------------------------------------
// Entry dispatch: `mesh <command>`. `start` runs the proxy + Theo; `verify`
// re-proves the claims on this machine; `analyse` is the original report.
// ---------------------------------------------------------------------------
const TOP_USAGE = `mesh — cut your LLM bill, verified on your own usage.

Usage: mesh <command> [options]

  start      Start the MESH proxy, point Claude Code at it, and run Theo
             alongside you. One command; reverts cleanly on exit.
  install    Always-on: run MESH as a background service (launchd) so every
             Claude Code session is optimised, with nothing to start by hand.
  stop       Stop the background service (kept; resume with install).
  uninstall  Stop and remove the background service; restore Claude Code.
  status     Is the service up, and what has Theo saved so far?
  dashboard  Open a live local web view of your savings and what Theo is doing.
  theo       Run Theo now over your metered traffic: observe it, find savings,
             and update what he enforces, within your chosen autonomy level.
  update     Update the runtime now (--rollback to revert).
  verify     Re-prove MESH's claims on this machine: the build's provenance,
             your ledger's hash-chain, and a deterministic invoice recompute.
  doctor     Diagnose this machine (Node, proxy, Claude Code, service, ledger).
  version    Print the installed version and build.
  analyse    Measure a traffic log and report what a reduction is worth.
  compaction Estimate, per task in your ledger, what context compaction would
             save — and where it would cost more than it saves (advisory).

Run "mesh <command> --help" for command options.`;

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "start") {
    await (await import("./start.js")).runStart(process.argv.slice(3));
  } else if (sub === "serve") {
    await (await import("./start.js")).runServe(process.argv.slice(3));
  } else if (sub === "install") {
    await (await import("./daemon.js")).runInstall(process.argv.slice(3));
  } else if (sub === "uninstall") {
    (await import("./daemon.js")).runUninstall(process.argv.slice(3));
  } else if (sub === "stop") {
    (await import("./daemon.js")).runStop(process.argv.slice(3));
  } else if (sub === "status") {
    await (await import("./daemon.js")).runStatus(process.argv.slice(3));
  } else if (sub === "update") {
    await (await import("./update.js")).runUpdate(process.argv.slice(3));
  } else if (sub === "verify") {
    await (await import("./verify.js")).runVerify(process.argv.slice(3));
  } else if (sub === "doctor") {
    await (await import("./diag.js")).runDoctor(process.argv.slice(3));
  } else if (sub === "dashboard") {
    await (await import("./dashboard.js")).runDashboard(process.argv.slice(3));
  } else if (sub === "theo") {
    await (await import("./theo.js")).runTheo(process.argv.slice(3));
  } else if (sub === "version" || sub === "--version" || sub === "-v") {
    (await import("./diag.js")).runVersion(process.argv.slice(3));
  } else if (sub === "analyse" || sub === "analyze") {
    await runAnalyse(process.argv.slice(3));
  } else if (sub === "compaction") {
    await (await import("./compaction.js")).runCompaction(process.argv.slice(3));
  } else if (sub === undefined || sub === "--help" || sub === "-h") {
    console.log(TOP_USAGE);
  } else {
    // Back-compat: bare flags (e.g. `mesh --input x.jsonl`) still analyse.
    await runAnalyse(process.argv.slice(2));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
