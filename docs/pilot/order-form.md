# MESH order form (draft)

> **DRAFT for the founder and a solicitor. Not legal advice. Not reviewed by
> a lawyer. Not to be sent to anyone.** Written 2026-11-18 from
> [pilot-agreement.md](./pilot-agreement.md) and the website's
> [Terms of use](../site/terms.md); brought to release 0.2.4 and the Terms
> as last updated 18 November 2026 on 2026-11-19. No customer has signed it
> or been shown it.
>
> Everything in [square brackets] is a blank for the founder or a solicitor
> to fill. None of the blanks has a default. The list of them, and of what
> this draft does not cover, is at the end.

**What this is for.** MESH is open to everyone and free to install and run.
The Terms say no fee is due unless billing has been agreed in writing. This
form is that agreement, for a customer who wants to pay for MESH in
production. It is not needed to install or use MESH, and it is separate from
the optional [pilot](./pilot-agreement.md). The public explanation of the fee
is the website's [Pricing and billing](../site/pricing.md) page; this order
is written to agree with it.

**How it fits with the Terms.** This order incorporates the
[Terms of use](../site/terms.md) [as published on the order date / as updated
from time to time: solicitor to choose]. It does not restate them. In
particular the software licence, what the software does, acceptable use,
liability, and governing law are as the Terms set them out. If this order and
the Terms conflict, [which prevails: solicitor to decide].

---

## 1. Parties

**Supplier ("we", "us"):** Flux AI Technologies Limited, trading as Mesh, a
company registered in England and Wales with company number 17543982, whose
registered office is as stated in the Terms.

