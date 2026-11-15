/**
 * mesh-bill-worker — the unattended, per-account billing run.
 *
 * This is the operator-run mesh-bill promoted to an autonomous worker: it scans
 * every self-serve account, reads that account's hash-chained ledger spool,
 * verifies the chain, recomputes the invoice, and settles it through the
 * customer's chosen rail (direct-debit pull, or finalize+send for bank
 * transfer) — with ZERO human admin. Run it on a schedule.
 *
 * SAFETY RAILS (unchanged from mesh-bill):
 *   - TEST MODE only: createStripeClient refuses a live key; the worker never
 *     passes allowLive, so it can never auto-charge real money.
 *   - A broken/unverified ledger chain is a hard stop for that account.
 *   - Idempotency keys on customer+period+amount: a re-run never double-charges.
 *   - No prompt content is read — only usage-derived invoice totals.
 *
 * Usage:
 *   MESH_DATA_DIR=./.mesh-data MESH_STRIPE_TEST_SECRET_KEY=sk_test_... \
 *     node --import tsx scripts/mesh-bill-worker.ts --period 2026-10
 *   Flags: --mode advance_notice|charge (default charge), --period YYYY-MM,
 *          --account acct_… (one account), --dry-run (decide only, no Stripe).
 */
import { join } from "node:path";
import {
  createStripeClient,
  decideBilling,
  invoiceForAccount,
  openFileAccountStore,
  openFileLedgerStore,
  runAccountBilling,
  type Account,
} from "../packages/core/dist/src/index.js";

type Args = { period?: string; mode: "advance_notice" | "charge"; account?: string; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "charge", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--period") args.period = argv[++i];
    else if (a === "--mode") {
      const mode = argv[++i];
      if (mode !== "advance_notice" && mode !== "charge") throw new Error(`--mode must be advance_notice|charge, got ${mode}`);
      args.mode = mode;
    } else if (a === "--account") args.account = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown flag ${a}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = process.env.MESH_DATA_DIR ?? join(process.cwd(), ".mesh-data");
  const accounts = openFileAccountStore(join(dataDir, "accounts.json"));
  const ledger = openFileLedgerStore(join(dataDir, "ledger"));

  const key = process.env.MESH_STRIPE_TEST_SECRET_KEY ?? process.env.STRIPE_TEST_SECRET_KEY ?? "";
  const stripe = args.dryRun ? undefined : (key ? createStripeClient(key) : undefined);
  if (!args.dryRun && !stripe) {
    throw new Error("Set MESH_STRIPE_TEST_SECRET_KEY (test mode) to charge, or pass --dry-run to decide only.");
  }

  const targets: Account[] = args.account
    ? (accounts.get(args.account) ? [accounts.get(args.account)!] : [])
    : accounts.list();
  if (targets.length === 0) {
    console.log("No accounts to bill.");
    return;
  }

  console.log(`\nmesh-bill-worker · ${args.dryRun ? "DRY RUN" : `TEST mode (${stripe!.mode})`} · period ${args.period ?? "all"} · mode ${args.mode}\n`);

  for (const account of targets) {
    const records = ledger.readRecords(account.id);
    const { invoice, chainVerified } = invoiceForAccount(account, records, args.period);
    const label = `${account.githubLogin} (${account.id})`;

    if (args.dryRun) {
      const decision = decideBilling(account, invoice, chainVerified);
      if (decision.action === "skip") {
        console.log(`· ${label}: SKIP — ${decision.reason}`);
      } else {
        console.log(`· ${label}: WOULD BILL ${decision.amountCents} ${decision.currency} cents via ${decision.rail}` +
          `${chainVerified ? "" : " [CHAIN BROKEN — would be blocked]"}`);
      }
      continue;
    }

    try {
      const outcome = await runAccountBilling(stripe!, account, invoice, chainVerified, { mode: args.mode });
      if (outcome.status === "skipped") {
        console.log(`· ${label}: SKIP — ${outcome.reason}`);
      } else if (outcome.status === "noticed") {
        console.log(`· ${label}: NOTICE (${outcome.rail}) — upcoming $${(outcome.notice.amountDueCents / 100).toFixed(2)}; recompute: ${outcome.notice.recompute.command}`);
      } else {
        console.log(`· ${label}: BILLED ${outcome.amountCents} ${outcome.currency} cents via ${outcome.rail} — invoice ${outcome.invoiceId} (${outcome.invoiceStatus})` +
          `${outcome.hostedInvoiceUrl ? ` ${outcome.hostedInvoiceUrl}` : ""}`);
      }
    } catch (error) {
      console.error(`· ${label}: ERROR — ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
