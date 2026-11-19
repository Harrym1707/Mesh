# How we verify LLM API savings with a ledger you can recompute yourself

*(**Draft, not published.** Refreshed 2026-11-18 for MESH 0.2.3. The
newsletter/blog asset: the mechanism story TLDR-class newsletters and Latent
Space link to. Founder reviews, personalises the first-person voice, and
publishes — on the site as a page, or as the body of a pitch. Every savings
number is in docs/NUMBERS.md with its label, LIVE or SIMULATOR; add nothing
that isn't.)*

---

Every LLM cost tool publishes a savings percentage. Almost none of them lets
you check it. That asymmetry is the whole problem: a savings claim is a
counterfactual — money you *would have* spent — and counterfactuals are where
marketing goes to lie. Independent replays of popular token trimmers keep
finding the measured saving far below the claimed one (the sources are on
our comparison page).

We build MESH, a local proxy that cuts Claude/OpenAI request costs, and the
price is 1% of verified savings, monthly. Pricing on a counterfactual forced
us to solve the verification problem for real, and the solution turned out to
be the interesting part of the product. MESH is new: it has not yet run on
anyone's traffic but our own test runs, and the numbers at the end say which
is which. Here is the whole mechanism.

## 1. Say which side is measured and which is computed

MESH reduces each request before the provider sees it: tool schemas compacted
so they decode identically, exact duplicate context removed, the per-request
timestamp that silently breaks the provider's prompt cache relocated out of
the cacheable prefix, and `cache_control` placed on the stable text only.
The "after" side of every saving is the provider's own reported usage for the
request that was actually sent. The "before" side is a baseline MESH
computes: the provider never saw the unreduced request, so it cannot report
on it. For tokens a lever removed, MESH counts them before sending, anchors
that count to the provider's reported input total, and prices it at the rate
the request actually paid. That is an estimate, the ledger says
`estimated-baseline` on the line item, and the counts behind it are in the
event so you can re-derive it — labels are load-bearing here. The same ledger
always yields the same number, but repeatable is not the same as measured,
and we do not pretend it is.

## 2. Every request writes one hash-chained event — on your disk

The unit of record is an append-only JSONL file you hold. One line per
request: provider-verbatim usage numbers, lever names, a few hashes, the
catalogue version used for pricing — never prompt content, never credentials.
Each line commits to the previous line's hash, so the file is tamper-evident
in both directions: we cannot inflate it later, and a corrupted spool fails
verification loudly instead of billing quietly.

## 3. The invoice is a pure function — and the verifier is MIT

`invoice = recompute(ledger file)`. That is the entire billing pipeline.
`mesh verify` runs it on your machine with no network calls; it reports the
all-time total for the ledger. The functions that verify the chain and
recompute the invoice also ship as a separate MIT package
(`@harrym1707/verify`) with zero dependencies and no network access,
precisely because the product itself is commercial (source-available BUSL):
an honesty claim you cannot independently check is worthless, so checking us
requires accepting no terms at all. If your recomputation of the same ledger
differs from our statement, yours prevails. That sentence is in the terms.

## 4. Quality is part of the number

Savings are measured per completed task, never per request — a cheaper
request that fails its task is worth less than an expensive one that works,
and several "obvious" levers fail exactly this way. Lossless transforms
(byte-exact dedup, schemas that decode identically) apply by default. Anything
that changes what the model reads is off until a replay gate re-runs your own
recorded requests and shows quality held. One of our stack's strongest arms —
57.3% versus an uncached baseline (SIMULATOR) — is published as a **non-win**
because it costs 5 points of task quality, over our own limit.

## 5. Losses count against us, and that's not hypothetical

Negative savings are never clamped to zero. On an early live run of our own
test agents, the ledger caught one of our levers losing money: a cache
breakpoint placed over a volatile prefix paid a cache write premium every
turn and never got a single read. It counted against us in the total, we
published the loss and root cause, and the fix is a guard that refuses to
stamp a prefix that churns between turns. A billing design that can't surface
its own mistakes would have hidden that forever.

## 6. Sometimes the verdict is "do not pay us"

The quote tool runs on exports from LiteLLM, Helicone, or Langfuse without
routing any traffic, and for already-optimised stacks its output literally
reads `do_not_charge`. In our one live basket (LIVE, run 2026-10-26), two of
the five agent shapes came out at 0%: the batch agent, where the cache lever
was correctly suppressed, and the already-lean agent, where there was nothing
left to remove. Publishing the losing rows is not flattering, and it buys the
only thing a counterfactual biller can sell: being checkable.

## The numbers, with their labels

- Correct Claude cache placement alone, same prompts both arms: **37.9%** —
  SIMULATOR (modelled at published prices, not proven on a real bill)
- The one live number: **18.2% net** on a mixed 30-request basket,
  claude-sonnet-5-5, run 2026-10-26 — LIVE ($0.0365 saved of $0.2010 spent;
  real API traffic, our own test agents; spools in
  `evals/live-exports-2026-10-26/`)
- Already-optimised stacks: **0–5%**, verdict `do_not_charge`
- The proxy's own cost: **~22ms p50** added per request against a local stub
  (2026-10-20, our machine), measurement script in the repo

Try it on your own traffic; it is open to anyone, no signup or account.
Install with `curl -fsSL https://www.mesh-technology.com/install.sh | sh`
(macOS, Linux, or inside WSL on Windows) or `npm install -g @harrym1707/mesh`.
Then `mesh start` for Claude Code, or `mesh proxy` for your own app with
`ANTHROPIC_BASE_URL=http://127.0.0.1:8787` or
`OPENAI_BASE_URL=http://127.0.0.1:8787/v1`. Then `mesh verify`. Everything
above traces to a runnable command: https://www.mesh-technology.com/evidence.html
Questions and bugs: https://github.com/Harrym1707/Mesh/issues/new