**Customer ("you"):** [customer's full legal name], [company number and place
of registration, if a company], of [customer's address].

| | Supplier | Customer |
|---|---|---|
| Contact for this order | [name] | [name] |
| Email for statements, invoices and notices | [supplier contact email address] | [customer email address] |
| Statement key fingerprint | | [applies from 0.2.5, not yet released: leave blank until then] |

**Order date:** [date]. **First billing period:** [month and year].

## 2. What MESH is and where it runs

MESH is software that runs on your own machines, between your applications
(or Claude Code) and your AI provider. It removes tokens from requests before
they are sent and records each request's usage in a ledger on your machine.

- It is installed and run by you. We do not host it and are not in your
  request path.
- Your provider API key passes through to your provider and is not stored by
  MESH. Your prompts and completions are not written to the ledger and are
  not sent to us.
- By default MESH applies only changes designed not to alter your provider's
  answer. A change that can alter an answer is applied only after it has been
  measured on your own traffic, and only when you accept it or have chosen a
  setting that applies such changes automatically. We recommend leaving that
  setting at its default (`recommend`), which waits for your yes.

We do not promise that MESH will save you money. The Terms say what the
software does and what remains your responsibility.

## 3. The fee

- The fee is **1% of net verified savings** for each billing period,
  **rounded down to the cent**, and nothing else. There is no subscription,
  seat charge or minimum. Because it is rounded down, the fee is never more
  than 1% of the saving.
- **Nothing is due for a period** when its verdict is `do_not_charge`. That
  is the verdict when net verified savings for the period are zero or
  negative, or when 1% of them comes to less than one cent.
- **Nothing is invoiced for a period** when the fee would be less than
  [smallest invoice worth sending: amount and currency]. [What happens to a
  fee below that amount, whether it is waived or added to a later period:
  founder to decide.]
- Within a period, a component that cost you money is set against the ones
  that saved you money. [Carry-forward between periods: whether a period with
  negative net verified savings reduces the fee in later periods. The
  statement records such a deficit, and our billing procedure applies it by
  hand; neither the Terms nor the pricing page states it. Founder and
  solicitor to decide whether it is promised here.]
- Fees exclude VAT and similar taxes, which are added where they apply.
  [VAT wording: the supplier's VAT status and number, and the treatment of a
  business customer outside the United Kingdom.]

## 4. The billing period

A billing period is one calendar month in UTC. A request counts in the month
it started in.

## 5. What is measured, and from what

Net verified savings are computed from **your own ledger**: the hash-chained
files MESH writes on your machine, in `~/.mesh/ledger/` unless you chose
another folder.

- **What you spent** is taken from the usage your provider reported for each
  request, priced against a dated price catalogue whose version is recorded
  on each ledger line.
- **What a token-reduction lever saved** is an estimate of the tokens it
  removed, priced at the same rate. Every such figure is labelled
  `estimated-baseline` on the ledger line and *estimated baseline* on the
  statement. An estimate is never presented as a measurement.
- **A change that can alter an answer** counts towards the fee only with an
  approved replay verdict on your own traffic. Without one its saving is
  recorded and not billed.
- **Savings you already had** (your provider's own caching, a gateway cache)
  are itemised and never billed.
- **A failed task** bills nothing. **A request the catalogue cannot price**
  is excluded, never counted as a saving.
- **A component that cost you money** counts against us: negative amounts
  reduce net verified savings and are never rounded up to zero.

The ledger and the statement are computed in US dollars.

## 6. Your right to recompute

You can recompute a billing period from your own ledger at any time:

```bash
mesh statement --period YYYY-MM
```

It re-checks the ledger's hash chain, recomputes that month, prints the
savings by lever, the fee and the verdict, and writes a statement file. It
makes no network calls. It needs MESH 0.2.4 or later; `mesh version` says
which you have.

`mesh verify` re-checks the whole ledger and gives the total since install,
not one month. The separate `@harrym1707/verify` package recomputes a ledger
file without using the installed program at all.

**If your recomputation of the same ledger differs from our statement, yours
prevails.**

[How long after a statement you may raise a difference, and what happens to
an invoice already paid: founder and solicitor to decide.]

## 7. What you send us, and how

After each billing period has ended, you run `mesh statement --period YYYY-MM`
on the machine MESH runs on and send us:

1. **the statement file** it writes, `mesh-statement-YYYY-MM.json` in the
   folder you ran it from unless you pass `--out`; and
2. **the ledger files it was made from**: every file in your ledger folder
   named `<application>-<provider>.jsonl`. The `.features.jsonl` files beside
   them are not needed.

Run it after the month has ended. A statement made earlier says that the
period has not ended yet and cannot be billed from.

A ledger file is not per period: it holds every request since it was started,
so you send the same files each time, a little longer. The statement names
the month's lines. Both hold usage numbers, lever names, model names and
hashes, and never your prompts, your completions or your API key. You are
welcome to open them before you send them, and `mesh statement --check <file>`
tells you whether a statement file has been altered since it was written.

You send them by [how the files reach us: founder to decide. There is no
contact email address yet. The pricing page asks a customer to open a GitHub
issue titled "Billing", without figures or files, and says we reply with a
private way to continue], within [number] days of the end of the period. If we
do not receive them, [consequence: founder and solicitor to decide].

## 8. Data handling

What MESH stores, what leaves your machine and what does not are set out in
[data-handling.md](./data-handling.md) and in our
[privacy policy](../site/privacy.md), which also says how long we keep the
ledger files and invoice records you send us. This order adds nothing to
them. [Whether a data processing agreement is needed: solicitor to decide.]

## 9. Statements and invoices

- We do not take payment automatically. For each period we recompute the same
  figure from the same ledger and send you a **statement** and, where a fee
  is due, an **invoice**.
- The statement shows, for the period: the requests counted and excluded, the
  verified saving by lever with its *estimated baseline* or *measured* label,
  savings you already had, the baseline and actual cost, net verified
  savings, the fee and the verdict.
- The invoice is in [invoice currency]. [If that is not US dollars: the
  exchange rate used and its date.]
- Payment is due within [payment days] days of the invoice date, by [payment
  route]. [Late payment: founder and solicitor to decide.]

## 10. Term and ending

- This order starts on the order date and continues month to month.
- You can stop at any time. Stopping MESH or removing it ends the measurement;
  your ledger stays on your machine. [Whether you must also tell us, and how
  much notice either side gives: founder and solicitor to decide.]
- We may end this order [on what notice, and for what reasons beyond those in
  the Terms: solicitor to decide].
- Fees already earned for periods before the end remain payable.

## 11. Agreement

*Either* signed:

| | Supplier | Customer |
|---|---|---|
| Name | [name] | [name] |
| Position | [position] | [position] |
| Signature | | |
| Date | [date] | [date] |

*Or* agreed by email: we send this order, completed, from [supplier contact
email address] to the customer's email address above, and the customer
replies "Agreed". The order date is the date of that reply.
[Solicitor to confirm that email agreement is enough for this order and who
on each side may give it.]

---

## Blanks in this draft, and whose they are

| Blank | Section | Whose |
|---|---|---|
| Version of the Terms incorporated; which document prevails | top | Solicitor |
| Supplier contact email address | 1, 7, 11 | Founder |
| Customer details, order date, first billing period | 1 | Per customer |
| Statement key fingerprint (from 0.2.5, not yet released) | 1 | Per customer, once the release exists |
| Smallest invoice worth sending, and what happens to a fee below it | 3 | Founder |
| Carry-forward of a negative period | 3 | Founder and solicitor |
| VAT wording | 3 | Founder, with an accountant or solicitor |
| Time limit for raising a difference; treatment of a paid invoice | 6 | Founder and solicitor |
| How the files reach us; days to send them; what happens if they are not sent | 7 | Founder and solicitor |
| Whether a data processing agreement is needed | 8 | Solicitor |
| Invoice currency, and the exchange rate basis if not US dollars | 9 | Founder |
| Payment days, payment route, late payment | 9 | Founder and solicitor |
| Notice periods and our grounds for ending | 10 | Solicitor |
| Whether email agreement is enough, and who may give it | 11 | Solicitor |

## Notes for the founder and the solicitor (not part of the order)

**Checked against the Terms and the pricing page on `main`, 2026-11-19.**
Sections 3, 4, 6, 7, 9 and 10 repeat the Terms' Fees and Ending sections and
the pricing page in substance: 1% of verified savings for the month, rounded
down to the cent, and nothing else; the month is the calendar month in UTC;
computed from the ledger on the customer's machine; a month recomputed with
`mesh statement --period YYYY-MM`, the whole ledger with `mesh verify`, or
with `@harrym1707/verify`, and the customer's recomputation prevails; nothing
owed for a `do_not_charge` month; the customer sends the statement file and
the ledger files; no automatic payment, a statement and an invoice; fees
exclude VAT; fees already earned remain payable. Liability, licence and
governing law are incorporated and not restated. The Terms' Contact section
gives a postal address only.

**Where this draft says more than the Terms, for review:**

- Section 3 separates "nothing is due" (`do_not_charge`) from "nothing is
  invoiced" (a fee below the smallest invoice). The Terms and the pricing
  page have only the first.
- Section 3 mentions carry-forward between periods as an open point. The
  Terms and the pricing page do not mention it.
- Section 7 obliges the customer to send the statement file and the ledger
  files. The pricing page describes that; the Terms do not oblige it.

**What the tooling does today (release 0.2.4, checked 2026-11-19), so the
blanks are filled knowingly:**

- **Rounding.** The fee is 1% of net verified savings rounded down to the
  whole cent, in one function (`feeCents` in
  `packages/core/src/savings-ledger.ts`). Run on 2026-11-19: a saving of
  $21.63 gives 21 cents; $1.50 gives 1 cent; $1.00 gives 1 cent; $0.99 and
  $0.50 give nothing. So the only floor is one cent, reached at $1.00 of net
  verified savings, and nothing stops a 2-cent invoice. These are arithmetic
  examples, not results.
- **Verdict.** `do_not_charge` when the fee is below one cent, which covers
  zero and negative savings. `mesh verify`, `mesh status` and
  `mesh statement` all print the same verdict on 0.2.4. An install still on
  0.2.3 can print `(charge)` in `mesh verify` for a month in which nothing is
  owed; the invoice follows our recompute, not that line.
- **The customer's statement.** `mesh statement --period YYYY-MM` exists from
  0.2.4. Flags: `--ledger <dir>`, `--out <file>`, `--json`, `--check <file>`.
  Run on 2026-11-19 on the website's 0.2.4 against a test ledger: it printed
  the period, the chain check, requests counted and excluded, savings by
  lever, totals, fee, verdict and price list, and wrote
  `mesh-statement-2026-11.json` with a sha256 seal. For a month that had not
  ended it printed `THIS PERIOD HAS NOT ENDED YET: these figures can still
  change`. `--check` passed on the file and failed on an edited copy. An
  install on 0.2.3 has no `mesh statement` and must update first.
- **Our invoice tool** (`scripts/mesh-bill.ts`) needs `--period`, refuses a
  month that has not ended, and on a real run needs the customer's own
  statement file (`--statement`) and checks it against the ledger files and
  its own recompute; any mismatch is "do not bill". `--dry-run` reads no
  Stripe key and sends nothing. The procedure is
  `docs/ops/first-invoice-runbook.md`. That runbook records that none of its
  runs reached Stripe, in test or live mode, and no customer has been
  invoiced.
- **Payment terms in the tool.** The draft it creates is a send-an-invoice
  draft with 14 days to pay by default (`--days-until-due`). Nothing in the
  Terms states a number, which is why section 9 leaves it blank.
- **Carry-forward.** The statement file records a deficit for a negative
  month (`deficitCarriedForwardUsd`). `scripts/mesh-bill.ts` has no memory of
  earlier months and no flag for a deficit; the runbook applies it by hand
  and says that step has not been exercised.
- **Currency.** Amounts are computed in US dollars and every invoice the tool
  drafts is in US dollars. Nothing converts currency.
- **Statement key fingerprint.** Reported for release 0.2.5: the customer's
  install signs its statement, and billing needs the customer's statement key
  fingerprint, given once at onboarding through the agreed written channel
  and registered again after a reinstall or a new machine. On 2026-11-19
  there is no `--key` flag on `main` or on any branch of the repository, so
  this draft has only the blank in section 1 and tells nobody to run a
  command their install does not have. When 0.2.5 exists: add how the
  customer reads the fingerprint, where it is recorded, and the re-register
  rule.

**Not covered in this draft:** confidentiality, service levels or support,
assignment, notices beyond email, entire-agreement wording, anything about
intellectual property beyond the Terms, and whether a customer may run MESH
for more than one legal entity under one order.
