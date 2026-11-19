import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startMeshProxy } from "../packages/sdk-js/src/proxy.js";
import {
  recomputeInvoice,
  verifyLedgerChain,
  type LedgerRecord,
} from "../packages/core/src/index.js";

/**
 * `mesh run` — the whole MESH experience in one command, zero code changes.
 *
 *   node --import tsx evals/mesh-run.ts [--ledger DIR] [--cache-ttl 5m|1h] -- <your start command>
 *   e.g.  node --import tsx evals/mesh-run.ts -- npm run dev
 *
 * What it does, so the app owner does nothing else:
 *   1. boots the MESH proxy on a free local port (lossless reduction by default),
 *   2. runs <your start command> with ANTHROPIC_BASE_URL / OPENAI_BASE_URL set to
 *      the proxy — the official Anthropic and OpenAI SDKs honour those env vars,
 *      so the app routes through MESH with NO edit to its code, keeping its own key,
 *   3. on exit (Ctrl-C), prints the measured savings from the recomputed ledger.
 *
 * The app's prompts and keys never leave the machine; MESH holds no credentials.
 */

const argv = process.argv.slice(2);
const splitAt = argv.indexOf("--");
if (splitAt === -1 || splitAt === argv.length - 1) {
  console.error("Usage: node --import tsx evals/mesh-run.ts [--ledger DIR] [--cache-ttl 5m|1h] -- <command> [args...]");
  console.error("Example: node --import tsx evals/mesh-run.ts -- npm run dev");
  process.exit(1);
}
const flags = argv.slice(0, splitAt);
const command = argv.slice(splitAt + 1);

let ledgerDirectory = join(process.cwd(), "mesh-ledger");
let cacheTtl: "5m" | "1h" | undefined;
for (let i = 0; i < flags.length; i += 2) {
  const flag = flags[i];
  const value = flags[i + 1];
  if (value === undefined) { console.error(`Missing value for ${flag}.`); process.exit(1); }
  if (flag === "--ledger") ledgerDirectory = value;
  else if (flag === "--cache-ttl") {
    if (value !== "5m" && value !== "1h") { console.error(`--cache-ttl must be 5m or 1h, got ${value}.`); process.exit(1); }
    cacheTtl = value;
  } else { console.error(`Unknown flag ${flag}.`); process.exit(1); }
}

mkdirSync(ledgerDirectory, { recursive: true });

function summarise(): void {
  let records: LedgerRecord[] = [];
  let spoolCount = 0;
  let broken = false;
  try {
    for (const name of readdirSync(ledgerDirectory)) {
      if (!name.endsWith(".jsonl")) continue;
      const lines = readFileSync(join(ledgerDirectory, name), "utf8").trim().split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) continue;
      spoolCount += 1;
      const spool = lines.map((line) => JSON.parse(line) as LedgerRecord);
      const chain = verifyLedgerChain(spool);
      if (!chain.ok) { broken = true; console.error(`  ledger ${name}: CHAIN BROKEN at seq ${chain.seq} (${chain.reason})`); }
      records = records.concat(spool);
    }
  } catch (error) {
    console.error(`  could not read ledger: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log("\n────────────────────────────────────────────────────");
  console.log("  MESH — savings this run");
  console.log("────────────────────────────────────────────────────");
  if (records.length === 0) {
    console.log("  0 requests were metered through MESH.");
    console.log("  If the app made model calls, its SDK may not read ANTHROPIC_BASE_URL /");
    console.log("  OPENAI_BASE_URL. Point its client baseURL at the proxy url printed above.");
    console.log("────────────────────────────────────────────────────\n");
    return;
  }
  const invoice = recomputeInvoice(records.map((r) => r.event), { feePercent: 1 });
  const saved = invoice.netVerifiedSavingsUsd;
  console.log(`  requests metered : ${invoice.eventsConsidered} (${spoolCount} spool${spoolCount === 1 ? "" : "s"})`);
  console.log(`  verified savings : $${saved.toFixed(4)}  [verdict: ${invoice.verdict}]`);
  if (invoice.amountDueCents !== undefined) {
    // The fee as billed: the recompute's whole cents (rounded down), never re-rounded here.
    console.log(`  MESH fee (1%)    : $${(invoice.amountDueCents / 100).toFixed(2)}`);
  }
  if (invoice.unpricedEvents > 0) console.log(`  (${invoice.unpricedEvents} request(s) excluded: no catalogued price)`);
  if (broken) console.log("  WARNING: a ledger chain failed verification — do not rely on the number above.");
  console.log(`\n  Recompute it yourself (the audit):`);
  console.log(`    node --import tsx evals/run-invoice.ts ${join(ledgerDirectory, "<spool>.jsonl")}`);
  console.log("────────────────────────────────────────────────────\n");
}

async function main(): Promise<void> {
  const proxy = await startMeshProxy({
    port: 0,
    ledgerDirectory,
    tokenReduction: {
      toolSchemas: true,
      duplicateContext: true,
      repairCachePrefix: true,
      ...(cacheTtl === undefined ? {} : { cacheTtl }),
    },
  });

  console.log(`\n  MESH proxy up on ${proxy.url} — reduction is lossless-only, your key passes through.`);
  console.log(`  Running: ${command.join(" ")}`);
  console.log(`  Ledger:  ${ledgerDirectory}`);
  console.log(`  (Ctrl-C to stop and see your savings.)\n`);

  const child = spawn(command[0]!, command.slice(1), {
    stdio: "inherit",
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: proxy.url,
      OPENAI_BASE_URL: `${proxy.url}/v1`,
    },
  });

  // Let the child own the terminal's Ctrl-C: it receives SIGINT from the process
  // group and exits; we keep the parent alive through that so we can summarise.
  // A second Ctrl-C force-kills a child that ignores the first.
  let interrupts = 0;
  process.on("SIGINT", () => {
    interrupts += 1;
    if (interrupts >= 2) child.kill("SIGKILL");
  });

  child.on("error", (error) => {
    console.error(`\n  could not start "${command[0]}": ${error.message}`);
  });

  await new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      void proxy.close().then(() => {
        summarise();
        process.exitCode = code ?? (signal ? 1 : 0);
        resolve();
      });
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
