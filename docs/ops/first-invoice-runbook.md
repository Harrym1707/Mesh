# First invoice runbook (manual billing)

This runbook takes an operator from "the customer has sent their statement and
ledger" to "a Stripe draft invoice exists" to "the invoice has been sent", for a
customer billed by hand. It is written for someone who was not in the room when
the billing code was built.

MESH's fee is 1% of net verified savings for one calendar month. Under manual
billing nothing is collected automatically: the customer is sent an invoice and
pays it themselves.

## Read this first

- **Which code this matches.** The commands and the output quoted below match
  the release branch `release/0.2.4` at commit `5316e36`. Every figure and every
  line of `mesh-bill`, `mesh verify`, `mesh status` and `mesh statement` output
  was run on that commit, unless a line says otherwise. That branch contains two
  pull requests: billing safety (branch `product/billing-safety-on-main`) and
  the one built on top of it (branch `product/verdict-agrees-with-fee`), which
  carries the fee-rounding rule, the `mesh statement` command and the checks
  `mesh-bill` now makes for itself. **Use this runbook only with a checkout that
  has that release merged.** On `main` at `51bee22` the script has no
  `--dry-run`, takes no statement, creates a draft that Stripe may collect
  automatically, and rounds the fee to the nearest cent.
- **Which code the signing steps match.** Everything in this runbook about the
  customer's **statement key** (`mesh statement --key`, the signature on a
  statement, `mesh-bill --customer-key`, and every refusal that mentions a key
  or a signature) matches branch `product/statement-signed-by-install` at commit
  `0dc11d2`, and every such line quoted below was run on that commit on
  2026-11-19, the same way as the rest: `--dry-run`, or a fake key with the
  network replaced by a recorder. **Release 0.2.4 does not have it.** It reaches
  customers with the release after 0.2.4 (planned as 0.2.5), and the operator's
  checkout must contain that branch. Lines quoted from `5316e36` were run before
  signing existed: on the signing branch the `Statement: statement matched: …`
  line ends with `, signed by the customer's registered statement key
  <fingerprint>.`, as the example in step 6 shows.
- **Which release the customer needs.** `mesh statement` ships in 0.2.4. It is
  **not available** in 0.2.3: there, `mesh statement --period 2026-11` prints
  the general usage text, exits 0 and writes no file. A statement `mesh-bill`
  will accept must also be **signed**, which needs the release after 0.2.4
  (planned as 0.2.5): 0.2.4 writes statements with no signature, and the script
  refuses them by name (step 9). So a customer on 0.2.4 or earlier must update
  before they can be billed.
