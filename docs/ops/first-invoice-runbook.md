# First invoice runbook (manual billing)

This runbook takes an operator from "the customer has sent their statement and
ledger" to "a Stripe draft invoice exists" to "the invoice has been sent", for a
customer billed by hand. It is written for someone who was not in the room when
the billing code was built.

MESH's fee is 1% of net verified savings for one calendar month. Under manual
billing nothing is collected automatically: the customer is sent an invoice and
pays it themselves.

## Read this first

- **Which code this matches.** The commands below match `scripts/mesh-bill.ts`
  as of two pull requests together: the billing-safety pull request (branch
  `product/billing-safety-on-main`, commit `c91f635`) and the fee-rounding pull
  request (branch `product/verdict-agrees-with-fee`, which is built on top of
  it). **Merge both before using this runbook.** Every `mesh-bill` figure and
  every line of `mesh-bill` output quoted below was run on commit `c3605c1` of
  the fee-rounding branch. On `main` at `51bee22` the script has no `--dry-run`,
  creates a draft that Stripe may collect automatically, and rounds the fee to
  the nearest cent.
- **Which release the customer needs.** `mesh statement` ships in the release
  after 0.2.3 (planned as 0.2.4). It is **not available** in 0.2.3: there,
  `mesh statement --period 2026-11` prints the general usage text, exits 0 and
  writes no file. A customer on 0.2.3 must update before they can produce a
  statement.
