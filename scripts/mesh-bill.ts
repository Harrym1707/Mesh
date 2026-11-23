/**
 * mesh-bill — turn a customer's MESH ledger spool(s) into a Stripe invoice.
 *
 * Reads the spools, recomputes the invoice (pure, from the hash-chained ledger),
 * verifies the chain, builds the Stripe plan (packages/core/stripe-billing),
 * and — through the shared, hardened createStripeClient — creates the Stripe
 * objects: a DRAFT invoice and a one-off invoice item for the fee. Nothing is
 * charged: the invoice is left as a draft for a human to review and send from
 * the dashboard, unless --finalize is passed explicitly.
 *
 * The draft is a SEND-AN-INVOICE draft (collection_method=send_invoice with
 * days_until_due, default 14 — the same request the billing worker's
 * bank-transfer rail makes): the customer is sent an invoice and pays it
 * themselves. This script never asks Stripe to collect from a saved payment
 * method.
 *
 * SAFETY RAILS (deliberate, do not remove):
 *   - LIVE path goes through createStripeClient's sk_live_ guard (allowLive is
 *     granted ONLY when --live is passed) AND requires the operator to re-type
 *     the exact amount (--confirm-amount-cents) before any live charge. Without
 *     the matching re-type, a --live run charges nothing.
 *   - A broken/unverified ledger chain is a hard stop: DO NOT BILL.
 *   - MANDATORY period: --period YYYY-MM is required. Without it the script
 *     refuses to run, so it can never bill the cumulative total of every
 *     recorded period in the spool.
 *   - Idempotency key on customer+period+amount: re-running the same month for
 *     the same amount is a no-op at Stripe while Stripe still holds the key
 *     (about 24 hours). This script keeps NO durable billed-record: a re-run
 *     after that, or for a different amount, creates a second draft. Check the
 *     dashboard for an existing invoice for the period before finalizing.
 *   - --dry-run reads NO Stripe key and never creates the Stripe client: it
 *     verifies, recomputes, prints exactly what would be created, and exits.
 *     Run it first, every time.
 *   - A real run REQUIRES --statement <file>: the customer's own sealed
 *     `mesh statement` file for the period. Before any Stripe client exists the
 *     script checks its seal, that it is a closed-period statement valid for
 *     billing, that the spools passed are exactly the spools it was computed
 *     from (by head hash and record counts: this is what catches a missing
 *     spool or a cut-off tail, which still verify as a chain), and that its
 *     net savings and fee in cents equal this script's own recompute. Any
 *     mismatch is DO NOT BILL, exit 1, nothing sent. A dry run without it
 *     still works and warns that a real run will need it.
 *   - The statement must be the CUSTOMER'S OWN, and the script checks that it
 *     is: a real run REQUIRES --customer-key <fingerprint>, the statement key
 *     fingerprint the customer registered when billing was agreed (they print
 *     it with `mesh statement --key`). The statement's signature must verify
 *     and must be by exactly that key. A statement with no signature (release
 *     0.2.4 wrote those), one whose signature does not verify, and one signed
 *     by any other key are each DO NOT BILL. So is a statement signed by THIS
 *     machine's own Mesh install (~/.mesh/identity/statement-key.json, when
 *     there is one), in a dry run too: that statement was written here, from
 *     whatever files arrived, and matches them trivially. A dry run without
 *     --customer-key warns, and still says which key signed the statement.
 *     What this does not do: it does not show the customer's ledger was
 *     complete on their machine, it is only as good as the channel the
 *     fingerprint was registered through, and it does not stop an operator
 *     who bypasses this script.
 *   - A real run refuses a period that has not ended yet in UTC; a dry run
 *     prints the same sentence as a warning and carries on. There is
 *     deliberately no flag or environment variable to override the clock.
 *   - The checks themselves are pure and unit-tested in
 *     packages/core/src/manual-billing-checks.ts; this script only calls them.
 *   - No prompt content is read or sent — only the usage-derived invoice totals.
 *
 * Usage:
 *   node --import tsx scripts/mesh-bill.ts --dry-run \
 *     --customer cus_XXX --period 2026-10 --fee 1 spool1.jsonl [spool2.jsonl ...]
 *   STRIPE_TEST_SECRET_KEY=... node --import tsx scripts/mesh-bill.ts \
 *     --customer cus_XXX --period 2026-10 --fee 1 \
 *     --statement mesh-statement-2026-10.json --customer-key <fingerprint> \
 *     spool1.jsonl [spool2.jsonl ...]
 *   Required: --customer cus_…, --period YYYY-MM, at least one spool, and
 *             --statement <file> with --customer-key <fingerprint> unless
 *             --dry-run.
 *   Optional: --dry-run (no key needed, nothing sent to Stripe),
 *             --days-until-due <n> (payment terms on the invoice, default 14),
 *             --finalize (finalize instead of leaving a draft),
 *             --label "acme-anthropic",
 *             --live --confirm-amount-cents <cents> (live charge, re-type gated).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  STATEMENT_KEY_DIR,
  STATEMENT_KEY_FILE,
  buildStripeInvoicePlan,
  checkLiveChargeConfirmation,
  checkPeriodEnded,
  checkStatementForBilling,
  createStripeClient,
  describeBillSpool,
  isLiveStripeKey,
  isStatementKeyFingerprint,
  parseStatementKeyFile,
  recomputeInvoice,
  verifyLedgerChain,
  type BillSpool,
  type BillableEvent,
  type LedgerRecord,
} from "../packages/core/dist/src/index.js";

type Args = {
  customer?: string;
  period?: string;
  /** The customer's own `mesh statement` file for the period. Required unless --dry-run. */
  statement?: string;
  /** The statement key fingerprint the customer registered. Required with --statement unless --dry-run. */
  customerKey?: string;
  fee: number;
  label?: string;
  finalize: boolean;
  live: boolean;
  dryRun: boolean;
  daysUntilDue: number;
  confirmAmountCents?: number;
  spools: string[];
};

