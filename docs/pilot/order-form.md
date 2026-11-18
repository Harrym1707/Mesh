# MESH order form (draft)

> **DRAFT for the founder and a solicitor. Not legal advice. Not reviewed by
> a lawyer. Not to be sent to anyone.** Written 2026-11-18 from
> [pilot-agreement.md](./pilot-agreement.md) and the website's
> [Terms of use](../site/terms.md) (last updated 12 November 2026). No
> customer has signed it or been shown it.
>
> Everything in [square brackets] is a blank for the founder or a solicitor
> to fill. None of the blanks has a default. The list of them, and of what
> this draft does not cover, is at the end.

**What this is for.** MESH is open to everyone and free to install and run.
The Terms say no fee is due unless billing has been agreed in writing. This
form is that agreement, for a customer who wants to pay for MESH in
production. It is not needed to install or use MESH, and it is separate from
the optional [pilot](./pilot-agreement.md).

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

- The fee is **1% of net verified savings** for each billing period, and
  nothing else. There is no subscription, seat charge or minimum.
- **Nothing is due for a period** when its verdict is `do_not_charge`. That
  is the verdict when net verified savings for the period, to the nearest
  cent, are zero or negative.
- **Nothing is invoiced for a period** when the fee would be less than
  [smallest invoice worth sending: amount and currency]. [What happens to a
  fee below that amount, whether it is waived or added to a later period:
  founder to decide.]
- [Carry-forward: whether a period with negative net verified savings reduces
  the fee in later periods, so that total fees never exceed total verified
  savings. Founder and solicitor to decide, then state it here.]
- Fees exclude VAT and similar taxes, which are added where they apply.
  [VAT wording: the supplier's VAT status and number, and the treatment of a
  business customer outside the United Kingdom.]

## 4. The billing period

A billing period is one calendar month. MESH assigns each request to the
month of its timestamp in UTC, and that is the month it is billed in.

## 5. What is measured, and from what

Net verified savings are computed from **your own ledger**: the hash-chained
files MESH writes on your machine, in `~/.mesh/ledger/` unless you chose
another folder.

- **What you spent** is taken from the usage your provider reported for each
  request, priced against a dated price catalogue whose version is recorded
  on each ledger line.
- **What a token-reduction lever saved** is an estimate of the tokens it
  removed, anchored to the provider's reported input total. Every such figure
  is labelled `estimated-baseline` on the ledger line and on the statement
  line. An estimate is never presented as a measurement.
- **A change that can alter an answer** counts towards the fee only with an
  approved replay verdict on your own traffic. Without one its saving is
  recorded and not billed.
- **Savings you already had** (your provider's own caching, a gateway cache)
  are recorded and never billed.
- **A failed request** bills nothing. **A request the catalogue cannot
  price** is excluded, never priced at zero.
- **A component that cost you money** counts against us: negative amounts
  reduce net verified savings and are never rounded up to zero.

The ledger and the statement are computed in US dollars.

## 6. Your right to recompute

You can recompute net verified savings from your ledger at any time, with
`mesh verify` (no network calls) or with the separate `@harrym1707/verify`
package. **If your recomputation of the same ledger differs from our
statement, yours prevails.**

[How long after a statement you may raise a difference, and what happens to
an invoice already paid: founder and solicitor to decide.]

## 7. What you send us, and how

For each billing period you send us:

1. the ledger files for that period from your ledger folder. These are the
   files that do not end in `.features.jsonl`; and
2. the output of `mesh verify` run on the same machine.

The ledger files contain usage numbers, lever names and hashes, and no prompt
or completion text. You are welcome to open them before you send them.

You send them by [how the files reach us: founder to decide. There is no
contact email address yet, and ledger files must not be attached to a public
GitHub issue], within [number] days of the end of the period. If we do not
receive them, [consequence: founder and solicitor to decide].

## 8. Data handling

What MESH stores, what leaves your machine and what does not are set out in
[data-handling.md](./data-handling.md) and in our
[privacy policy](../site/privacy.md), which also says how long we keep the
ledger files and invoice records you send us. This order adds nothing to
them. [Whether a data processing agreement is needed: solicitor to decide.]

## 9. Statements and invoices

- We do not take payment automatically. For each period we send a
  **statement** and, where a fee is due, an **invoice**.
- The statement shows, for the period: net verified savings, the saving by
  lever with any `estimated-baseline` label, savings recorded but not billed,
  savings you already had, requests excluded as unpriced, the verdict, and
  the fee.
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
| Smallest invoice worth sending, and what happens to a fee below it | 3 | Founder |
| Carry-forward of a negative period | 3 | Founder and solicitor |
| VAT wording | 3 | Founder, with an accountant or solicitor |
| Time limit for raising a difference; treatment of a paid invoice | 6 | Founder and solicitor |
| How ledger files reach us; days to send them; what happens if they are not sent | 7 | Founder and solicitor |
| Whether a data processing agreement is needed | 8 | Solicitor |
| Invoice currency, and the exchange rate basis if not US dollars | 9 | Founder |
| Payment days, payment route, late payment | 9 | Founder and solicitor |
| Notice periods and our grounds for ending | 10 | Solicitor |
| Whether email agreement is enough, and who may give it | 11 | Solicitor |

## Notes for the founder and the solicitor (not part of the order)

**Checked against the Terms on `main`, 2026-11-18.** Sections 3, 6, 9 and 10
repeat the Terms' Fees and Ending sections in substance: 1% of verified
savings for the month and nothing else; computed from the ledger on the
customer's machine; recomputable with `mesh verify` or `@harrym1707/verify`,
and the customer's recomputation prevails; nothing owed for a `do_not_charge`
month; no automatic payment, a statement and an invoice; fees exclude VAT;
fees already earned remain payable. Liability, licence and governing law are
incorporated and not restated. The Terms' Contact section gives a postal
address only.

**Where this draft says more than the Terms, for review:**

- Section 3 separates "nothing is due" (`do_not_charge`) from "nothing is
  invoiced" (a fee below the smallest invoice). The Terms have only the
  first.
- Section 5 spells out what "verified savings" are computed from. The
  wording follows the ledger code
  (`packages/core/src/savings-ledger.ts`) and
  [data-handling.md](./data-handling.md). The Terms say savings are
  "estimate[d] from the provider's own reported usage"; this draft says which
  lines are estimates.
- Section 7 obliges the customer to send ledger files. The Terms do not.

**What the tooling does today, so the blanks are filled knowingly:**

- The invoice tool on `main` (`scripts/mesh-bill.ts`) returns `do_not_charge`
  when net verified savings round to zero cents or less, and separately
  declines to bill a fee that rounds below one cent. There is no other
  minimum.
- The ledger code can carry a deficit forward
  (`carryForwardDeficitUsd`), but `scripts/mesh-bill.ts` on `main` does not
  pass one, so today each month is computed on its own.
- Amounts are computed in US dollars. Nothing converts currency.
- `scripts/mesh-bill.ts` creates a draft invoice in Stripe and has only been
  used in Stripe test mode. No live key has been used and no customer has
  been invoiced.
- There is no installed command that produces the statement in section 9 for
  the customer to see. `mesh verify` prints the net figure and the verdict.

**Not covered in this draft:** confidentiality, service levels or support,
assignment, notices beyond email, entire-agreement wording, anything about
intellectual property beyond the Terms, and whether a customer may run MESH
for more than one legal entity under one order.
