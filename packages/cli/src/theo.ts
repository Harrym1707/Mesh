/**
 * `mesh theo` — run one cycle of the autonomous token-engineer agent against the
 * traffic this machine has already seen, and persist what Theo learned.
 *
 * It reads two things the proxy already writes to the ledger directory:
 *   - the blind-feature spools (`*.features.jsonl`) — irreversible structure,
 *     never prompt content — which Theo folds into a workload profile (OBSERVE);
 *   - the ledger spools (`*.jsonl`) — provider-verbatim usage — for the mean
 *     output size and the realised, verified savings shown in the report.
 *
 * Theo then hypothesises, decides within his autonomy level, and saves his
 * memory beside the ledger. With `--gate <capture>` he also PROVES the queued
 * lossy levers: a sample of your own requests is replayed both ways against the
 * provider, and the measured saving and quality decide whether a lever is
 * proposed (recommend/test) or applied (optimise). Without `--gate` he only
 * queues them — the pure cycle never invents a proof.
 *
 * The feature spools and the ledger never leave your machine, and the gate
 * replays your captured requests with your own key; nothing is uploaded.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  lookupPrice,
  publishedModelPrices,
  recomputeInvoice,
  resolveModelId,
  verifyLedgerChain,
  type BillableEvent,
  type LedgerRecord,
  type TokenPrice,
} from "../../core/src/index.js";
import type { BlindFeatures } from "../../sdk-js/src/blind-features.js";
import {
  createTheoMemory,
  observeWorkload,
  runTheoCycle,
  type TheoAutonomyLevel,
} from "../../sdk-js/src/theo-agent.js";
import {
  defaultTheoMemoryPath,
  loadTheoMemory,
  saveTheoMemory,
} from "../../sdk-js/src/theo-agent-store.js";
import { proveCandidates } from "../../sdk-js/src/theo-gate.js";

const USAGE = `Usage: mesh theo [options]

  Run one cycle of Theo, the autonomous token-engineer, over the traffic MESH has
  already metered on this machine, and save what he learned.

  --autonomy <level>  observe | recommend | test | optimise. Default: recommend.
                        observe   — find opportunities, change nothing.
                        recommend — apply lossless; propose proven lossy levers.
                        test      — also queue the next lossy levers to prove.
                        optimise  — auto-apply a lossy lever once it is proven.
  --customer <id>     Which environment's memory to use. Default: local.
  --ledger <dir>      Ledger directory to read. Default ~/.mesh/ledger.
  --gate <file>       Prove the queued lossy levers by replaying this JSONL
                        sample of your OWN requests through the provider. Each
                        line is a request, or {"request":...,"response":...}.
                        Needs ANTHROPIC_API_KEY / OPENAI_API_KEY, or --provider-url.
  --provider-url <u>  Send replay calls here instead of the provider's default
                        endpoint (e.g. a local mock, or your running proxy).
  --max-samples <n>   Cap how many captured requests to replay. Default 20.
  --help              Show this message.

Theo never enables a saving he has not proven on your own traffic within your
quality ceiling. Without --gate, lossy levers are only proposed or queued; with
it, a proven lever is proposed (recommend/test) or applied (optimise).`;

const AUTONOMY_LEVELS: readonly TheoAutonomyLevel[] = ["observe", "recommend", "test", "optimise"];

type Args = {
  autonomy?: TheoAutonomyLevel;
  customer: string;
  ledgerDir: string;
  gate?: string;
  providerUrl?: string;
  maxSamples: number;
};

function parse(argv: string[]): Args {
  const args: Args = { customer: "local", ledgerDir: join(homedir(), ".mesh", "ledger"), maxSamples: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--help" || key === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value.`);
    index += 1;
    switch (key) {
      case "--autonomy": {
        if (!(AUTONOMY_LEVELS as readonly string[]).includes(value)) {
          throw new Error(`--autonomy must be one of: ${AUTONOMY_LEVELS.join(", ")}.`);
        }
        args.autonomy = value as TheoAutonomyLevel;
        break;
      }
      case "--customer": args.customer = value; break;
      case "--ledger": args.ledgerDir = resolve(value); break;
      case "--gate": args.gate = resolve(value); break;
      case "--provider-url": args.providerUrl = value; break;
      case "--max-samples": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new Error("--max-samples must be a positive integer.");
        args.maxSamples = n;
        break;
      }
      default: throw new Error(`Unknown option: ${key}. See --help.`);
    }
  }
  return args;
}

/** Read the blind-feature spools into the features Theo observes. */
function readFeatures(ledgerDir: string): BlindFeatures[] {
  const files = readdirSync(ledgerDir).filter((file) => file.endsWith(".features.jsonl"));
  const features: BlindFeatures[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(ledgerDir, file), "utf8").trim().split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        const record = JSON.parse(line) as { features?: BlindFeatures };
        if (record.features && typeof record.features === "object") features.push(record.features);
      } catch {
        // A malformed feature line is skipped; it can never affect correctness.
      }
    }
  }
  return features;
}