/** Payment terms on the sent invoice; the billing worker's bank-transfer rail uses the same default. */
const DEFAULT_DAYS_UNTIL_DUE = 14;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    fee: 1,
    finalize: false,
    live: false,
    dryRun: false,
    daysUntilDue: DEFAULT_DAYS_UNTIL_DUE,
    spools: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--customer") args.customer = argv[++i];
    else if (a === "--period") args.period = argv[++i];
    else if (a === "--statement") args.statement = argv[++i];
    else if (a === "--customer-key") args.customerKey = argv[++i];
    else if (a === "--fee") args.fee = Number(argv[++i]);
    else if (a === "--label") args.label = argv[++i];
    else if (a === "--finalize") args.finalize = true;
    else if (a === "--live") args.live = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--days-until-due") args.daysUntilDue = Number(argv[++i]);
    else if (a === "--confirm-amount-cents") args.confirmAmountCents = Number(argv[++i]);
    else if (!a.startsWith("--")) args.spools.push(a);
    else throw new Error(`Unknown flag ${a}`);
  }
  return args;
}

/**
 * Read one spool. A line that is not JSON, or not a ledger record at all, is a
 * hard stop with a plain message: a spool that cannot be read end to end is in
 * the same position as one whose chain is broken.
 */
function loadRecords(path: string): LedgerRecord[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`DO NOT BILL — ${path}: line ${index + 1} is not valid JSON, so the spool cannot be verified.`);
    }
    const event = (parsed as { event?: unknown } | null)?.event;
    if (typeof event !== "object" || event === null) {
      throw new Error(
        `DO NOT BILL — ${path}: line ${index + 1} is not a ledger record. Pass only ledger spools ` +
        "(<application>-<provider>.jsonl).",
      );
    }
    return parsed as LedgerRecord;
  });
}

