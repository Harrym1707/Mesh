# How we verify LLM API savings with a ledger you can recompute yourself

*(**Draft, not published.** Refreshed 2026-11-24 for Mesh 0.2.5, the release
that signs statements with the customer's own install; both install routes
gave 0.2.5 when run on 2026-11-23. The newsletter/blog asset: the mechanism
story TLDR-class newsletters and Latent Space link to. Founder reviews,
retypes it in his own first-person voice, and publishes — on the site as a
page, or as the body of a pitch.*

*Rules this draft keeps, set 2026-11-23 and 2026-11-24 (the facts behind
them are in show-hn.md). Every figure is in docs/NUMBERS.md with its label,
LIVE or SIMULATOR, and the same sentence says whether it is out of the box
or names the levers that were switched on; no out-of-the-box percentage is
published, so none is stated. Mesh is not sold as a token compressor and
nothing here promises a smaller bill: nobody has measured Mesh against a
real provider bill. The product is written "Mesh". The fee is given as the
Terms give it. The reader is a team running its own agents on the API.)*

---

Every LLM cost tool publishes a savings percentage. Almost none of them lets
you check it. That asymmetry is the whole problem: a savings claim is a
counterfactual — money you *would have* spent — and counterfactuals are where
marketing goes to lie. Independent replays of popular token trimmers keep
finding the measured saving far below the claimed one (the sources are on
our comparison page). Removing tokens is not the same as lowering a bill.

We build Mesh, a local proxy for teams running their own agents on the
Claude or OpenAI API. It keeps their prompts cacheable and writes every
request to a ledger they can recompute. We do not call it a token compressor
and we do not promise a smaller bill. Installing and running it is free. No
fee is due unless billing has been agreed in writing; where it has, the fee
is 1% of verified savings for the month, rounded down to the cent, and
nothing else. Pricing on a counterfactual forced us to solve the
verification problem for real, and the solution turned out to be the
interesting part of the product. Mesh is new: it has not yet run on anyone's
traffic but our own test runs, nobody has measured it against a real
provider bill, and the numbers at the end say what each one is. Here is the
whole mechanism.

## 1. Say which side is measured and which is computed

Out of the box Mesh makes three changes to a request before the provider
sees it, none of which alters the provider's answer: tool schemas are
compacted so they decode identically, exact duplicate context is removed,
and the per-request timestamp that silently breaks the provider's prompt
cache is relocated out of the cacheable prefix. Placing `cache_control` on
the stable text is a fourth lever, the cache stamp, and it is off until you
switch it on.

The "after" side of every saving is the provider's own reported usage for the
request that was actually sent. The "before" side is a baseline Mesh
computes: the provider never saw the unreduced request, so it cannot report
on it. For tokens a lever removed, Mesh counts them before sending, anchors
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

`invoice = recompute(ledger file)`. That is the whole calculation behind a
bill. `mesh verify` runs it on your machine with no network calls; it reports
the all-time total for the ledger. `mesh statement --period YYYY-MM` runs it
for one calendar month (UTC), prints the savings by lever and the fee, and
writes a statement file. The functions that verify the chain and
recompute the invoice also ship as a separate MIT package
(`@harrym1707/verify`) with zero dependencies and no network access,
precisely because the product itself is commercial (source-available BUSL):
an honesty claim you cannot independently check is worthless, so checking us
requires accepting no terms at all. If your recomputation of the same ledger
differs from our statement, yours prevails. That sentence is in the terms.

The statement file is signed by a key your own install generates and keeps.
`mesh statement --key` prints its fingerprint, which you register with us
once, when billing is agreed; the private half never leaves your machine. We
bill only from statements signed by that key, so nobody else, including us,
can produce a statement in your name. Nothing is charged automatically: you
send the statement file and the ledger files it was made from, we recompute
the same figure from the same ledger, and we send a statement and an invoice.

## 4. Quality is part of the number, and anything that can change an answer is opt-in

Savings are measured per completed task, never per request — a cheaper
request that fails its task is worth less than an expensive one that works,
and several "obvious" levers fail exactly this way. A fresh install applies
only the three changes in section 1.