- **What has been tested.** Every command here was run on 2026-11-18 and
  2026-11-19 as a dry run: ledgers written by the shipped 0.2.3 runtime against
  a local stand-in provider, and `mesh-bill` run with `--dry-run` or with a fake
  key and its network calls replaced by a recorder. **Nothing has been sent to
  Stripe, in test or live mode, and no real provider or customer traffic is
  behind any number in this document.** The steps that need a real Stripe test
  account are listed in [Stripe test-mode steps](#stripe-test-mode-steps-for-the-founder).
- **Keys.** No assistant handles a Stripe key, test or live. The steps that need
  a key are run by the founder.

## Rules that do not bend

1. **A broken chain is a stop.** If the ledger does not verify, there is no
   invoice. Do not "fix" a spool; ask the customer to send it again.
2. **Do-not-charge means no invoice.** Nothing is created in Stripe, not even a
   zero-value draft. Tell the customer so.
3. **If our figures and the customer's disagree, the customer's recomputation
   wins.** That is the published rule. Stop, find the cause, and bill the lower
   figure or nothing.
4. **Dry run first, every time.** `--dry-run` reads no key and sends nothing.
5. **One closed month at a time.** Never bill a month that has not ended (UTC).
6. **Send an invoice; never an automatic pull.** The draft must say
   `send_invoice`. If it says anything else, delete it and stop.

## One-time setup

On the operator's machine:

```bash
# A checkout that contains both pull requests named above.
cd <your checkout of the Mesh repo>
corepack pnpm install
corepack pnpm exec tsc -b        # mesh-bill imports the built core package

# The operator's own copy of the mesh command, 0.2.4 or later, for checking statements.
mesh version
```

Create an operator log outside the repository (the manual path has no account
store and keeps no record of what was billed). A plain file is enough, for
example `~/mesh-billing/billing-log.md`. It is the only place that says a period
has been billed, so keep it backed up.

In the Stripe dashboard, create the customer once and note its id (`cus_…`).
Check it has the billing email address the invoice should go to.

## Steps

In the examples the customer is `acme`, the Stripe customer is `cus_XXX` and the
period is `2026-11`. Use absolute paths.

### 1. Ask the customer for three things

1. **The statement file** for the period. They run, on the machine MESH runs on:
   ```bash
   mesh statement --period 2026-11
   ```
   This writes `mesh-statement-2026-11.json` in the current folder. Needs 0.2.4
   or later; ask them to update first if `mesh version` prints 0.2.3 or earlier.
2. **The ledger spools**: the files in `~/.mesh/ledger/` named
   `<application>-<provider>.jsonl`. The `.features.jsonl` files beside them are
   not needed; if they arrive anyway, `mesh-bill` skips them.
3. **What `mesh verify` prints**, pasted as text.

None of these files holds prompts, answers or keys. Ask only after the month has
ended in UTC. A statement made earlier says
`THIS PERIOD HAS NOT ENDED YET: these figures can still change` and its file has
`"closed": false`; do not bill from it.

Until the customer has 0.2.4: you can only get the spools and the `mesh verify`
output. `mesh verify` prints one net figure for the whole ledger across all
months, with no fee and no period, so it matches a monthly invoice only when the
ledger holds a single month. Treat that as a weaker check and say so in the log.

### 2. File what arrived, unchanged

```bash
mkdir -p ~/mesh-billing/acme/2026-11/received
# copy the statement file and the spools into it; never edit them
```

### 3. Check this period has not been billed already

`mesh-bill` cannot tell. Its only protection is Stripe's idempotency key, which
is built from customer, period and amount: a second run with a different amount
(for example because a different set of spools was passed) creates a second
draft, and so does the same amount once Stripe has dropped the key (about a
day).

- Look in the operator log for this customer and period.
- In the Stripe dashboard, open the customer and look through their invoices in
  every state (draft, open, paid, void) for one described `MESH statement 2026-11`.

If either shows one, stop and work out why before going on.

### 4. Check the statement file

```bash
mesh statement --check ~/mesh-billing/acme/2026-11/received/mesh-statement-2026-11.json
```

Must print `✓ … matches its sha256 seal` and exit 0. A file changed after it was
written prints `✗ … does NOT match its sha256 seal` and exits 1: ask for it
again. The seal only shows the file was not altered by accident; the proof of
the figures is the recomputation in the next steps.

Then read the fields you will compare:

```bash
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("period",s.period.id,"closed",s.period.closed,"| valid for billing",s.validForBilling,"| chain verified",s.ledger.chainVerified);for(const p of s.ledger.spools)console.log("records="+p.records,"head="+p.headHash);console.log("net verified savings USD",s.totals.netVerifiedSavingsUsd,"| fee cents",s.fee.amountCents,"| verdict",s.verdict,"| deficit carried forward USD",s.deficitCarriedForwardUsd)' \
  ~/mesh-billing/acme/2026-11/received/mesh-statement-2026-11.json
```

Must show the right period, `closed true`, `valid for billing true` and
`chain verified true`. Anything else: stop.

### 5. Compare the spools you received with the statement, spool by spool

A ledger with a whole spool missing, or with the last records of a spool cut
off, **still verifies as a chain**. `mesh-bill` and `mesh verify` both accept
it. This comparison is the only thing that catches it.

```bash
for f in ~/mesh-billing/acme/2026-11/received/*.jsonl; do
  case "$f" in *.features.jsonl) continue ;; esac
  printf '%s  records=%s  head=%s\n' "$(basename "$f")" "$(grep -c . "$f")" \
    "$(tail -n 1 "$f" | sed -E 's/^\{"seq":[0-9]+,"prevHash":"[0-9a-f]+","eventHash":"([0-9a-f]+)".*/\1/')"
done
```

Every `records=… head=…` pair printed in step 4 must appear here, and there must
be the same number of spools. A spool that is missing, a count that is lower, or
a head hash that differs: stop and ask the customer to send the ledger again.

Dry-run example: with the last line of one spool removed, this printed
`records=1799` and a different head hash where the statement said
`records=1800`; with one of six spools left out it printed five lines. In both
cases `mesh-bill` raised no objection.

### 6. Dry run

```bash
cd <your checkout of the Mesh repo>
node --import tsx scripts/mesh-bill.ts --dry-run \
  --customer cus_XXX --period 2026-11 --fee 1 \
  ~/mesh-billing/acme/2026-11/received/*.jsonl
```

No Stripe key is read and nothing is sent. What it must look like when there is
something to bill (dry-run example on commit `c3605c1`, stand-in provider, not
a customer result):

```text
Mode: DRY RUN (no Stripe key read, nothing sent)  ·  period: 2026-11  ·  fee: 1%  ·  spools read: 6
Events in period: 4800  ·  billed: 4000  ·  marked unpriced: 400
  Note: events marked unpriced had no catalogue price for their usage. Any lever on them without a measured saving is not billed; check the mesh-verify statement for what was and was not billed.
Net verified savings: $2.4494

Would create one Stripe DRAFT invoice:
  customer:            cus_TEST
  amount:              2 cents
  currency:            usd
  collection method:   send_invoice (the customer is sent an invoice; nothing is collected automatically)
  days until due:      14 (due about 2026-12-03 if created today; Stripe sets the date)
  auto advance:        false
  invoice description: "MESH statement 2026-11"
  line item:           "MESH fee — 1% of $2.45 net verified savings, period 2026-11. Check it on your own machine: mesh statement --period 2026-11. Independent check: npx -y -p @harrym1707/verify mesh-verify <your spool>. If your recomputation disagrees, yours wins."
  idempotency keys:    mesh-cus_TEST-2026-11-2-inv
                       mesh-cus_TEST-2026-11-2-item

DRY RUN — nothing was sent to Stripe. Re-run without --dry-run (and with a Stripe key) to create it.
```

Check: `spools read` equals the number of spools in the statement; the period is
right; the collection method is `send_invoice`; the customer id is right.

Payment terms default to 14 days; `--days-until-due <n>` changes them.

The line item tells the customer to run `mesh statement --period 2026-11`. That
command exists only from 0.2.4. Do not send an invoice carrying that line to a
customer who is still on 0.2.3: have them update first (step 1). The second
command on the line, the standalone verify package, was not run in this dry
run.

### 7. Compare the dry run with the statement

| From the statement (step 4) | From the dry run (step 6) | Must |
|---|---|---|
| `net verified savings USD` | `Net verified savings` | agree to the four decimals printed |
| `fee cents` | `amount: … cents` | be equal |
| `verdict` | an invoice is planned, or `DO NOT BILL` | agree |

If they differ by even a cent, stop. Do not create the draft. The customer's
recomputation wins; find the cause first (a different set of spools, a
different release on each side, a different price list) and bill the lower
figure or nothing.

One difference is expected until the release that carries the round-down rule
reaches the customer: a statement written by an earlier build rounds the fee to
the nearest cent and can show one cent more than `mesh-bill`. Seen in the dry
run: a statement built from the statement branch at `a8d2c6f` said 3 cents on
US$2.6330 and 10 cents on US$9.5947, where `mesh-bill` on `c3605c1` said 2 cents
and 9 cents. The invoice uses the lower figure. Tell the customer why. Any
other difference is a stop.

### 8. Apply a carried deficit, by hand

`mesh-bill` has no memory of earlier months and no flag for a deficit. For a
first invoice there is nothing to carry. For later months:

- Look in the operator log for a deficit carried out of the previous period (a
  month whose net verified savings were negative; the statement shows it as
  `deficit carried forward`).
- If there is one, the fee is 1% of (this month's net verified savings minus the
  deficit), rounded down to the cent. If that is zero or less, there is no
  invoice; record the remaining deficit in the log.
- If it is positive, the amount `mesh-bill` plans is too high. Do not send its
  draft unchanged: correct the line amount and its text on the draft in the
  dashboard before sending, and record the arithmetic in the log.

This step has not been exercised in a dry run. If a deficit ever applies, treat
it as a reason to have the flag added to the script before billing.

### 9. Create the draft (founder only: needs the Stripe key)

Test mode:

```bash
STRIPE_TEST_SECRET_KEY=sk_test_… node --import tsx scripts/mesh-bill.ts \
  --customer cus_XXX --period 2026-11 --fee 1 \
  ~/mesh-billing/acme/2026-11/received/*.jsonl
```

Live mode needs `--live` and the amount re-typed, taken from the dry run:

```bash
STRIPE_SECRET_KEY=sk_live_… node --import tsx scripts/mesh-bill.ts \
  --live --confirm-amount-cents <cents from the dry run> \
  --customer cus_XXX --period 2026-11 --fee 1 \
  ~/mesh-billing/acme/2026-11/received/*.jsonl
```

The output is the dry-run output with `Creating` in place of `Would create`,
then:

```text
Created Stripe invoice in_… — status draft (TEST mode).
Left as a DRAFT. Review it in the Stripe dashboard (amount, currency, due date, line text) and send it from there.
```

Do not pass `--finalize`. Leave the draft for review.

Refusals you may see, all of which create nothing:

| Printed | Meaning |
|---|---|
| `Refusing to run against a LIVE Stripe key…` | A live key without `--live` |
| `REFUSING TO CHARGE — A LIVE charge must be confirmed by re-typing the exact amount…` | `--live` without `--confirm-amount-cents` |
| `REFUSING TO CHARGE — Amount re-type mismatch…` | The re-typed amount is not the planned amount |
| `--period YYYY-MM is REQUIRED…` | No period given |

### 10. Review the draft in the Stripe dashboard

Open the invoice id that was printed and check each of these against the dry
run and the statement:

- **Customer** is the right one, with the right billing email.
- **Amount** equals `fee cents`. It is one line.
- **Currency** is USD (see [Decide before the first invoice](#decide-before-the-first-invoice)).
- **Collection method** is "send invoice", not automatic charge.
- **Due date** is 14 days out, or the terms agreed.
- **Line text** names the period and reads correctly to a customer.
- **Status** is draft, and there is no other invoice for this customer and period.

Anything wrong: delete the draft, fix the cause, start again from step 6.

### 11. Send

Send the invoice from the dashboard. Whether `mesh-bill --finalize` also emails
the customer has not been checked against Stripe, so the dashboard is the
documented way to send.

### 12. Record what was billed

Add an entry to the operator log, the same day:

- date, operator, customer name, Stripe customer id, period;
- spools received: file names, record counts, head hashes;
- the statement's `sha256` seal;
- net verified savings, fee in cents, deficit carried in and out;
- the commit of the checkout `mesh-bill` ran from (`git rev-parse --short HEAD`);
- the Stripe invoice id, mode (test or live), and its state (draft, sent, paid, void);
- for a do-not-charge month: that nothing was billed, and why.

## When the output is not what the step says

| You see | What it means | What to do |
|---|---|---|
| `CHAIN BROKEN in <file>: …` then `DO NOT BILL — the ledger chain failed verification…`, exit 1 | A record was changed, reordered or removed from the middle of a spool | Stop. No invoice. Ask the customer to send the ledger again; do not repair it |
| `DO NOT BILL — <file>: line N is not valid JSON, so the spool cannot be verified.`, exit 1 | The file is damaged or is not a spool | Stop. Ask for the file again |
| `DO NOT BILL — <file>: line N is not a ledger record…`, exit 1 | A file that is not a spool was passed | Pass only `<application>-<provider>.jsonl` files |
| `Skipped (not a ledger spool): ….features.jsonl` | The proxy's features file, sent along with the spools | Nothing; it is never billed from |
| `No events are recorded for 2026-10. Periods in the spool(s): 2026-11 (4800 records).` then `DO NOT BILL` | The wrong period was typed, or the customer sent the wrong month | Check the period; nothing was created |
| `DO NOT BILL — do_not_charge: the period's net verified savings were not positive…` | A month with no saving, or a net loss | No invoice. Tell the customer nothing is owed. Record any deficit in the log |
| `DO NOT BILL — do_not_charge: the 1% fee on $0.3558 net verified savings is below one cent, so nothing is billed yet.` | There were savings, but the fee is under one cent | No invoice. See the next section |
| The statement and the dry run disagree | See step 7 | Stop. The customer's recomputation wins |
| A spool is missing or shorter than the statement says | See step 5 | Stop. Ask for the ledger again |
| A second draft for the same period | The script was run twice with different spool sets or amounts | Delete the wrong draft before anything is sent; find out which spool set was right |

### The customer's `mesh verify` says "(charge)" but nothing is owed

Seen in the dry run on a ledger from the shipped 0.2.3 runtime (stand-in
provider, not a customer result): 696 requests, net verified savings US$0.3558.
The customer's own tool printed:

```text
✓ determinism  invoice recomputes identically: $0.3558 verified (charge)
```

and `mesh status` printed `696 requests seen · $0.3558 verified saved (charge)`.
`mesh-bill`, on the same spools, printed:

```text
Net verified savings: $0.3558

DO NOT BILL — do_not_charge: the 1% fee on $0.3558 net verified savings is below one cent, so nothing is billed yet.
```

and made no request to Stripe: no invoice, no zero-value draft, with `--dry-run`
and with a key alike.

Why: in 0.2.3 the word in brackets only says that net savings are positive. It
is not the bill's decision. The fee is 1% of US$0.3558, which is about a third
of a cent, and the smallest amount that can be invoiced is one cent.

What to tell the customer: "Your savings this month were real and verified, and
the fee on them is less than one cent, so there is no invoice. The word
'(charge)' in your `mesh verify` output means your savings were positive; it
does not mean you owe anything. A later release words this correctly." The
corrected wording reaches customers only with the next release.

## What the dry run showed

Dry run only. Ledgers written by the shipped 0.2.3 runtime
(`npx -y @harrym1707/mesh@0.2.3`) with `mesh proxy` in front of a local stand-in
provider, default lossless levers, period 2026-11. **These are not customer
results and say nothing about what MESH saves on real traffic.** One further
ledger of the same kind was made by the overwatch session.

Which code each figure came from: `mesh verify` and `mesh status` are the
shipped 0.2.3 runtime (build `51bee22`). The statement is the statement branch
at `a8d2c6f`, which still rounds the fee to the nearest cent. `mesh-bill` and
the stubbed Stripe request are commit `c3605c1` (fee rounded down). The
"before" column shows what `mesh-bill` planned on `c91f635`, before the rounding
change.

| Ledger | Requests | `mesh verify` 0.2.3: net | Statement `a8d2c6f`: net, fee | `mesh-bill` before (`c91f635`) | `mesh-bill --dry-run` (`c3605c1`) | Stubbed Stripe request (`c3605c1`) |
|---|---|---|---|---|---|---|
| one round | 24 | $0.0131 (charge) | US$0.0131, 0 cents, do_not_charge | DO NOT BILL | DO NOT BILL | none made |
| sub-cent | 696 | $0.3558 (charge) | US$0.3558, 0 cents, do_not_charge | DO NOT BILL | DO NOT BILL | none made |
| volume | 4,800 | $2.4494 (charge) | US$2.4494, 2 cents, charge | 2 cents | 2 cents | `amount=2`, key `mesh-cus_TEST-2026-11-2-item` |
| volume B | 5,160 | $2.6330 (charge) | US$2.6330, 3 cents, charge | 3 cents | 2 cents | `amount=2`, key `mesh-cus_TEST-2026-11-2-item` |
| overwatch | 2,500 | $9.5947 (charge) | US$9.5947, 10 cents, charge | 10 cents | 9 cents | `amount=9`, key `mesh-cus_TEST-2026-11-9-item` |

Net verified savings agreed across all three tools in every row. The fee in
cents agreed between `mesh-bill --dry-run` and the stubbed Stripe request in
every row. The two rows where the statement shows one cent more are the defect
the round-down rule fixes: 3 cents on US$2.6330 is 1.14%, and 10 cents on
US$9.5947 is 1.04%; on `c3605c1` they are 2 cents and 9 cents. The statement
is expected to agree once the release merges the two branches; that has not
been run.

Things the dry run showed that an operator should know:

- The shipped `mesh verify` prints one net figure for the whole ledger, with no
  period and no fee. Only the statement gives a per-month figure and the fee.
- A cut-off spool and a missing spool both pass chain verification (step 5).
- A spool with one saving edited fails in `mesh-bill` (`CHAIN BROKEN`, exit 1).
  The customer's own `mesh verify` 0.2.3 on that same ledger marked the ledger
  line `✗` and still printed `$102.4494 verified (charge)` on the next line.
- Billing the same period from five of six spools and then from all six planned
  two different drafts, 1 cent and 2 cents, with different idempotency keys
  (`…-2026-11-1-…` and `…-2026-11-2-…`). Nothing in the script would have
  stopped the second.
- `mesh-bill` does not check that the month has ended. The statement does.
- Requests to a model the price list does not carry were recorded and not
  billed; no unpriced request carried a billed saving in these ledgers.

## Stripe test-mode steps for the founder

These six steps have never been run. Each needs a real Stripe **test** key
(`sk_test_…`) and a test customer, so the founder runs them himself. No
assistant handles a Stripe key, test or live. Full text:
`docs/ops/billing-stripe-test-checklist.md` on the billing-safety branch. Never
use a live key for any of them.

1. **A real test key is accepted.**
   `STRIPE_TEST_SECRET_KEY=sk_test_… node --import tsx -e 'import("./packages/core/dist/src/index.js").then(m => console.log(m.createStripeClient(process.env.STRIPE_TEST_SECRET_KEY).mode))'`
   Expect: `test`.
2. **`mesh-bill` lands a real draft.** Run step 6 then step 9 of this runbook
   with the test key, a test `cus_…` and a valid spool. Expect: one draft in the
   test dashboard, not empty, collection method "send invoice", due in 14 days.
   This is the step that matters most for a first invoice.
3. **The worker settles on the bank-transfer rail.**
   `MESH_DATA_DIR=./.mesh-data MESH_STRIPE_TEST_SECRET_KEY=sk_test_… node --import tsx scripts/mesh-bill-worker.ts --period 2026-10`
   Expect: an invoice created, finalized and sent; a second run reports `ALREADY BILLED`.
4. **Direct debit: mandate, notice, then pull.** With a test customer holding a
   confirmed test mandate, run the worker with `--mode advance_notice`, then
   again without it. Expect: the test payment succeeds in the dashboard. Not
   used under manual billing.
5. **Admin billing run and a refund.**
   `POST /v1/admin/billing/run` with `{"period":"2026-10"}`, then
   `POST /v1/admin/refunds` with a resulting payment intent, against the API
   server booted with a test key. Expect: `stripeMode` is `test`; a test refund
   exists. Not used under manual billing.
6. **Stripe honours the idempotency key.** Run step 2 twice within a day with
   the same customer, period and amount. Expect: the same invoice back, not a
   second one.

For manual billing, steps 1, 2 and 6 are the ones to run before the first
invoice. While doing step 2, also check the three things this runbook could not:
how the invoice and its line read on Stripe's hosted page and PDF, whether a
draft for a few cents can be finalized and paid at all, and what happens when
the customer record has no email address.

## Decide before the first invoice

**Settled, stated here so nobody promises otherwise:**

- **Rounding.** The fee is rounded **down** to the cent, so it is never more
  than 1% of net verified savings. This follows the published Terms, which say
  the fee is 1% of verified savings and nothing else. It was changed on
  2026-11-18 as a defect fix and lives on branch
  `product/verdict-agrees-with-fee`; it is one constant in the code if the
  founder prefers another rule. Before that change the fee was rounded to the
  nearest cent and could exceed 1%: 22 cents on US$21.63 of net verified savings
  is 1.017%, and US$0.50 of savings billed 1 cent, which is 2%. Under round-down
  (checked on `c3605c1`) US$21.63 bills 21 cents, US$0.50 and US$0.99 bill
  nothing and US$1.00 bills 1 cent.
  **Until both pull requests are merged, nobody should promise "never more than
  1%"**, and the shipped 0.2.3 `mesh verify` can print "(charge)" for a customer
  who owes nothing; that wording is fixed for customers only by the next
  release.

**Open, for the founder:**

1. **The smallest invoice worth sending.** The only floor is one cent, reached
   at US$1.00 of net verified savings. Nothing stops a 2-cent invoice, as the
   dry run shows. Options include a minimum amount with smaller fees carried
   forward to a later month; that needs a rule for the carry and a line in the
   Terms. Whether Stripe will finalize and collect an invoice of a few cents has
   not been tested.
2. **Invoice currency.** Every invoice is in US dollars; the script has no
   currency option. The company is in England.
3. **VAT wording.** The invoice carries no tax rate, VAT number or
   reverse-charge wording.
4. **Payment terms.** 14 days is assumed (`--days-until-due`). Nothing in the
   Terms states it.
5. **Unpriced requests.** A request to a model the price list does not carry is
   recorded and its savings are not billed. Decide whether that is the lasting
   rule or whether such months wait for a price-list update, and what the
   customer is told. One known edge: a lever that carries its own measured
   saving can bill even on a request marked unpriced; none did in the dry run.
6. **Wording on the invoice.** "MESH" in capitals, a `$` with no "USD", no
   thousands separator. Read the line on Stripe's hosted page before the first
   one goes out.

## What the manual path does not do

So the operator is not relying on something that is not there:

- No record of billed periods. Step 3 and the operator log are the control.
- No carried deficit. Step 8 is by hand.
- No check that the month has ended. Step 1 and step 4 are the control.
- No check that every spool arrived complete. Step 5 is the control.
- No re-derivation of savings from provider usage at bill time (the automated
  worker does this; the manual script bills the recorded figures once the chain
  verifies).
- No ceiling on the amount. The draft and the human review are the control.