/**
 * The fingerprint of the statement key of the Mesh install on THIS machine, if
 * it has one: the same file `mesh statement` signs with (~/.mesh/identity/
 * statement-key.json). Only the fingerprint is taken from it; nothing from the
 * file is printed. A file that is there but cannot be read is a hard stop: the
 * check it feeds could not be made.
 */
function operatorKeyFingerprint(): string | undefined {
  const path = join(homedir(), ".mesh", STATEMENT_KEY_DIR, STATEMENT_KEY_FILE);
  if (!existsSync(path)) return undefined;
  try {
    return parseStatementKeyFile(readFileSync(path, "utf8")).fingerprint;
  } catch (error) {
    throw new Error(
      `DO NOT BILL — this machine's own statement key file (${path}) could not be read as a statement key ` +
      `(${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message : "unreadable"}), so the bill ` +
      "cannot rule out that the statement was written on this machine.",
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // A dry run never reads a Stripe key: with no key in hand there is nothing it
  // could send. Everything below that touches Stripe is behind `!args.dryRun`.
  const key = args.dryRun ? "" : (process.env.STRIPE_TEST_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY ?? "");
  if (!args.dryRun && !key) {
    throw new Error(
      "Set STRIPE_TEST_SECRET_KEY (source ~/.config/mesh/stripe.env), or pass --dry-run to see what " +
      "would be created without any key.",
    );
  }
  if (!args.customer) throw new Error("--customer cus_… is required.");
  if (args.spools.length === 0) throw new Error("Pass at least one ledger spool (.jsonl).");
  // MANDATORY period: one invoice settles ONE explicit calendar month. Billing
  // "everything in the spool" would re-bill earlier months on every later run.
  if (args.period === undefined || !/^\d{4}-(0[1-9]|1[0-2])$/.test(args.period)) {
    throw new Error(
      "--period YYYY-MM is REQUIRED (for example --period 2026-10). mesh-bill invoices one explicit " +
      "period at a time; it will not bill the cumulative total of all recorded periods.",
    );
  }
  const period = args.period;
  if (!Number.isInteger(args.daysUntilDue) || args.daysUntilDue < 1) {
    throw new Error("--days-until-due must be a whole number of days, 1 or more (default 14).");
  }

  // A real run bills only against the customer's own statement for the period.
  // Refused here, before any spool is read and long before a Stripe client exists.
  if (!args.dryRun && args.statement === undefined) {
    throw new Error(
      "DO NOT BILL — a real run needs --statement <file>: the customer's own `mesh statement` file for " +
      `period ${period}. The spools passed are checked against it before anything is sent. ` +
      "(--dry-run works without one.)",
    );
  }
  if (args.dryRun && args.statement === undefined) {
    console.log(
      "WARNING — no --statement was given. A real run will refuse to bill without the customer's own " +
      `\`mesh statement\` file for period ${period}.`,
    );
  }

  // The statement must be the customer's own: signed by the statement key whose
  // fingerprint they registered when billing was agreed. A fingerprint is public
  // (neither it nor the key it names is a secret), so it is safe on a command line.
  const customerKey = args.customerKey?.trim().toLowerCase();
  if (args.customerKey !== undefined && !isStatementKeyFingerprint(customerKey)) {
    throw new Error(
      "DO NOT BILL — --customer-key is not a statement key fingerprint. It is the 64 hexadecimal characters the " +
      "customer's `mesh statement --key` prints, as recorded when billing was agreed.",
    );
  }
  if (!args.dryRun && customerKey === undefined) {
    throw new Error(
      "DO NOT BILL — a real run needs --customer-key <fingerprint>: the statement key fingerprint the customer " +
      "registered when billing was agreed (their `mesh statement --key` prints it). The statement's signature is " +
      "checked against it before anything is sent, so a statement written by anyone else is refused. " +
      "(--dry-run works without one.)",
    );
  }
  if (args.dryRun && args.statement !== undefined && customerKey === undefined) {
    console.log(
      "WARNING — no --customer-key was given. A real run will refuse to bill without the statement key fingerprint " +
      "the customer registered. This run checks that the statement's signature verifies and says which key signed " +
      "it, but not whose key that is.",
    );
  }

  // A period is billed only once it is over in UTC: until then requests are
  // still being added to it. The clock is the machine's; there is no override.
  const periodCheck = checkPeriodEnded(period, new Date());
  if (!periodCheck.ended) {
    if (!args.dryRun) throw new Error(`DO NOT BILL — ${periodCheck.message}`);
    console.log(`WARNING — ${periodCheck.message}. A real run will refuse to bill it until then.`);
  }

  // Read the statement before the ledger, so an unreadable file stops early.
  let statementDocument: unknown;
  // This machine's own statement key, if it has one: a statement signed by it was written here.
  let localKey: string | undefined;
  if (args.statement !== undefined) {
    try {
      statementDocument = JSON.parse(readFileSync(args.statement, "utf8"));
    } catch {
      throw new Error(`DO NOT BILL — ${args.statement} could not be read as a statement file.`);
    }
    localKey = operatorKeyFingerprint();
  }

  // sk_live_… and restricted rk_live_… keys both create real invoices.
  const isLive = isLiveStripeKey(key);
  // Refuse a live key up front unless --live was passed, before any spool is
  // read (the behaviour main had before the amount re-type gate was added; the
  // gate below still demands the re-type once --live IS passed).
  if (isLive && !args.live) {
    throw new Error(
      "Refusing to run against a LIVE Stripe key. This creates real charges. Use a test key " +
      "(sk_test_…), or pass --live deliberately together with --confirm-amount-cents.",
    );
  }

  // One invoice across all spools for this customer/period.
  const allEvents: BillableEvent[] = [];
  let chainVerified = true;
  let spoolsRead = 0;
  // What each spool looks like to the statement check: head hash and counts.
  const billSpools: BillSpool[] = [];
  for (const path of args.spools) {
    // The proxy writes a <application>-<provider>.features.jsonl file beside
    // each spool (request shape for Theo; not a ledger, never billed from).
    // `mesh verify` leaves those out by name, and so does this script, so an
    // operator can pass the customer's whole ledger folder as *.jsonl.
    if (path.endsWith(".features.jsonl")) {
      console.log(`Skipped (not a ledger spool): ${path}`);
      continue;
    }
    spoolsRead += 1;
    const records = loadRecords(path);
    const chain = verifyLedgerChain(records);
    if (!chain.ok) {
      chainVerified = false;
      console.error(`CHAIN BROKEN in ${path}: ${chain.reason} (seq ${chain.seq})`);
    }
    for (const record of records) allEvents.push(record.event);
    billSpools.push(describeBillSpool(basename(path), records, period));
  }

  if (spoolsRead === 0) throw new Error("None of the files passed is a ledger spool (<application>-<provider>.jsonl).");

  const modeLabel = args.dryRun ? "DRY RUN (no Stripe key read, nothing sent)" : isLive ? "LIVE" : "TEST";
  console.log(`\nMode: ${modeLabel}  ·  period: ${period}  ·  fee: ${args.fee}%  ·  spools read: ${spoolsRead}`);

  // A broken chain is the hard stop. Say so once, recompute nothing and print
  // no totals: figures from a ledger that fails verification mean nothing, and
  // a "savings" line above the refusal reads as if there were something to bill.
  if (!chainVerified) {
    console.log("\nDO NOT BILL — the ledger chain failed verification (see CHAIN BROKEN above). A statement over an unverifiable ledger is not an invoice.");
    console.log("No totals are shown: figures from a ledger that fails verification mean nothing.");
    process.exitCode = 1;
    return;
  }

  const invoice = recomputeInvoice(allEvents, { period, feePercent: args.fee });

  const plan = buildStripeInvoicePlan(invoice, chainVerified, {
    stripeCustomerId: args.customer,
    mode: args.finalize ? "finalize" : "draft",
    ...(args.label ? { customerLabel: args.label } : {}),
  });

  console.log(
    `Events in period: ${invoice.eventsConsidered}  ·  billed: ${invoice.eventsBilled}  ·  ` +
    `marked unpriced: ${invoice.unpricedEvents}`,
  );
  if (invoice.eventsConsidered === 0) {
    // The usual cause is a mistyped period, so show what the spools do hold.
    const perPeriod = new Map<string, number>();
    for (const event of allEvents) perPeriod.set(event.invoicePeriod, (perPeriod.get(event.invoicePeriod) ?? 0) + 1);
    const present = [...perPeriod.entries()].sort().map(([p, n]) => `${p} (${n} records)`).join(", ");
    console.log(`  No events are recorded for ${period}. Periods in the spool(s): ${present || "none"}.`);
  }
  if (invoice.unpricedEvents > 0) {
    // recomputeInvoice counts unpriced events but does not skip their levers: a
    // lever on one still bills if it carries a measured saving (an exact-cache
    // lever takes its saving from the recorded cost avoided, whatever the
    // event's pricing status). Say so, so the operator checks the statement
    // before a draft goes to the customer.
    console.log(
      "  Note: events marked unpriced had no catalogue price for their usage. Any lever on them without a " +
      "measured saving is not billed; check the mesh-verify statement for what was and was not billed.",
    );
  }
  // The recompute's verdict field is not printed here. It now agrees with the
  // plan (do_not_charge whenever the fee, rounded down, is below one cent), but
  // the outcome is stated once, with its reason, on the line that follows.
  console.log(`Net verified savings: $${invoice.netVerifiedSavingsUsd.toFixed(4)}`);

  // The customer's statement against this run: its seal, who signed it, what
  // it is, its period, the spools it was computed from, and its figures. Done before the
  // plan is acted on in any way, so a mismatch stops with nothing sent.
  if (statementDocument !== undefined) {
    const statementCheck = checkStatementForBilling({
      statement: statementDocument,
      period,
      spools: billSpools,
      bill: {
        netVerifiedSavingsUsd: invoice.netVerifiedSavingsUsd,
        feeCents: plan.action === "bill" ? plan.amountCents : 0,
        feePercent: args.fee,
      },
      // Only a rehearsal may look at a statement written during the month.
      periodMustBeClosed: !args.dryRun,
      // Who wrote it: the customer's registered key, and never this machine's own.
      ...(customerKey === undefined ? {} : { expectedKeyFingerprint: customerKey }),
      keyMustBeRegistered: !args.dryRun,
      ...(localKey === undefined ? {} : { operatorKeyFingerprint: localKey }),
    });
    if (!statementCheck.ok) {
      console.log(`\nDO NOT BILL — ${statementCheck.reason}`);
      process.exitCode = 1;
      return;
    }
    for (const warning of statementCheck.warnings) console.log(`WARNING — ${warning}`);
    console.log(`Statement: ${statementCheck.summary}.`);
  }

  if (plan.action === "do_not_bill") {
    console.log(`\nDO NOT BILL — ${plan.reason}`);
    return;
  }

  // LIVE human gate (Fix 6): require --live AND a matching amount re-type before
  // any live charge. Enforced here, BEFORE the Stripe client is even created, so
  // a live run without the correct re-type charges nothing.
  // A dry run has no key and sends nothing, so it has nothing to gate.
  const gate = args.dryRun ? { ok: true as const } : checkLiveChargeConfirmation({
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

  // Exactly the two requests a real run sends, built once so the dry run prints
  // what would be created and nothing else.
  //
  // The draft is created FIRST and the fee item attached to it explicitly by
  // id. (Relying on Stripe to auto-sweep pending items into a draft is
  // unreliable with auto_advance=false — it leaves an empty invoice.)
  const invoiceParams = {
    customerId: plan.customerId,
    currency: plan.currency, // match the fee currency; the account default may differ (e.g. GBP)
    // Send an invoice the customer pays themselves; never an automatic pull
    // from a saved payment method. Same request as the worker's bank-transfer rail.
    collectionMethod: "send_invoice" as const,
    daysUntilDue: args.daysUntilDue,
    autoAdvance: false, // never let the draft advance on its own
    description: `MESH statement ${plan.metadata.mesh_period ?? ""}`,
    idempotencyKey: `${plan.idempotencyKey}-inv`,
  };
  const itemParams = {
    customerId: plan.customerId,
    amountCents: plan.amountCents,
    currency: plan.currency,
    description: plan.description,
    metadata: {
      mesh_period: plan.metadata.mesh_period ?? "",
      mesh_fee_percent: plan.metadata.mesh_fee_percent ?? "",
      mesh_net_verified_savings_usd: plan.metadata.mesh_net_verified_savings_usd ?? "",
    },
    idempotencyKey: `${plan.idempotencyKey}-item`,
  };
  const finalizeKey = `${plan.idempotencyKey}-fin`;
  const dueIfCreatedToday = new Date(Date.now() + invoiceParams.daysUntilDue * 86_400_000).toISOString().slice(0, 10);

  console.log(`\n${args.dryRun ? "Would create" : "Creating"} one Stripe ${plan.finalize ? "invoice, then finalize it" : "DRAFT invoice"}:`);
  console.log(`  customer:            ${invoiceParams.customerId}`);
  console.log(`  amount:              ${itemParams.amountCents} cents`);
  console.log(`  currency:            ${itemParams.currency}`);
  console.log(`  collection method:   ${invoiceParams.collectionMethod} (the customer is sent an invoice; nothing is collected automatically)`);
  console.log(`  days until due:      ${invoiceParams.daysUntilDue} (due about ${dueIfCreatedToday} if created today; Stripe sets the date)`);
  console.log(`  auto advance:        ${invoiceParams.autoAdvance}`);
  console.log(`  invoice description: "${invoiceParams.description}"`);
  console.log(`  line item:           "${itemParams.description}"`);
  console.log(`  idempotency keys:    ${invoiceParams.idempotencyKey}`);
  console.log(`                       ${itemParams.idempotencyKey}`);
  if (plan.finalize) console.log(`                       ${finalizeKey}`);

  if (args.dryRun) {
    console.log(
      "\nDRY RUN — nothing was sent to Stripe. To create it, re-run without --dry-run, with a Stripe key, " +
      "--statement <the customer's statement file> and --customer-key <their registered fingerprint>, once the period has ended.",
    );
    return;
  }

  // Route through the shared client. allowLive is granted only once the gate
  // above has passed, so the sk_live_ guard still protects every other path.
  const stripe = createStripeClient(key, { allowLive: isLive });

  const inv = await stripe.createInvoice(invoiceParams);
  await stripe.createInvoiceItem({
    ...itemParams,
    invoiceId: inv.id, // explicit attachment — the fix for the empty-draft bug
  });

  console.log(`\nCreated Stripe invoice ${inv.id} — status ${inv.status} (${isLive ? "LIVE" : "TEST"} mode).`);
  if (plan.finalize) {
    const final = await stripe.finalizeInvoice(inv.id, finalizeKey);
    console.log(`Finalized: status ${final.status}, hosted at ${final.hosted_invoice_url ?? "(none)"}`);
    console.log("Finalizing does not by itself show the customer was emailed: check in the Stripe dashboard that the invoice was sent, and send it from there if not.");
  } else {
    console.log("Left as a DRAFT. Review it in the Stripe dashboard (amount, currency, due date, line text) and send it from there.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