/** Read the chain-verified ledger events (tampered spools excluded). */
function readLedgerEvents(ledgerDir: string): BillableEvent[] {
  const files = readdirSync(ledgerDir).filter(
    (file) => file.endsWith(".jsonl") && !file.endsWith(".features.jsonl"),
  );
  const events: BillableEvent[] = [];
  for (const file of files) {
    const records: LedgerRecord[] = [];
    for (const line of readFileSync(join(ledgerDir, file), "utf8").trim().split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try { records.push(JSON.parse(line) as LedgerRecord); } catch { /* skip */ }
    }
    if (records.length === 0) continue;
    if (!verifyLedgerChain(records).ok) continue; // never fold a broken chain into the number
    for (const record of records) events.push(record.event);
  }
  return events;
}

/** The most frequent (provider, model) across the sample — the price to rank by. */
function dominantModel(features: readonly BlindFeatures[]): { provider: string; model: string } {
  const counts = new Map<string, number>();
  for (const f of features) counts.set(`${f.provider}|${f.model}`, (counts.get(`${f.provider}|${f.model}`) ?? 0) + 1);
  let best = "";
  let bestCount = -1;
  for (const [key, count] of counts) if (count > bestCount) { best = key; bestCount = count; }
  const [provider = "unknown", model = "unknown"] = best.split("|");
  return { provider, model };
}

/** Resolve a raw model id to its catalogue price, or undefined if unpriced. */
function lookupResolved(provider: string, rawModelId: string, at: string): TokenPrice | undefined {
  if (provider !== "anthropic" && provider !== "openai") return undefined;
  const resolved = resolveModelId(publishedModelPrices, provider, rawModelId);
  if (resolved.status !== "resolved") return undefined;
  const found = lookupPrice(publishedModelPrices, { provider, model: resolved.model, at });
  return found.status === "unpriced" ? undefined : found.price;
}

/** A price to rank candidates by. Falls back to the Sonnet 5.5 rate for an
 * unpriced model — used only for ORDERING hypotheses, never to bill anything. */
function priceForRanking(provider: string, model: string, at: string): { price: TokenPrice; note?: string } {
  const direct = lookupResolved(provider, model, at);
  if (direct) return { price: direct };
  const fallback = lookupResolved("anthropic", "claude-sonnet-5-5", at);
  if (!fallback) throw new Error("No catalogue price available to rank candidates.");
  return { price: fallback, note: `${provider}/${model} is unpriced; ranked using the Sonnet 5.5 rate (ordering only).` };
}

function meanOutputTokens(events: readonly BillableEvent[]): number {
  const outputs = events.map((event) => event.usage?.outputTokens ?? 0).filter((value) => value > 0);
  if (outputs.length === 0) return 0;
  return outputs.reduce((sum, value) => sum + value, 0) / outputs.length;
}

type Capture = { requests: unknown[]; baselineResponses?: unknown[] };

/** Read a replay capture: each line is a request, or {request, response?}. When
 * every row carries a response, they are returned as recorded baselines so the
 * baseline run need not be paid for again. */
function readCapture(path: string, maxSamples: number): Capture {
  const requests: unknown[] = [];
  const responses: unknown[] = [];
  let everyRowHasResponse = true;
  for (const line of readFileSync(path, "utf8").trim().split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (requests.length >= maxSamples) break;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row !== null && typeof row === "object" && !Array.isArray(row) && "request" in (row as Record<string, unknown>)) {
      const record = row as Record<string, unknown>;
      requests.push(record.request);
      if (record.response !== undefined) responses.push(record.response);
      else everyRowHasResponse = false;
    } else {
      requests.push(row);
      everyRowHasResponse = false;
    }
  }
  return everyRowHasResponse && responses.length === requests.length && requests.length > 0
    ? { requests, baselineResponses: responses }
    : { requests };
}

/** The provider call the gate replays through: POST the request, return the JSON.
 * Uses --provider-url when given (a local mock or your proxy), else the provider
 * default endpoint, with the key read from the environment. */
