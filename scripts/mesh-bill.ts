/**
 * mesh-bill — turn a customer's MESH ledger spool(s) into a Stripe invoice.
 *
 * Reads the spools, recomputes the invoice (pure, from the hash-chained ledger),
 * verifies the chain, builds the Stripe plan (packages/core/stripe-billing),
 * and — through the shared, hardened createStripeClient — creates the Stripe
 * objects: a one-off invoice item for the fee and a DRAFT invoice. Nothing is
 * charged: the invoice is left as a draft for a human to review and finalize in
 * the dashboard, unless --finalize is passed explicitly.
 *
 * SAFETY RAILS (deliberate, do not remove):
 *   - LIVE path goes through createStripeClient's sk_live_ guard (allowLive is
 *     granted ONLY when --live is passed) AND requires the operator to re-type
 *     the exact amount (--confirm-amount-cents) before any live charge. Without
 *     the matching re-type, a --live run charges nothing.
 *   - A broken/unverified ledger chain is a hard stop: DO NOT BILL.
 *   - Idempotency key on customer+period+amount: re-running a month is a no-op
 *     at Stripe, never a double charge.
 *   - No prompt content is read or sent — only the usage-derived invoice totals.
 *
 * Usage:
 *   STRIPE_TEST_SECRET_KEY=... node --import tsx scripts/mesh-bill.ts \
 *     --customer cus_XXX --period 2026-10 --fee 1 spool1.jsonl [spool2.jsonl ...]
 *   Optional: --finalize (finalize+send instead of leaving a draft),
 *             --label "acme-anthropic",
 *             --live --confirm-amount-cents <cents> (live charge, re-type gated).
 */
import { readFileSync } from "node:fs";
import {
  buildStripeInvoicePlan,
  checkLiveChargeConfirmation,
  createStripeClient,
  recomputeInvoice,
  verifyLedgerChain,
  type BillableEvent,
  type LedgerRecord,
} from "../packages/core/dist/src/index.js";

type Args = {
  customer?: string;
  period?: string;
  fee: number;
  label?: string;
  finalize: boolean;
  live: boolean;
  confirmAmountCents?: number;
  spools: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = { fee: 1, finalize: false, live: false, spools: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--customer") args.customer = argv[++i];
    else if (a === "--period") args.period = argv[++i];
    else if (a === "--fee") args.fee = Number(argv[++i]);
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--finalize") args.finalize = true;
    else if (a === "--live") args.live = true;
    else if (a === "--confirm-amount-cents") args.confirmAmountCents = Number(argv[++i]);
    else if (!a.startsWith("--")) args.spools.push(a);
    else throw new Error(`Unknown flag ${a}`);
  }
  return args;
}

function loadRecords(path: string): LedgerRecord[] {
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as LedgerRecord);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.STRIPE_TEST_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY ?? "";
  if (!key) throw new Error("Set STRIPE_TEST_SECRET_KEY (source ~/.config/mesh/stripe.env).");
  if (!args.customer) throw new Error("--customer cus_… is required.");
  if (args.spools.length === 0) throw new Error("Pass at least one ledger spool (.jsonl).");

  const isLive = key.startsWith("sk_live_");

  // One invoice across all spools for this customer/period.
  const allEvents: BillableEvent[] = [];
  let chainVerified = true;
  for (const path of args.spools) {
    const records = loadRecords(path);
    const chain = verifyLedgerChain(records);
    if (!chain.ok) {
      chainVerified = false;
      console.error(`CHAIN BROKEN in ${path}: ${chain.reason} (seq ${chain.seq})`);
    }
    for (const record of records) allEvents.push(record.event);
  }

  const invoice = recomputeInvoice(allEvents, {
    ...(args.period ? { period: args.period } : {}),
    feePercent: args.fee,
  });

  const plan = buildStripeInvoicePlan(invoice, chainVerified, {
    stripeCustomerId: args.customer,
    mode: args.finalize ? "finalize" : "draft",
    ...(args.label ? { customerLabel: args.label } : {}),
  });

  console.log(`\nMode: ${isLive ? "LIVE" : "TEST"}  ·  period: ${args.period ?? "all"}  ·  fee: ${args.fee}%`);
  console.log(`Net verified savings: $${invoice.netVerifiedSavingsUsd.toFixed(4)}  ·  verdict: ${invoice.verdict}`);

  if (plan.action === "do_not_bill") {
    console.log(`\nDO NOT BILL — ${plan.reason}`);
    if (plan.chainUnverified) process.exitCode = 1;
    return;
  }

  // LIVE human gate (Fix 6): require --live AND a matching amount re-type before
  // any live charge. Enforced here, BEFORE the Stripe client is even created, so
  // a live run without the correct re-type charges nothing.
  const gate = checkLiveChargeConfirmation({
    isLive,
    requestedLive: args.live,
    amountCents: plan.amountCents,
    ...(args.confirmAmountCents === undefined ? {} : { confirmAmountCents: args.confirmAmountCents }),
  });
  if (!gate.ok) {
    console.error(`\nREFUSING TO CHARGE — ${gate.reason}`);
    process.exitCode = 1;
    return;
  }

  // Route through the shared client. allowLive is granted only once the gate
  // above has passed, so the sk_live_ guard still protects every other path.
  const stripe = createStripeClient(key, { allowLive: isLive });

  console.log(`\nWill create (draft=${!plan.finalize}): ${plan.amountCents} ${plan.currency} cents to ${plan.customerId}`);
  console.log(`  "${plan.description}"`);

  // Create the draft invoice FIRST, then attach the fee item to it explicitly
  // by id. (Relying on Stripe to auto-sweep pending items into a draft is
  // unreliable with auto_advance=false — it leaves an empty invoice.)
  const inv = await stripe.createInvoice({
    customerId: plan.customerId,
    currency: plan.currency, // match the fee currency; the account default may differ (e.g. GBP)
    collectionMethod: "charge_automatically",
    autoAdvance: false, // never let the draft advance to payment on its own
    description: `MESH statement ${plan.metadata.mesh_period ?? ""}`,
    idempotencyKey: `${plan.idempotencyKey}-inv`,
  });

  await stripe.createInvoiceItem({
    customerId: plan.customerId,
    invoiceId: inv.id, // explicit attachment — the fix for the empty-draft bug
    amountCents: plan.amountCents,
    currency: plan.currency,
    description: plan.description,
    metadata: {
      mesh_period: plan.metadata.mesh_period ?? "",
      mesh_fee_percent: plan.metadata.mesh_fee_percent ?? "",
      mesh_net_verified_savings_usd: plan.metadata.mesh_net_verified_savings_usd ?? "",
    },
    idempotencyKey: `${plan.idempotencyKey}-item`,
  });

  console.log(`\nCreated Stripe invoice ${inv.id} — status ${inv.status} (${isLive ? "LIVE" : "TEST"} mode).`);
  if (plan.finalize) {
    const final = await stripe.finalizeInvoice(inv.id, `${plan.idempotencyKey}-fin`);
    console.log(`Finalized: status ${final.status}, hosted at ${final.hosted_invoice_url ?? "(none)"}`);
  } else {
    console.log("Left as a DRAFT. Review it in the Stripe dashboard and finalize there, or re-run with --finalize.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