Everything else is switched on by you. The cache stamp is one line in the
`levers` list of `~/.mesh/theo-policy.json`
(`{ "lever": "cache-ttl-5m", "class": "lossless" }`), picked up by a running
proxy on its next request. Levers that change what the model reads
(trimming tool descriptions, compacting stale history, a lower output-effort
setting) stay off until a replay gate has re-run a sample of your own
recorded requests, with your key, and shown that the saving holds inside
your quality ceiling: you opt in to the recording with
`mesh proxy --capture <file>`, Theo, the agent that runs beside the proxy,
does the replay and proposes what passed, and you answer with
`mesh theo --accept <lever>`. We have only run that loop against a stand-in
provider so far. A cap on oversized tool results exists in the SDK; the
installed proxy holds it back, because nothing in the CLI proves it today.

One of our stack's strongest arms, 57.3% versus an uncached baseline
(SIMULATOR, the lossless stack plus the cache stamp, so not out of the box),
is published with its cost attached: it loses 5 points of task quality
against that baseline, so the figure we quote for the cache stamp is the
smaller, clean one.

## 5. Losses count against us, and that's not hypothetical

Negative savings are never clamped to zero. On an early live run of our own
test agents, the ledger caught one of our levers losing money: the cache
stamp, placed over a volatile prefix, paid a cache write premium every
turn and never got a single read. It counted against us in the total, we
published the loss and root cause, and the fix is a guard that refuses to
stamp a prefix that churns between turns. A billing design that can't surface
its own mistakes would have hidden that forever.

## 6. Sometimes the verdict is "do not pay us"

The quote tool runs on exports from LiteLLM, Helicone, or Langfuse without
routing any traffic, and for already-optimised stacks its output literally
reads `do_not_charge`. In our one live basket (LIVE, run 2026-10-26, with
the cache stamp and a tool-result cap switched on, so not out of the box),
two of the five agent shapes came out at 0%: the batch agent, where the
cache stamp was correctly suppressed, and the already-lean agent, where
there was nothing left to remove. Publishing the losing rows is not
flattering, and it buys the only thing a counterfactual biller can sell:
being checkable.

## The numbers, with their labels and what was switched on

None of these is a provider bill compared before and after. Each is the
ledger's own arithmetic (provider-reported usage against a baseline Mesh
computes) or a simulation.

- The one live number is **18.2% net** on a mixed 30-request basket,
  claude-sonnet-5-5, run 2026-10-26 (LIVE), and it is not an out-of-the-box
  figure: the run had the cache stamp and a tool-result cap switched on, and
  the three out-of-the-box changes account for under half of it. By the
  ledger's arithmetic that is $0.0365 saved of $0.2010 spent; real API
  traffic, our own test agents; the spools, with a row per lever, are in
  `evals/live-exports-2026-10-26/`.
- The cache stamp alone, on versus off, same prompts both arms: **37.9%** —
  SIMULATOR (modelled at published prices, not proven on a real bill); the
  stamp is off out of the box.
- Out of the box: no percentage has been measured and published, so we do
  not quote one.
- Already-optimised stacks: **0–5%** is the reference band, not an
  out-of-the-box measurement; the verdict is `do_not_charge`.
- The proxy's own cost in latency: measured by a script in the repo
  (`evals/run-proxy-overhead.ts`); run it on your machine. *(Draft note: the
  figure on the evidence page is from 2026-10-20 and is not in
  docs/NUMBERS.md, so no number is given here; re-run the script on the
  launch build if you want one, and quote that run with its date.)*

Try it on your own agents; it is open to anyone, no signup or account.
Install with `curl -fsSL https://www.mesh-technology.com/install.sh | sh`
(macOS, Linux, or inside WSL on Windows) or `npm install -g @harrym1707/mesh`.
Then `mesh proxy` for your own app or agent, with
`ANTHROPIC_BASE_URL=http://127.0.0.1:8787` or
`OPENAI_BASE_URL=http://127.0.0.1:8787/v1` (`mesh start` is the route for
Claude Code, which already manages its own prompt cache, so expect little
there from a fresh install). Then `mesh verify`. Everything above traces to
a runnable command: https://www.mesh-technology.com/evidence.html
What it costs and how a month is billed: https://www.mesh-technology.com/pricing.html
Questions and bugs: https://github.com/Harrym1707/Mesh/issues/new
