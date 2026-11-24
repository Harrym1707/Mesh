/**
 * Bare `mesh`: what a person sees when they type the name and nothing else.
 *
 * Not the usage text (that is `mesh --help`): one line saying what this is,
 * whether anything is flowing and the one command that fixes it when not,
 * this month so far in money when there is a verified ledger with requests
 * in it, and where the dashboard, the report and the rest are.
 *
 * Reads the same status `mesh status` does, and the month-so-far line the
 * weekly report makes from the bill's own figures. Changes nothing; one local
 * health request; no other network call. `mesh --json` is `mesh status --json`.
 */
import { collectStatus, type StatusOptions, type StatusResult } from "./daemon.js";
import { flowLines } from "./flow.js";
import { collectReport } from "./report-command.js";

/**
 * "This month so far (November): saved $12.40, fee so far $0.12." from the
 * statement's own recompute, or null when there is nothing to put a figure on:
 * an empty ledger, or one that does not verify.
 */
export function monthSoFarLine(status: StatusResult, options: { meshHome?: string; now?: Date } = {}): string | null {
  if (status.ledger.empty || !status.ledger.chainVerified) return null;
  try {
    return collectReport({
      ledgerDir: status.ledger.path,
      ...(options.meshHome === undefined ? {} : { meshHome: options.meshHome }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }).monthLine;
  } catch {
    return null;
  }
}

/** The summary as text. Pure: the status and the month line are passed in. */
export function renderSummary(status: StatusResult, monthLine: string | null): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  Mesh ${status.mesh.version} (build ${status.mesh.build}): cuts your LLM bill and proves the saving on your own machine.`);
  lines.push("");
  for (const line of flowLines(status.flow)) lines.push(`  ${line}`);
  if (monthLine !== null) {
    lines.push("");
    lines.push(`  ${monthLine}`);
  }
  lines.push("");
  lines.push("  Dashboard      mesh dashboard");
  lines.push("  Weekly report  mesh report");
  lines.push("  Everything     mesh status");
  lines.push("");
  lines.push("  mesh --help for all commands");
  lines.push("");
  return lines.join("\n");
}

/** What the command reads besides its arguments. Tests point it away from the real home. */
export type SummaryOptions = StatusOptions;

export async function runSummary(options: SummaryOptions = {}): Promise<void> {
  const status = await collectStatus(options);
  const monthLine = monthSoFarLine(status, {
    ...(options.meshHome === undefined ? {} : { meshHome: options.meshHome }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  console.log(renderSummary(status, monthLine));
}
