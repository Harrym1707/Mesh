/**
 * mesh-bill-worker — the unattended, per-account billing run.
 *
 * This is the operator-run mesh-bill promoted to an autonomous worker: it reads
 * each self-serve account's hash-chained ledger spool, verifies the chain,
 * recomputes the invoice for ONE explicit period, and settles it through the
 * customer's chosen rail (direct-debit pull, or finalize+send for bank
 * transfer) — with ZERO human admin, but every money-safety rail intact.
 *
 * SAFETY RAILS:
 *   - TEST MODE only: createStripeClient refuses a live key; the worker never
 *     passes allowLive, so it can never auto-charge real money.
 *   - A broken/unverified ledger chain is a hard stop for that account.
 *   - MANDATORY period: --period is REQUIRED for any charging run. Without it
 *     the worker refuses to run and charges nothing — it never bills a growing
 *     cumulative total.
 *   - Persistent idempotency: a durable per-account, per-period billed-record
 *     means a period charged once is never charged again.
 *   - Direct-debit pulls are bounded by a max-charge ceiling and gated on a
 *     prior advance-notice step.
 *   - Fees are offset by a persisted carry-forward deficit.
 *   - Savings are re-derived from provider-verbatim usage at bill time.
 *   - No prompt content is read — only usage-derived invoice totals.
 *
 * Usage:
 *   MESH_DATA_DIR=./.mesh-data MESH_STRIPE_TEST_SECRET_KEY=sk_test_... \
 *     node --import tsx scripts/mesh-bill-worker.ts --period 2026-10
 *   Flags: --period YYYY-MM (REQUIRED), --mode advance_notice|charge (default
 *          charge), --account acct_… (one account), --dry-run (decide only, no
 *          Stripe), --max-charge-cents N (ceiling; default 50000).
 */
import { join } from "node:path";
import {
  DEFAULT_MAX_CHARGE_CENTS,
  createStripeClient,
  decideBilling,
  invoiceForAccount,
  openFileAccountStore,
  openFileLedgerStore,
  publishedModelPrices,
  reconcileInvoiceSavings,
  settleAccountBilling,
  type Account,
} from "../packages/core/dist/src/index.js";

type Args = {
  period?: string;
  mode: "advance_notice" | "charge";
  account?: string;
  dryRun: boolean;
  maxChargeCents: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "charge", dryRun: false, maxChargeCents: DEFAULT_MAX_CHARGE_CENTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--period") args.period = argv[++i];
    else if (a === "--mode") {
      const mode = argv[++i];
      if (mode !== "advance_notice" && mode !== "charge") throw new Error(`--mode must be advance_notice|charge, got ${mode}`);
      args.mode = mode;
    } else if (a === "--account") args.account = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--max-charge-cents") {
      const cents = Number(argv[++i]);
      if (!Number.isInteger(cents) || cents <= 0) throw new Error("--max-charge-cents must be a positive integer.");
      args.maxChargeCents = cents;
    } else throw new Error(`Unknown flag ${a}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // MANDATORY period (Fix 2): refuse to run a charging/notice pass over "all
  // recorded periods". An explicit period is the only thing that stops a re-run
  // re-charging the growing cumulative total.
  if (args.period === undefined || args.period.trim() === "") {
    throw new Error(
      "--period YYYY-MM is REQUIRED. The worker bills one explicit period at a time; " +
      "it will not charge the cumulative total of all recorded periods.",
    );
  }

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

  console.log(`\nmesh-bill-worker · ${args.dryRun ? "DRY RUN" : `TEST mode (${stripe!.mode})`} · period ${args.period} · mode ${args.mode} · ceiling ${args.maxChargeCents}¢\n`);

  for (const account of targets) {
    const records = ledger.readRecords(account.id);
    const label = `${account.githubLogin} (${account.id})`;

    if (args.dryRun) {
      const { invoice, chainVerified } = invoiceForAccount(account, records, args.period);
      const recon = reconcileInvoiceSavings(records.map((r) => r.event), publishedModelPrices, { period: args.period });
      const prior = accounts.getBilledPeriod(account.id, args.period);
      const decision = decideBilling(account, invoice, chainVerified, {
        mode: args.mode,
        maxChargeCents: args.maxChargeCents,
        savingsCheck: { ok: recon.ok, ...(recon.reason === undefined ? {} : { reason: recon.reason }) },
        advanceNoticeIssued: prior?.advanceNoticeAt !== undefined,
        ...(prior === undefined ? {} : { priorBilling: prior }),
      });
      if (decision.action === "skip") console.log(`· ${label}: SKIP — ${decision.reason}`);
      else if (decision.action === "already_billed") console.log(`· ${label}: ALREADY BILLED — ${decision.reason}`);
      else if (decision.action === "hold") console.log(`· ${label}: HOLD — ${decision.reason}`);
      else console.log(`· ${label}: WOULD BILL ${decision.amountCents} ${decision.currency} cents via ${decision.rail}`);
      continue;
    }

    try {
      const outcome = await settleAccountBilling(stripe!, accounts, account, records, args.period, {
        mode: args.mode,
        maxChargeCents: args.maxChargeCents,
        catalogue: publishedModelPrices,
      });
      if (outcome.status === "skipped") console.log(`· ${label}: SKIP — ${outcome.reason}`);
      else if (outcome.status === "already_billed") console.log(`· ${label}: ALREADY BILLED — ${outcome.reason}`);
      else if (outcome.status === "held") console.log(`· ${label}: HOLD — ${outcome.reason} (${outcome.amountCents}¢)`);
      else if (outcome.status === "noticed") {
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
