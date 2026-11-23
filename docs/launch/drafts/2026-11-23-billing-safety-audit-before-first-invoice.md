# Six bugs we found in our own billing code before sending a real invoice

MESH bills 1% of verified savings. That means the billing path has to be
right in a way most SaaS billing doesn't: not just "did we charge the right
plan price" but "did we correctly measure savings, net it against a 1% rate,
round it the way we promised, and agree with ourselves everywhere we show a
number." In the week before our first manually-run customer invoice, we went
looking for places that promise could quietly break. We found six. Here's
what they were, in plain terms, with the commits if you want to read the
diffs yourself.

## 1. Rounding the fee could bill more than 1%

`c3605c1` — the invoice recompute rounded the fee to the nearest cent instead
of down. On $21.63 of net verified savings, 1% is 21.63 cents, which rounds
up to 22 cents. Twenty-two cents on $21.63 is 1.017%, not 1%. Small on one
invoice; wrong on every invoice, in the direction that favors us, which is
the direction we most need to not be wrong in. `feeCents()` is now the one
place the fee gets rounded, and it always rounds down, with a guard against
floating-point pushing an exact N-cent fee down to N-1.

## 2. "Charge" could mean nothing was actually due

Same commit: whenever net verified savings rounded to a positive cent, the
verdict said `charge`, even if 1% of that figure was below one cent and
nothing would ever be billed. A customer could read "(charge)" next to a
real dollar figure and reasonably think they owed something. The verdict is
now `do_not_charge` whenever the fee itself is under a cent, with a reason
attached: `"$0.3609 verified (do_not_charge: the 1% fee is below one cent)"`.

## 3. The verdict you saw depended on which command you ran

`f52dcdd` — `mesh verify`, `mesh status`, the `mesh start` summary line, and
the dashboard each recomputed the invoice independently, and none of them
applied a fee. So all four could only ever say whether net savings were
positive, never whether anything was actually billable. A customer owing
nothing could see "(charge)" from one command and a correct verdict from
another, depending on which one they happened to run. We added one function,
`bill-verdict.ts`, that recomputes at the real contracted rate, and pointed
all four surfaces at it. There is now exactly one place that decides what
"charge" means.

## 4. A broken ledger could still print a dollar figure

`8975272` and `5316e36` — if you hand-edited one saving in the ledger, the
hash chain would fail to verify, but `mesh verify` and `mesh status` printed
a dollar total anyway on the next line, ticked, as if the chain were fine.
The entire point of a hash-chained ledger is that a verified number means
something and a tampered one is caught. A verified-looking number next to a
failed check defeats that. Both commands now refuse to print a figure at all
when the chain doesn't check out — a dash, "not checked: the ledger did not
verify," and a non-zero exit. No number is better than a number you can't
trust, especially when the number is an invoice.

## 5. "Never billed" was describing something we don't do

`3b497dc` and `1f4f2e2` — a summary line said unpriced events are "excluded,
never billed." That's not what the recompute does. An unpriced event (for
example, an exact-cache hit that has no provider usage line to price
against) still carries a lever with a measured saving, and that lever still
bills. The count of unpriced events was true; the English sentence
describing what happens to them was not. We changed the line to state what
actually happens and point the operator at `mesh statement` instead of
describing it secondhand. A wrong comment about money is worse than no
comment.

## 6. A restricted Stripe key could skip every live-billing gate

`794ae8a` — our live/test classification for Stripe keys only checked for
the `sk_live_` prefix. A restricted live key (`rk_live_...`) creates real
invoices and charges real cards, identically to `sk_live_`, but our code
would have classified it as test mode. `mesh-bill` would have printed
`Mode: TEST` and skipped the `--live` flag requirement and the amount
re-type confirmation — the two gates that exist specifically so a real
charge can't go out by accident. `isLiveStripeKey()` now matches either
prefix, anchored at the start of the string, with tests. No test in that
suite uses a real key.

## Why this is one post and not six

None of these are exotic. They're the ordinary failure mode of billing
code: a verdict computed in one place and displayed in five, a summary
sentence that drifted from the function it was summarizing, a rounding
direction nobody had to think hard about until it touched real money. What
made them findable was treating the billing path itself as something to
audit before trusting it at the next tier of traffic — the same standing
habit that's caught problems in our savings math before (see the cache-TTL
heuristic we shipped and reverted in four hours, written up here on
2026-11-02). We'd rather find "22 cents on $21.63 is 1.017%" ourselves, in a
test, than have a customer find it by doing the arithmetic on their own
invoice.

The commits are `794ae8a`, `d1c9e47`, `3b497dc`, `1f4f2e2`, `c3605c1`,
`f52dcdd`, `8975272`, `20c617e`, `55b14e9`, `251c4a5`, `133e8d6`, and
`5316e36`, all landed 2026-11-18 and 2026-11-19 on the branch that became
the first-invoice runbook (`docs/ops/first-invoice-runbook.md`). The round-
down rule, the single verdict function, and the broken-ledger refusal are
all covered by tests in the same commits, so if we regress any of this, CI
should catch it before a customer does.