function makeProviderCall(provider: string, providerUrl: string | undefined): (request: unknown) => Promise<unknown> {
  const anthropic = provider !== "openai";
  const url = providerUrl ?? (anthropic
    ? "https://api.anthropic.com/v1/messages"
    : "https://api.openai.com/v1/chat/completions");
  const key = anthropic ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  return async (request: unknown): Promise<unknown> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (anthropic) {
      if (key) headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(request) });
    if (!response.ok) throw new Error(`provider replied ${response.status}`);
    return response.json();
  };
}

export async function runTheo(argv: string[]): Promise<void> {
  const args = parse(argv);
  const now = new Date().toISOString();
  const at = now.slice(0, 10);

  if (!existsSync(args.ledgerDir)) {
    console.log(`No ledger at ${args.ledgerDir} yet — run \`mesh start\` and use Claude Code, then run \`mesh theo\` again.`);
    return;
  }

  const features = readFeatures(args.ledgerDir);
  if (features.length === 0) {
    console.log(`No traffic observed yet in ${args.ledgerDir} — Theo needs some requests to learn from.`);
    console.log("Run `mesh start`, use Claude Code for a bit, then run `mesh theo` again.");
    return;
  }

  const events = readLedgerEvents(args.ledgerDir);
  const { provider, model } = dominantModel(features);
  const { price, note } = priceForRanking(provider, model, at);
  const profile = observeWorkload(features, {
    name: `${provider}/${model}`,
    outputTokensMean: meanOutputTokens(events),
  });

  const invoice = events.length > 0 ? recomputeInvoice(events, { feePercent: 1 }) : undefined;
  const memoryPath = defaultTheoMemoryPath(args.ledgerDir, args.customer);
  const existing = loadTheoMemory(memoryPath);
  const autonomy: TheoAutonomyLevel = args.autonomy ?? existing?.autonomy ?? "recommend";
  const memory = existing
    ? { ...existing, autonomy }
    : createTheoMemory(args.customer, autonomy, now);

  const observation = {
    profile,
    price,
    ...(invoice ? { realisedSavingsUsd: invoice.netVerifiedSavingsUsd } : {}),
  };

  // Prove the queued lossy levers if a replay capture was supplied. A dry cycle
  // first tells us which levers are queued; those are proven on the sample, and
  // the real cycle below then decides what to do with the proofs.
  let proofs: Awaited<ReturnType<typeof proveCandidates>>["proofs"] = [];
  let gateSummary: string | undefined;
  if (args.gate) {
    const { requests, baselineResponses } = readCapture(args.gate, args.maxSamples);
    const haveKey = (provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY) !== undefined;
    if (requests.length === 0) {
      gateSummary = `No requests found in ${args.gate}; nothing to prove.`;
    } else if (!args.providerUrl && !haveKey) {
      gateSummary = "Set ANTHROPIC_API_KEY / OPENAI_API_KEY, or pass --provider-url, to run the gate.";
    } else {
      const queued = runTheoCycle(memory, { observation }, now).memory.hypotheses.map((h) => h.lever);
      if (queued.length === 0) {
        gateSummary = "No queued lossy levers to prove.";
      } else {
        const proven = await proveCandidates({
          levers: queued,
          requests,
          call: makeProviderCall(provider, args.providerUrl),
          price,
          maximumQualityDrop: memory.policy.qualityCeilingPercent / 100,
          ...(baselineResponses ? { baselineResponses } : {}),
          now,
        });
        proofs = proven.proofs;
        const bits = [`replayed ${requests.length} request(s) in ${proven.calls} provider call(s)`];
        if (proven.proofs.length > 0) bits.push(`proved: ${proven.proofs.map((p) => p.lever).join(", ")}`);
        for (const rejection of proven.rejections) bits.push(`rejected ${rejection.lever}: ${rejection.reason}`);
        gateSummary = bits.join("\n  ");
      }
    }
  }

  const result = runTheoCycle(memory, { observation, proofs }, now);

  saveTheoMemory(memoryPath, result.memory);

  console.log(result.report);
  if (note) console.log(`\nNote: ${note}`);
  if (gateSummary) console.log(`\nGate:\n  ${gateSummary}`);

  const gate = result.actions.find((action) => action.kind === "gate-requested");
  if (!args.gate && gate && gate.kind === "gate-requested") {
    console.log(`\nQueued to prove (re-run with --gate <capture> to prove them): ${gate.levers.join(", ")}.`);
  }
  if (result.memory.proposals.length > 0) {
    console.log("\nProposals awaiting your approval:");
    for (const proposal of result.memory.proposals) console.log(`  - ${proposal.message}`);
  }
  console.log(`\nMemory saved to ${memoryPath}`);
}