- **What has been tested.** Every command here was run between 2026-11-18 and
  2026-11-19 as a dry run: ledgers written by the shipped 0.2.3 runtime against
  a local stand-in provider, and `mesh-bill` run with `--dry-run` or with a fake
  key and its network calls replaced by a recorder. **Nothing has been sent to
  Stripe, in test or live mode, and no real provider or customer traffic is
  behind any number in this document.** The steps that need a real Stripe test
  account are listed in [Stripe test-mode steps](#stripe-test-mode-steps-for-the-founder).
- **What could not be shown yet.** Every dry-run ledger is dated November 2026,
  and `mesh-bill` refuses to bill a month that has not ended. So a real-mode run
  that reaches Stripe cannot be shown on those ledgers before 1 December 2026;
  what this runbook shows for them is the dry run and the refusal. See
  [The success path](#the-success-path-what-was-and-was-not-shown).
- **Keys.** No assistant handles a Stripe key, test or live. The steps that need
  a key are run by the founder.

## Rules that do not bend

1. **A broken chain is a stop.** If the ledger does not verify, there is no
   invoice. Do not "fix" a spool; ask the customer to send it again.
2. **Do-not-charge means no invoice.** Nothing is created in Stripe, not even a
   zero-value draft. Tell the customer so.
3. **If our figures and the customer's disagree, the customer's recomputation
   wins.** That is the published rule. The script refuses to bill when its own
   recompute and the customer's statement differ; do not work around it.
4. **Dry run first, every time.** `--dry-run` reads no key and sends nothing.
5. **One ended month at a time.** A real run refuses a month that has not ended
   in UTC. There is no flag to override the clock; do not look for one.
6. **The statement must be the customer's own, and the script now enforces
   it.** `mesh-bill` checks the spools you pass against the statement. That
   check only means something if the customer produced the statement on their
   machine from their whole ledger: a statement you write yourself from the
   files that arrived matches those files trivially. So every statement is
   signed by a key that exists only on the customer's install, and a real run
   requires `--customer-key <fingerprint>`, the fingerprint the customer
   registered with you when billing was agreed (one-time setup, below). The
   script refuses a statement that is unsigned, whose signature does not verify,
   that is signed by any other key, or that is signed by the Mesh install on the
   machine running the bill ("this statement was written on this machine, not by
   the customer"). Never produce the statement yourself, never pass a
   fingerprint you read off the statement in place of the registered one, and
   never run the bill from another machine to get past the last refusal. What
   the signature does not do is in
   [What the manual path does not do](#what-the-manual-path-does-not-do).
7. **Send an invoice; never an automatic pull.** The draft must say
   `send_invoice`. If it says anything else, delete it and stop.

## One-time setup

On the operator's machine:

```bash
# A checkout that contains the release named above.
cd <your checkout of the Mesh repo>
corepack pnpm install
corepack pnpm exec tsc -b        # mesh-bill imports the built core package

# The operator's own copy of the mesh command, 0.2.4 or later, for looking at statements.
mesh version
```

Create an operator log outside the repository (the manual path has no account
store and keeps no record of what was billed). A plain file is enough, for
example `~/mesh-billing/billing-log.md`. It is the only place that says a period
has been billed, so keep it backed up.

In the Stripe dashboard, create the customer once and note its id (`cus_…`).
Check it has the billing email address the invoice should go to.

### Register the customer's statement key

Do this once per customer, **when billing is agreed**, before any statement is
asked for. It needs the customer on the release after 0.2.4 (planned as 0.2.5).

1. Agree in writing (the order form or the email that agrees billing) which
   channel the fingerprint will come through and who at the customer may send
   it. It should be a channel you already trust for that person, and **not** the
   one the monthly statement and spools will arrive through.
2. The customer runs, on the machine MESH runs on:
   ```bash
   mesh statement --key
   ```
   Run on `0dc11d2` it prints (path shortened; nothing is sent anywhere):
   ```text
     Statement key fingerprint for this MESH install:
     adc3acb79facda9ed2e0e0c33b81d5db90edd498c75c80dbedb4e807c5217dcd

     Send it to MESH once, when billing is agreed, through the channel agreed in writing. It is public
     and safe to share; the private half never leaves this machine. If you reinstall or move machine
     the fingerprint changes, and you must register the new one the same way before your next statement.

     Key file (private, do not share): …/.mesh/identity/statement-key.json
   ```
   The key is created the first time the command (or `mesh statement --period`)
   runs on an install; that once, the first line ends `(key created just now):`.
   The fingerprint shown is the dry run's, not a customer's.
3. They send you the 64-character fingerprint through the agreed channel. It is
   public: it is safe in an email. They must **not** send the key file.
4. Record it in the operator log, the same day: customer, the fingerprint in
   full, the date, who sent it and through which channel.

A fingerprint that arrives **in the same message as a statement and spools** is
not a registration. Whoever sent the files could have written the statement and
the fingerprint together; that is the case the signature exists to catch. The
fingerprint is only as trustworthy as the channel it was registered through.

The operator's own machine has a statement key too, as soon as `mesh statement`
has written a statement on it. `mesh-bill` reads its fingerprint from
`~/.mesh/identity/statement-key.json` (never the private half) and refuses any
statement signed by it.

## Steps

In the examples the customer is `acme`, the Stripe customer is `cus_XXX` and the
period is `2026-11`. Use absolute paths.

### 1. Ask the customer for three things, after the month has ended

1. **The statement file** for the period. They run, on the machine MESH runs on:
   ```bash
   mesh statement --period 2026-11
   ```
   This writes `mesh-statement-2026-11.json` in the current folder, signed with
   their statement key; the last lines printed include `Signed by this install's
   statement key: <fingerprint>`. Needs the release after 0.2.4 (planned as
   0.2.5); ask them to update first if `mesh version` prints 0.2.4 or earlier.
   It must be run on the install whose fingerprint they registered.
2. **The ledger spools**: the files in `~/.mesh/ledger/` named
   `<application>-<provider>.jsonl`, all of them. The `.features.jsonl` files
   beside them are not needed; if they arrive anyway, `mesh-bill` skips them.
3. **What `mesh verify` prints**, pasted as text.

None of these files holds prompts, answers or keys.

Ask only after the month has ended in UTC, and ask for a statement produced
after it ended. A statement made earlier says
`THIS PERIOD HAS NOT ENDED YET: these figures can still change` and its file has
`"closed": false`. A real `mesh-bill` run refuses the month until it has ended,
whatever the statement says.

### 2. File what arrived, unchanged

```bash
mkdir -p ~/mesh-billing/acme/2026-11/received
# copy the statement file and the spools into it; never edit them
```

### 3. Check this period has not been billed already

`mesh-bill` cannot tell. Its only protection is Stripe's idempotency key, which
is built from customer, period and amount: a second run with a different amount
creates a second draft, and so does the same amount once Stripe has dropped the
key (about a day).

- Look in the operator log for this customer and period.
- In the Stripe dashboard, open the customer and look through their invoices in
  every state (draft, open, paid, void) for one described `MESH statement 2026-11`.

If either shows one, stop and work out why before going on.

### 4. Look at the statement file

`mesh-bill --statement` checks the statement for you in steps 6 and 9: its
seal, its signature and the key that made it, that it is a statement valid for
billing with a verified chain, and that its period is the one you are billing.
This step is how you look for yourself, and how you find out why a refusal
happened.

```bash
mesh statement --check ~/mesh-billing/acme/2026-11/received/mesh-statement-2026-11.json
```

For a signed, untouched statement it exits 0 and prints (run on `0dc11d2`):

```text
  ✓ …/mesh-statement-2026-11.json matches its sha256 seal (4ebef48e41cf451818d3b93d3f6b12d7047e8ba56bf2f62dc236fa55d504e28a).
    The seal shows the file was not altered by accident. The proof of the figures is
    recomputing them from the ledger itself.
  ✓ Its signature verifies against the statement key named in the file.
    Signed by statement key: adc3acb79facda9ed2e0e0c33b81d5db90edd498c75c80dbedb4e807c5217dcd
    This shows the file is consistent with itself: whoever holds that key signed it.
    It does not show whose key it is. MESH compares the fingerprint with the one the
    customer registered; your own is printed by: mesh statement --key
```

**Compare the fingerprint it prints with the one in the operator log for this
customer, by eye.** `--check` cannot tell you whose key it is: a statement
anyone signed with their own key passes it. The comparison with the registered
key is what `--customer-key` does in steps 6 and 9.

A file changed after it was written prints `✗ … does NOT match its sha256 seal:
it was edited or damaged after it was written.` and exits 1: ask for it again.
The seal only shows the file was not altered by accident; the proof of the
figures is the recomputation `mesh-bill` does. A statement written by 0.2.4
passes the seal and then prints, exit 1:

```text
  ✗ It is NOT signed: it was written by a MESH release that does not sign statements
    (it says MESH 0.2.4; signing starts with 0.2.5). MESH does not bill from an unsigned
    statement. Update MESH to 0.2.5 or later and write it again with:
    mesh statement --period 2026-11
```

A statement whose signature was altered prints `✗ Its signature does NOT
verify: the signature does not verify against the public key in the file.`,
exit 1.

To read the fields the script compares:

```bash
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("period",s.period.id,"closed",s.period.closed,"| valid for billing",s.validForBilling,"| chain verified",s.ledger.chainVerified);for(const p of s.ledger.spools)console.log("records="+p.records,"head="+p.headHash);console.log("net verified savings USD",s.totals.netVerifiedSavingsUsd,"| fee cents",s.fee.amountCents,"| verdict",s.verdict,"| deficit carried forward USD",s.deficitCarriedForwardUsd);console.log("written by mesh",s.mesh.version,"| signed by key",s.signature?s.signature.fingerprint:"NOT SIGNED")' \
  ~/mesh-billing/acme/2026-11/received/mesh-statement-2026-11.json
```

### 5. Look at the spools you received

A ledger with a whole spool missing, or with the last records of a spool cut
off, **still verifies as a chain**. What catches it is the comparison with the
customer's statement, spool by spool: head hash, record count, and records in
the period. `mesh-bill --statement` now makes that comparison itself and refuses
to bill on any difference (the exact refusals are in step 9). This command
prints the same facts so you can see which file is the odd one:

```bash
for f in ~/mesh-billing/acme/2026-11/received/*.jsonl; do
  case "$f" in *.features.jsonl) continue ;; esac
  printf '%s  records=%s  head=%s\n' "$(basename "$f")" "$(grep -c . "$f")" \
    "$(tail -n 1 "$f" | sed -E 's/^\{"seq":[0-9]+,"prevHash":"[0-9a-f]+","eventHash":"([0-9a-f]+)".*/\1/')"
done
```

Every `records=… head=…` pair printed in step 4 should appear here, with the
same number of spools. Dry-run example: with the last line of one spool removed
this printed `records=1799` and a different head hash where the statement said
`records=1800`.

### 6. Dry run, with the statement and the customer's registered key

`--customer-key` is the fingerprint **from the operator log** (one-time setup),
copied from there. Not the one printed on the statement, and not one that came
with it.

```bash
cd <your checkout of the Mesh repo>
node --import tsx scripts/mesh-bill.ts --dry-run \
  --customer cus_XXX --period 2026-11 --fee 1 \
  --statement ~/mesh-billing/acme/2026-11/received/mesh-statement-2026-11.json \
  --customer-key <the fingerprint registered for this customer, from the operator log> \
  ~/mesh-billing/acme/2026-11/received/*.jsonl
```

No Stripe key is read and nothing is sent. What it looks like when there is
something to bill (dry-run example on commit `0dc11d2`, the same stand-in
provider ledger as before, not a customer result; the two WARNING lines are
there only because this example month had not ended when it was run):

```text
WARNING — period 2026-11 has not ended (it ends 2026-12-01T00:00:00.000Z UTC). A real run will refuse to bill it until then.

Mode: DRY RUN (no Stripe key read, nothing sent)  ·  period: 2026-11  ·  fee: 1%  ·  spools read: 1
Events in period: 2500  ·  billed: 2500  ·  marked unpriced: 0
Net verified savings: $9.5947
WARNING — the statement was written before period 2026-11 had ended (closed: false), so its figures could still change. Ask for a statement produced after the period ended.
Statement: statement matched: 1 spool, 2500 records (2500 in 2026-11), net verified savings $9.5947, fee 9 cents, signed by the customer's registered statement key adc3acb79facda9ed2e0e0c33b81d5db90edd498c75c80dbedb4e807c5217dcd.

Would create one Stripe DRAFT invoice:
  customer:            cus_TEST
  amount:              9 cents
  currency:            usd
  collection method:   send_invoice (the customer is sent an invoice; nothing is collected automatically)
  days until due:      14 (due about 2026-12-03 if created today; Stripe sets the date)
  auto advance:        false
  invoice description: "MESH statement 2026-11"
  line item:           "MESH fee — 1% of $9.59 net verified savings, period 2026-11. Check it on your own machine: mesh statement --period 2026-11. Independent check of the savings: npx -y -p @harrym1707/verify mesh-verify <your spool>. If your recomputation disagrees, yours wins."
  idempotency keys:    mesh-cus_TEST-2026-11-9-inv
                       mesh-cus_TEST-2026-11-9-item

DRY RUN — nothing was sent to Stripe. To create it, re-run without --dry-run, with a Stripe key, --statement <the customer's statement file> and --customer-key <their registered fingerprint>, once the period has ended.
```

Before going on, the output must have:

- **no WARNING lines**. For a month that has ended and a statement written
  after it ended, there are none;
- the line `Statement: statement matched: …`, with the spool and record counts
  you expect, ending `signed by the customer's registered statement key
  <fingerprint>`, and that fingerprint is the one in the operator log;
- the right customer id and period, and `send_invoice` as the collection method.

A dry run without `--statement` still runs, and says so:

```text
WARNING — no --statement was given. A real run will refuse to bill without the customer's own `mesh statement` file for period 2026-11.
```

Use that only to look at a ledger; it is not the check before billing.

A dry run with `--statement` and no `--customer-key` also runs. It checks that
the signature verifies and says which key signed, and it says plainly that
nobody checked whose key that is:

```text
WARNING — no --customer-key was given. A real run will refuse to bill without the statement key fingerprint the customer registered. This run checks that the statement's signature verifies and says which key signed it, but not whose key that is.
WARNING — the statement is signed by statement key adc3acb79facda9ed2e0e0c33b81d5db90edd498c75c80dbedb4e807c5217dcd, and no registered customer key was given to compare it with, so who wrote the statement was not checked.
Statement: statement matched: 1 spool, 2500 records (2500 in 2026-11), net verified savings $9.5947, fee 9 cents, signed by statement key adc3acb79facda9ed2e0e0c33b81d5db90edd498c75c80dbedb4e807c5217dcd (not compared with a registered key).
```

That is not the check before billing either. Do not copy the fingerprint it
prints into `--customer-key`: that would make the check pass for whoever wrote
the statement.

Payment terms default to 14 days; `--days-until-due <n>` changes them.

The line item tells the customer to run `mesh statement --period 2026-11`,
which they can, having produced the statement with it. The second command on
the line is an independent check of the savings only: the published verify
package checks the net savings; the fee in cents is checked by `mesh statement`.
The verify package itself was not run in this dry run.

### 7. The figures: the script compares them, and a mismatch stops it

You no longer compare the statement's figures with the bill by hand. With
`--statement`, `mesh-bill` checks that the statement's net verified savings and
fee in cents equal its own recompute from the spools, and prints the
`statement matched` line only when they do.

What a mismatch prints, from the dry run. Here the statement had been written
by an older build that rounded the fee to the nearest cent (3 cents on
US$2.6330), and the bill rounds down:

```text
DO NOT BILL — the fee differs: the statement says 3 cents, the bill's own recompute says 2 cents.
```

Exit 1, nothing sent. Do not try to get past it. The customer's recomputation
wins: find the cause (a different release on each side, a different set of
spools, a different price list), have the customer produce the statement again
on the current release if that is the cause, and bill the lower figure or
nothing.

### 8. Apply a carried deficit, by hand

`mesh-bill` has no memory of earlier months and no flag for a deficit. For a
first invoice there is nothing to carry. For later months:

- Look in the operator log for a deficit carried out of the previous period (a
  month whose net verified savings were negative; the statement file records it
  as `deficitCarriedForwardUsd`).
- If there is one, the fee is 1% of (this month's net verified savings minus the
  deficit), rounded down to the cent. If that is zero or less, there is no
  invoice; record the remaining deficit in the log.
- If it is positive, the amount `mesh-bill` plans is too high. Do not send its
  draft unchanged: correct the line amount and its text on the draft in the
  dashboard before sending, and record the arithmetic in the log.

This step has not been exercised in a dry run. If a deficit ever applies, treat
it as a reason to have the flag added to the script before billing.

### 9. Create the draft (founder only: needs the Stripe key)

A real run needs the statement, the customer's registered key and an ended
month. Test mode:

```bash
STRIPE_TEST_SECRET_KEY=sk_test_… node --import tsx scripts/mesh-bill.ts \
  --customer cus_XXX --period 2026-11 --fee 1 \
  --statement ~/mesh-billing/acme/2026-11/received/mesh-statement-2026-11.json \
  --customer-key <the fingerprint registered for this customer, from the operator log> \
  ~/mesh-billing/acme/2026-11/received/*.jsonl
```

Live mode also needs `--live` and the amount in cents re-typed. Read the amount
from the plan the dry run printed; the script does not hand it to you:

```bash
STRIPE_SECRET_KEY=sk_live_… node --import tsx scripts/mesh-bill.ts \
  --live --confirm-amount-cents <cents, read from the dry run> \
  --customer cus_XXX --period 2026-11 --fee 1 \
  --statement ~/mesh-billing/acme/2026-11/received/mesh-statement-2026-11.json \
  --customer-key <the fingerprint registered for this customer, from the operator log> \
  ~/mesh-billing/acme/2026-11/received/*.jsonl
```

On success the output is the dry-run output with `Creating` in place of
`Would create`, then:

```text
Created Stripe invoice in_… — status draft (TEST mode).
Left as a DRAFT. Review it in the Stripe dashboard (amount, currency, due date, line text) and send it from there.
```

Do not pass `--finalize`. Leave the draft for review.

Refusals, quoted from the dry run on `5316e36`, and for every row that
mentions a key or a signature from the runs on `0dc11d2`. Every one exits 1 and
sends nothing. The spool and statement checks print the same `DO NOT BILL` line
in a dry run, so you see them at step 6; that includes every signature refusal
except the missing `--customer-key`, which a dry run prints as a WARNING.

The script checks the statement in this order and stops at the first failure:
the seal; the signature (present, verifies, not this machine's own key, the
registered key); what the file is; the period; the spools; the figures.

| Printed | Cause | What to do |
|---|---|---|
| ``DO NOT BILL — a real run needs --statement <file>: the customer's own `mesh statement` file for period 2026-11. The spools passed are checked against it before anything is sent. (--dry-run works without one.)`` | No `--statement` on a real run | Get the customer's statement (step 1) |
| `DO NOT BILL — period 2026-11 has not ended (it ends 2026-12-01T00:00:00.000Z UTC)` | The month has not ended | Wait. There is no override |
| `DO NOT BILL — the ledger files passed are not the ledger the statement was computed from: the statement lists a spool that was not passed (head hash bcbe36d2…; expected 800 records, 800 in 2026-11). The statement covers 6 spools; 5 spools passed.` | A spool is missing | Ask the customer for the whole ledger again |
| `DO NOT BILL — the ledger files passed are not the ledger the statement was computed from: spool dryrun-agent-anthropic.jsonl (head hash 3b03f6ce…; 1799 records, 1799 in 2026-11) matches no spool in the statement; the statement lists a spool that was not passed (head hash a75d2ceb…; expected 1800 records, 1800 in 2026-11). The statement covers 6 spools; 6 spools passed.` | A spool is cut short (or has grown since the statement was written) | Ask for the ledger and a statement made at the same time |
| `DO NOT BILL — the ledger files passed are not the ledger the statement was computed from: spool dryrun-review-anthropic.jsonl (head hash bcbe36d2…; 800 records, 800 in 2026-11) matches no spool in the statement. The statement covers 5 spools; 6 spools passed.` | A spool was passed that the statement does not cover | Same |
| `DO NOT BILL — the statement is for period "2026-10", but the bill is for period 2026-11.` | The statement is for another month | Check `--period`; ask for the right statement |
| `DO NOT BILL — the statement does not match its sha256 seal: it was edited or damaged after it was written.` | The statement file was changed | Ask for it again |
| ``DO NOT BILL — a real run needs --customer-key <fingerprint>: the statement key fingerprint the customer registered when billing was agreed (their `mesh statement --key` prints it). The statement's signature is checked against it before anything is sent, so a statement written by anyone else is refused. (--dry-run works without one.)`` | No `--customer-key` on a real run | Take the fingerprint from the operator log. If none was ever registered, do the one-time setup first; do not read it off the statement |
| ``DO NOT BILL — --customer-key is not a statement key fingerprint. It is the 64 hexadecimal characters the customer's `mesh statement --key` prints, as recorded when billing was agreed.`` | The value is not 64 hexadecimal characters (cut short, or something else pasted) | Copy it again from the operator log |
| ``DO NOT BILL — the statement is not signed: it was written by a Mesh release that does not sign statements (it says Mesh 0.2.4; signing starts with 0.2.5), so nothing shows it came from the customer's own install. The customer must update to Mesh 0.2.5 or later and run `mesh statement --period 2026-11` again.`` | The customer wrote the statement with 0.2.4 (or earlier: the bracket names the release the statement says wrote it) | Ask the customer to update and write the statement again. Register their key first if they never have (one-time setup) |
| ``DO NOT BILL — the statement is not signed, although it was written by a Mesh build that signs every statement (it says Mesh 0.2.4): its signature was removed, or it was not written by `mesh statement`. The customer must run `mesh statement --period 2026-11` again and send that file.`` | The signature is missing from a statement written by a build that signs (the bracket is whatever version the statement names; the build this was run on reports itself as 0.2.4) | Ask for the statement again, and ask how the file was handled on the way |
| `DO NOT BILL — the statement's signature does not verify: the signature does not verify against the public key in the file. The signature, the key or the seal was changed after the statement was signed; ask the customer to write it again.` | The signature or the public key in the file was altered, or another statement's signature was pasted in | Ask for the statement again |
| `DO NOT BILL — the statement's signature does not verify: its signature's fingerprint is not the fingerprint of its public key. The signature, the key or the seal was changed after the statement was signed; ask the customer to write it again.` | The fingerprint written in the file was changed to one that is not its key's (here: the registered fingerprint pasted over another key's signature) | Stop. Treat it as an attempt to pass off someone else's statement; ask the customer directly |
| `DO NOT BILL — the statement is signed by statement key 1e84b3d1…, which is not the customer's registered key adc3acb7…. Never accept a new key that arrives with the statement: confirm a changed key with the customer through the agreed channel first (runbook, "The customer's key changed").` | The statement was signed by a different install from the one registered: the customer reinstalled or moved machine, the statement came from another of their machines, the wrong fingerprint was typed, or someone else wrote the statement | Check what you typed against the log. Otherwise [The customer's key changed](#the-customers-key-changed). Do not bill until that is done |
| `DO NOT BILL — this statement was written on this machine, not by the customer: it is signed by this machine's own Mesh install (statement key 1e84b3d1…). The statement must be the one the customer wrote on their own machine.` | The statement was produced on the operator's machine. Printed in a dry run too, and whatever `--customer-key` says | Rule 6. Ask the customer for their own statement. There is no way round this refusal on purpose |
| `DO NOT BILL — this machine's own statement key file (…/.mesh/identity/statement-key.json) could not be read as a statement key (it is not JSON), so the bill cannot rule out that the statement was written on this machine.` | The operator machine's own key file is damaged, so the check above cannot be made | Restore the operator's key file from a backup, or move it aside; then run again |
| `DO NOT BILL — the fee differs: the statement says 3 cents, the bill's own recompute says 2 cents.` | The two recomputations disagree | Step 7 |
| `DO NOT BILL — <file> could not be read as a statement file.` | The wrong file was given to `--statement` | Pass the `mesh-statement-YYYY-MM.json` file |
| `Refusing to run against a LIVE Stripe key. This creates real charges. Use a test key (sk_test_…), or pass --live deliberately together with --confirm-amount-cents.` | A live key without `--live` | Decide whether this is meant to be live |
| `REFUSING TO CHARGE — A LIVE charge must be confirmed by re-typing the amount it will charge, in cents, with --confirm-amount-cents. Read the amount from the plan printed above. Charging nothing.` | `--live` without the re-type | Read the amount from the plan and type it |
| `REFUSING TO CHARGE — Amount re-type mismatch: you typed 1235¢, which is not the amount the plan charges. Read the amount from the plan printed above. Charging nothing.` | The re-typed amount is wrong | Read it again; if the plan is not what you expected, stop |
| `--period YYYY-MM is REQUIRED (for example --period 2026-10). mesh-bill invoices one explicit period at a time; it will not bill the cumulative total of all recorded periods.` | No period given | Give the period |

(Head hashes and, in the last rows, key fingerprints are shortened here; the
script prints all 64 characters of both. Neither fingerprint is secret.)

### 10. Review the draft in the Stripe dashboard

Open the invoice id that was printed and check each of these against the dry
run and the statement:

- **Customer** is the right one, with the right billing email.
- **Amount** equals the statement's fee in cents. It is one line.
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
- the statement's `sha256` seal, and the `Statement: statement matched: …` line,
  which names the key that signed it;
- the registered fingerprint that was passed as `--customer-key`;
- net verified savings, fee in cents, deficit carried in and out;
- the commit of the checkout `mesh-bill` ran from (`git rev-parse --short HEAD`);
- the Stripe invoice id, mode (test or live), and its state (draft, sent, paid, void);
- for a do-not-charge month: that nothing was billed, and why.

## When the output is not what the step says

The refusals to do with the statement, the period and the live re-type are in
step 9. The rest:

| You see | What it means | What to do |
|---|---|---|
| `CHAIN BROKEN in <file>: …` then `DO NOT BILL — the ledger chain failed verification (see CHAIN BROKEN above). A statement over an unverifiable ledger is not an invoice.`, exit 1 | A record was changed, reordered or removed from the middle of a spool | Stop. No invoice. Ask the customer to send the ledger again; do not repair it |
| `DO NOT BILL — <file>: line N is not valid JSON, so the spool cannot be verified.`, exit 1 | The file is damaged or is not a spool | Stop. Ask for the file again |
| `DO NOT BILL — <file>: line N is not a ledger record…`, exit 1 | A file that is not a spool was passed | Pass only `<application>-<provider>.jsonl` files |
| `Skipped (not a ledger spool): ….features.jsonl` | The proxy's features file, sent along with the spools | Nothing; it is never billed from |
| `No events are recorded for 2026-10. Periods in the spool(s): 2026-11 (4800 records).` then `DO NOT BILL` | The wrong period was typed, or the customer sent the wrong month | Check the period; nothing was created |
| `DO NOT BILL — do_not_charge: the period's net verified savings were not positive, so nothing is billed.`, exit 0 | A month with no saving, or a net loss | No invoice. Tell the customer nothing is owed. Record any deficit in the log |
| `DO NOT BILL — do_not_charge: the 1% fee on $0.3558 net verified savings is below one cent, so nothing is billed yet.`, exit 0 | There were savings, but the fee is under one cent | No invoice. See the next section |
| A second draft for the same period | The script was run twice and the amounts differed, or a day apart | Delete the wrong draft before anything is sent; step 3 is the control |

### The customer's key changed

You will meet this as the refusal `the statement is signed by statement key …,
which is not the customer's registered key …`. A customer's fingerprint changes
when they reinstall MESH into an empty home folder, move it to another machine,
lose `~/.mesh/identity/statement-key.json`, or replace the key on purpose. It
also looks exactly like this when somebody else wrote the statement. The script
cannot tell these apart, and neither can you from the files alone.

1. **Do not bill, and do not pass the new fingerprint to `--customer-key`.**
   Never accept a new fingerprint that arrives in the same message as the
   statement, or that you read off the statement itself.
2. **Confirm the change out of band.** Reach the person named when billing was
   agreed, through the channel agreed in writing for the fingerprint (not by
   replying to the message the statement came in). Ask them whether their
   install changed and to read you the output of `mesh statement --key`.
3. **The customer re-registers** the new fingerprint the same way as the first
   (one-time setup): through the agreed channel, on its own.
4. **Record it in the operator log**: the old fingerprint, the new fingerprint,
   the date, who confirmed it and how. Keep the old entry; do not overwrite it.
5. **Then bill**, with the new fingerprint as `--customer-key`. A statement
   signed by the old key is refused from now on; if the month's statement was
   written before the change, ask for it again.

If the customer says their install did not change, the statement did not come
from them. Stop, keep everything that arrived, and tell the founder.

A customer who still has the old key file can avoid all of this by copying
`~/.mesh/identity/statement-key.json` to the same place on the new machine
before writing a statement: the fingerprint stays the same. (Shown in the dry
run on `0dc11d2`: the key file copied into an empty home printed the same
fingerprint.) What the customer sees when the file is damaged rather than
missing, on `0dc11d2`, exit 1, no statement written:

```text
The statement key file …/.mesh/identity/statement-key.json exists but is not a usable statement key: it is not JSON. MESH will not replace it for you: a new key has a new fingerprint, and MESH bills only against the fingerprint you registered. If the file is damaged, restore it from a backup. To start a new key on purpose, move the file aside, run `mesh statement --key`, and register the new fingerprint with MESH through the channel agreed in writing.
```

### The customer's `mesh verify` says "(charge)" but nothing is owed

This applies to any customer still on 0.2.3. Seen in the dry run on a ledger
from the shipped 0.2.3 runtime (stand-in provider, not a customer result): 696
requests, net verified savings US$0.3558. The customer's own 0.2.3 tool printed:

```text
✓ determinism  invoice recomputes identically: $0.3558 verified (charge)
```

and `mesh status` printed `696 requests seen · $0.3558 verified saved (charge)`.
`mesh-bill --dry-run --statement`, on the same spools, printed (the two warnings
about the unfinished month are left out here):

```text
Net verified savings: $0.3558
Statement: statement matched: 6 spools, 696 records (696 in 2026-11), net verified savings $0.3558, fee 0 cents.

DO NOT BILL — do_not_charge: the 1% fee on $0.3558 net verified savings is below one cent, so nothing is billed yet.
```

It plans no invoice and no zero-value draft. On the earlier commit `c3605c1`,
before the script refused unfinished months, the same case was also run in real
mode with a fake key and a recorder in place of the network: the same refusal,
and no request was made.

Why: in 0.2.3 the word in brackets only says that net savings are positive. It
is not the bill's decision. The fee is 1% of US$0.3558, which is about a third
of a cent, and the smallest amount that can be invoiced is one cent.

The fix is in the release that carries these branches. Built from `5316e36`
(which reports itself as `mesh 0.2.4`), the same ledger prints:

```text
✓ determinism  invoice recomputes identically: $0.3558 verified (do_not_charge: the 1% fee is below one cent)
```

`mesh status` carries the same note, and the statement says
`Verdict  do_not_charge` with the reason under it. Until a customer has updated,
their 0.2.3 output still says "(charge)".

What to tell a customer on 0.2.3: "Your savings this month were real and
verified, and the fee on them is less than one cent, so there is no invoice.
The word '(charge)' in your `mesh verify` output means your savings were
positive; it does not mean you owe anything. The current release words this
correctly."

## What the dry run showed

Dry run only. Ledgers written by the shipped 0.2.3 runtime
(`npx -y @harrym1707/mesh@0.2.3`) with `mesh proxy` in front of a local stand-in
provider, default lossless levers, period 2026-11. **These are not customer
results and say nothing about what MESH saves on real traffic.** One further
ledger of the same kind was made by the overwatch session.

Which code each figure came from: the `mesh verify` column is the shipped 0.2.3
runtime (build `51bee22`). The statement, `mesh-bill --dry-run --statement` and
the stubbed Stripe request are all commit `5316e36`. The "before" column is what
`mesh-bill` planned on `c91f635`, when the fee was still rounded to the nearest
cent.

| Ledger | Requests | `mesh verify` 0.2.3: net | Statement: net, fee | `mesh-bill --dry-run --statement` | `mesh-bill` before (`c91f635`) |
|---|---|---|---|---|---|
| one round | 24 | $0.0131 (charge) | US$0.0131, 0 cents, do_not_charge | matched; DO NOT BILL | DO NOT BILL |
| sub-cent | 696 | $0.3558 (charge) | US$0.3558, 0 cents, do_not_charge | matched; DO NOT BILL | DO NOT BILL |
| volume | 4,800 | $2.4494 (charge) | US$2.4494, 2 cents, charge | matched; 2 cents, key `mesh-cus_TEST-2026-11-2-item` | 2 cents |
| volume B | 5,160 | $2.6330 (charge) | US$2.6330, 2 cents, charge | matched; 2 cents, key `mesh-cus_TEST-2026-11-2-item` | 3 cents |
| overwatch | 2,500 | $9.5947 (charge) | US$9.5947, 9 cents, charge | matched; 9 cents, key `mesh-cus_TEST-2026-11-9-item` | 10 cents |

Net verified savings agreed across all three tools in every row, and the
statement and the bill agreed on the fee in every row: 0, 0, 2, 2 and 9 cents.
The statement prints the rounding, for example
`US$0.09  (9 cents; US$0.095947 rounded down to the cent, so never more than 1%)`.
The two rows that changed are the defect the round-down rule fixes: 3 cents on
US$2.6330 was 1.14%, and 10 cents on US$9.5947 was 1.04%.

For all five ledgers the real-mode run (fake test key, network replaced by a
recorder, `--statement` given) printed
`DO NOT BILL — period 2026-11 has not ended (it ends 2026-12-01T00:00:00.000Z UTC)`
and the recorder logged no request.

### The success path: what was and was not shown

- **Not shown:** a real-mode run that reaches Stripe on a ledger from the
  shipped runtime. Those ledgers are all dated November 2026, and the script
  will not bill them before 1 December 2026.
- **Shown with a hand-made sample:** a four-record sample spool dated October
  2026, built with the repository's own chain helper and not by the shipped
  runtime, with a statement produced from it by the runtime built from
  `5316e36`. With a fake test key and the network replaced by a recorder, the
  real-mode run printed `Statement: statement matched: 1 spool, 4 records (3 in
  2026-10), net verified savings $1234.5600, fee 1234 cents.`, then the two
  requests it would have sent (`collection_method=send_invoice`,
  `days_until_due=14`, `amount=1234`), then `Created Stripe invoice in_STUB_1 —
  status draft (TEST mode).` Nothing was sent.
- **Shown with a hand-made sample, signed (on `0dc11d2`):** a two-spool,
  five-record sample dated October 2026, built with the repository's own chain
  helper, one spool carrying a lever that lost money. The "customer" (one home
  folder) wrote and signed the statement; the "operator" (another home folder,
  with its own Mesh install and key) ran the bill with a fake test key and the
  network replaced by a recorder. With both spools and the customer's
  fingerprint the real-mode run printed `Statement: statement matched: 2 spools,
  5 records (4 in 2026-10), net verified savings $1000.0000, fee 1000 cents,
  signed by the customer's registered statement key c674c430….`, then the two
  requests it would have sent (`collection_method=send_invoice`,
  `days_until_due=14`, `amount=1000`), then `Created Stripe invoice in_STUB_1 —
  status draft (TEST mode).` Nothing was sent.
- **The case signing exists for, on the same sample:** with the losing spool
  left out, the customer's statement was refused (`the statement lists a spool
  that was not passed … The statement covers 2 spools; 1 spool passed.`). The
  operator then wrote a statement over the one spool that had arrived, on the
  operator's machine: it showed 1234 cents, 234 cents more than the customer
  owed, and without a registered key to compare (dry run, from a machine with no
  Mesh install) every other check passed it. In real mode with the customer's
  fingerprint it was refused as `this statement was written on this machine, not
  by the customer`; run from a machine with no Mesh install it was refused as
  signed by a key that `is not the customer's registered key`; and the same
  statement written by the 0.2.4 runtime was refused as `not signed`. In none of
  these did the script attempt a request (the network was set to fail loudly if
  it had).
- **Covered by unit tests:** the statement, spool, period and signature checks
  are pure functions in `packages/core/src/manual-billing-checks.ts`, with tests
  beside them in `manual-billing-checks.test.ts` (20 tests, passing on
  `5316e36`; 34 on `0dc11d2`). The key file and the command are tested in
  `packages/cli/src/statement-key.test.ts` and `statement.test.ts`. The
  `--customer-key` handling in `scripts/mesh-bill.ts` itself has no automated
  test; it was exercised by the runs above.
- **Still to do:** Stripe test-mode step 2 below, with a real test key, on a
  month that has ended.

Other things the dry run showed that an operator should know:

- The shipped 0.2.3 `mesh verify` prints one net figure for the whole ledger,
  with no period and no fee. Only the statement gives a per-month figure and the
  fee.
- A spool with one saving edited fails in `mesh-bill` (`CHAIN BROKEN`, exit 1).
  The customer's own `mesh verify` 0.2.3 on that ledger marked the ledger line
  `✗` and still printed `$102.4494 verified (charge)` on the next line. Built
  from `5316e36`, `mesh verify` prints `– determinism  not checked: the ledger
  did not verify` and exits 1, and `mesh status` prints
  `4800 requests seen · ledger did NOT verify, so no savings figure · run: mesh verify`
  with no figure and no sign-up line. A customer on 0.2.3 with a damaged ledger
  still sees a dollar figure from both commands; do not take it as verified.
- Two different ledgers whose fee comes to the same number of cents get the same
  idempotency key (volume and volume B above). That only matters for one
  customer and period, where it is the intended behaviour.
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
   with the test key, a test `cus_…`, and the spools and a signed statement for
   a month that has ended, with `--customer-key` set to the fingerprint of the
   install that wrote the statement. Write the statement on a different machine
   (or under a different home folder) from the one the bill runs on: the script
   refuses a statement signed by its own machine. Expect: one draft in the test
   dashboard, not empty, collection method "send invoice", due in 14 days. This
   is the step that matters most for a first invoice.
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
  US$21.63 bills 21 cents, US$0.50 and US$0.99 bill nothing and US$1.00 bills
  1 cent.
  **Until both pull requests are merged and released, nobody should promise
  "never more than 1%"**, and a customer on 0.2.3 can still see "(charge)" from
  `mesh verify` when they owe nothing.

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

- **No record of billed periods.** Step 3 and the operator log are the control.
- **No carried deficit.** Step 8 is by hand.
- **No re-derivation of savings from provider usage at bill time.** The
  automated worker does this; the manual script bills the recorded figures once
  the chain verifies and the customer's statement agrees.
- **No ceiling on the amount.** The draft and the human review are the control.
- **The signature is only as good as the registration.** The script now
  refuses a statement that was not signed by the key registered for the
  customer, so the operator cannot write the statement from the files that
  arrived. What it rests on is the fingerprint in the operator log: it is only
  as trustworthy as the channel it was registered through, and the script does
  not hold it (it is typed in on each run). A customer who loses the key file,
  reinstalls or moves machine must register a new fingerprint the same way
  before their next statement
  ([The customer's key changed](#the-customers-key-changed)).
- **The signature does not show the customer's ledger is complete.** It shows
  which install wrote the statement, not that every spool on that machine went
  into it. A customer who leaves spools out lowers their own savings and fee
  (unless a spool held a net loss), and their recomputation wins in any case.
- **It is not protection against an operator who bypasses the script.** Someone
  who ignores `mesh-bill` and creates an invoice in the dashboard by hand, or
  runs the bill from a machine without their Mesh install and passes their own
  fingerprint as the customer's, is not stopped by it. It is a control against
  writing the statement from whatever files arrived, by mistake or to get past
  a refusal; the operator log and the review of the draft are the rest.
- **One key per install, not per customer.** A customer with several machines
  writing to several ledgers has several keys; the script takes one
  `--customer-key`. Until that is built, the statement must come from the one
  install whose fingerprint is registered, over all the spools.
