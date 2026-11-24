# Show HN — the post (founder fires)

**Draft, not posted.** Refreshed 2026-11-23 for Mesh 0.2.5. Posting is the
founder's act. Retype it in your own words before posting.

Both install routes gave 0.2.5 when run on 2026-11-23 (website: build
`59363e8`; npm: build `932bcd0`). The comment below names no version on
purpose, so it does not go stale; check `mesh version` on both routes the
morning you post (docs/launch/checklist.md).

Built from docs/launch/research/hackernews.md. Mesh has not run on anyone's
traffic but our own test runs: write nothing that implies a customer, a
user's result or a testimonial.

**Two rules for every figure in this post (set 2026-11-23).**

1. It is in docs/NUMBERS.md and carries that file's label, LIVE or SIMULATOR.
2. The same sentence says whether it is what a fresh install gives ("out of
   the box") or names the levers that were switched on to get it. No
   out-of-the-box percentage is in docs/NUMBERS.md, so the post states none.

**Two rules for the pitch (set 2026-11-24).**

1. Mesh is not sold as a token compressor, and the post promises nobody a
   smaller bill. Nobody has measured Mesh against a real provider bill: the
   LIVE figure is the ledger's own arithmetic (provider-reported usage
   against a baseline Mesh computes), not a comparison of two invoices. The
   post may say what the out-of-the-box changes do and quote a labelled
   figure with its levers. It leads with keeping prompts cacheable and with
   the ledger the reader can recompute.
2. The product is written "Mesh" (`mesh` only for the command), and the fee
   is given as the Terms give it: 1% of verified savings for the month,
   rounded down to the cent, and nothing else; no fee is due unless billing
   has been agreed in writing.

What the labels rest on, checked on `main` on 2026-11-23:

- A fresh install applies three lossless levers and nothing else: tool-schema
  compaction, duplicate-context removal, cache-prefix repair
  (`defaultPolicy` in `packages/sdk-js/src/theo-policy.ts`; also read from
  `~/.mesh/theo-policy.json` on a fresh 0.2.5 install).
- The LIVE run of 2026-10-26 also had the Anthropic cache stamp
  (`cache-ttl-5m`) and a tool-result cap (`fresh-tool-result-cap`) switched
  on; both are off on a fresh install. The cap's gate approval came from a
  recorded-fixture gate run (`evals/run-live-agents.ts`). Summing the
  per-lever rows in `evals/live-exports-2026-10-26/*.jsonl`, the levers a
  fresh install applies account for under half of the saving.
- On a fresh 0.2.5 install against a stand-in provider: no `cache_control`
  is added out of the box; adding the `cache-ttl-5m` line to the policy file
  adds it; a hand-added `fresh-tool-result-cap` is held back for want of a
  gate proof.
- The proving loop for answer-changing levers (`--capture`, Theo's replay,
  `mesh theo --accept`) is described from the commands' own usage text. It
  has only been run against a stand-in provider, never on real traffic.

The audience is teams running their own agents on the API (coding, browsing,
support, RAG, multi-agent). Claude Code users gain little from what Mesh does
out of the box, and the post says so without putting a number on it.

The proxy-overhead figure the earlier draft quoted is not in docs/NUMBERS.md
(it is on the site's evidence page, measured 2026-10-20 on an older build),
so the comment points at the measurement script and gives no number; if you
want a number in the post, re-run the script on the build you are launching
and quote that run with its date.

## Title (pick one — mechanism-led, never the billing, never "open source", no percentage, no "cuts costs")

> Show HN: Mesh – a local proxy that keeps agent prompts cacheable, with a ledger you can recompute

Alternative:
> Show HN: Mesh – a hash-chained ledger of your agents' API spend that you can recompute yourself

## URL

`https://github.com/Harrym1707/Mesh` — the repo, NOT mesh-technology.com (HN rules
treat a marketing page as a disqualifying "sign-up page"; the site link goes
in the first comment).

## First comment (post within ONE MINUTE of submitting)

---

Hi HN — I built Mesh for teams running their own agents on the Claude or
OpenAI API: coding agents, browsing agents, support, RAG, multi-agent loops.
It started when I put five test agent workloads through a meter and found a
five-turn coding agent re-paying full input rate for its entire conversation
history on every single turn. Zero cache traffic: Anthropic's prompt cache is
opt-in, and that agent had never opted in.

Mesh is a local proxy that does two things: it keeps your agent's prompts
cacheable, and it writes every request to a ledger you can recompute
yourself. No signup, no account, no waiting list. Install it (macOS, Linux,
or inside WSL on Windows; needs Node 22+):

    curl -fsSL https://www.mesh-technology.com/install.sh | sh
    # or: npm install -g @harrym1707/mesh

Then point your agent at it:

    mesh proxy    # then set ANTHROPIC_BASE_URL=http://127.0.0.1:8787
                  #       or OPENAI_BASE_URL=http://127.0.0.1:8787/v1
    mesh verify   # re-check the ledger and recompute the figure yourself

(`mesh start` does the same for Claude Code and puts it back on Ctrl+C, but
Claude Code already manages its own prompt cache, so expect little there from
what Mesh does out of the box. No install at all:
`npx -y -p @harrym1707/sdk mesh-proxy` runs the proxy on its own.) Keep your
own API key — it passes through verbatim and is never stored. Responses come
back byte-identical, streaming included. Your prompts go to your provider and
nowhere else. The proxy adds a little latency to each request; the script
that measures it is in the repo (evals/run-proxy-overhead.ts), so run it on
your machine rather than take a number from mine.

What you get if you just install it, before any number: out of the box Mesh
makes three changes to a request, none of which alters the provider's answer.
It compacts tool schemas so they decode identically, removes exact duplicate
context, and moves a per-request timestamp out of the way so the provider's
cache prefix stays stable. That is all. Out of the box it does not switch
Anthropic's cache on for you, and it applies nothing that could change an
answer.

I am not going to call this a token compressor or promise you a smaller
bill. Removing tokens is not the same as lowering a bill: one of my own
levers lost money on an early live run (below), and a change that disturbs
a cached prefix makes the provider write that prefix again. Nobody has
measured Mesh against a real provider bill yet, me included. What I can
offer is a record you can check.

Everything past that is opt-in, and this is how it gets switched on today:

- The cache stamp (Mesh places cache_control on the stable prefix) is one
  line added to the `levers` list in `~/.mesh/theo-policy.json`:
  `{ "lever": "cache-ttl-5m", "class": "lossless" }`. A running proxy picks
  it up on its next request. With the no-install proxy it is
  `MESH_PROXY_CACHE_TTL=5m`.
- Changes that can alter an answer (trimming tool descriptions, compacting
  stale history, a lower output-effort setting) stay off until they are
  proven on your own traffic. You opt in to recording a sample of your
  requests on your own disk (`mesh proxy --capture <file>`); Theo, the agent
  that runs beside the proxy, replays them both ways with your key and
  measures the saving and the quality; if it holds inside your quality
  ceiling he proposes it and you answer with `mesh theo --accept <lever>`.
  I have only run that loop against a stand-in provider so far.
- A cap on oversized tool results is in the SDK. The installed proxy holds
  it back, because nothing in the CLI proves that lever today.

The part I actually care about: every request appends one event to an
append-only, hash-chained ledger on YOUR disk — usage numbers from the
provider's own response, lever names, hashes, never prompt content. The
invoice is a pure function over that file. `mesh verify` recomputes it on
your machine with no network calls (it reports the all-time total for the
ledger), `mesh statement --period YYYY-MM` recomputes one calendar month and
writes it to a file signed by a key your own install generates and keeps, and
the same recompute ships as a separate MIT package (`@harrym1707/verify`) so
checking me doesn't mean trusting my CLI. If your recomputation and my
statement disagree, yours prevails; that is in the terms. To be exact about
what is measured: the "after" side of a saving is the provider's own reported
usage; the "before" side is a baseline Mesh computes. It is a counterfactual,
which is why the computation sits in a file you can re-run.

Honest numbers, each with what was switched on to get it. None of them is a
provider bill going down: each is either the ledger's own arithmetic
(provider-reported usage against a baseline Mesh computes) or a simulation.

- My one live number is 18.2% net on a mixed 30-request basket,
  claude-sonnet-5-5, run 2026-10-26 (LIVE), and it is not an out-of-the-box
  figure: that run had the cache stamp and the tool-result cap switched on,
  and the three out-of-the-box changes account for under half of it. By the
  ledger's arithmetic that is $0.0365 saved of $0.2010 spent: real API
  traffic, but my own five test agents, a tiny sample, and not checked
  against a provider invoice.
- Per agent in that same tuned run, cache stamp and tool-result cap on, not
  out of the box: coding 38.1%, rag 22.0%, support 10.3%, batch 0%,
  already-lean 0%. The hash-chained spools are in the repo
  (evals/live-exports-2026-10-26/) with a row per lever, so you can split
  the saving yourself.
- The cache stamp alone, on versus off, same multi-turn prompts: 37.9% —
  SIMULATOR (modelled at published prices, not proven on a real bill), and
  the stamp is off out of the box.
- There is no measured out-of-the-box percentage in the repo, so I am not
  quoting one.
- A stack that is already well-optimised: 0–5% is the reference band, it is
  not an out-of-the-box measurement, and the output literally says "do not
  pay us".
- One of our own levers initially LOST money on an early live run (the cache
  stamp, placed over a volatile prefix: a write premium every turn, no
  reads). The ledger caught it, it counted against us, and the guard that
  now refuses that placement is in the repo. That's the system working as
  designed.

What it has not done, stated up front: Mesh has not run on anyone's traffic
but my own test runs. No customers, no case studies. Where it loses: busy
interactive agents model at 25.9–29.4% (SIMULATOR, with the full interactive
stack switched on, tool-result cap included, so not out of the box) because
the provider's cache already does the heavy lifting; if you already place
cache_control correctly and dedupe your context, Mesh will mostly tell you
to keep your money.

Licence and pricing, plainly: the code is source-available under BUSL 1.1 —
not open source — free to use non-commercially and to evaluate, converting
to Apache-2.0 in 2030. Installing and running it is free, and the terms on
the site are the agreement for running it in production on your own usage.
No fee is due unless billing has been agreed in writing. Where it has, the
fee is 1% of verified savings for the month, rounded down to the cent, and
nothing else; the month is the calendar month in UTC. Nothing is charged
automatically. After the month
ends you run `mesh statement --period YYYY-MM` and send the signed statement
file with the ledger files; I recompute the same figure and send a statement
and an invoice. You register your install's key fingerprint once
(`mesh statement --key`) when billing is agreed, so nobody else, me included,
can produce a statement in your name. A month that saved nothing bills
nothing, and a lever that lost money counts against us. Month by month:
https://www.mesh-technology.com/pricing.html. I know %-of-savings billing
invites scepticism — that scepticism is exactly why the ledger is
recomputable by you and why the do-not-pay-us verdict exists.

Genuine question for this crowd: what would it take for you to trust a
savings number you didn't compute yourself? That question shaped most of the
design, and I'd rather hear where it still falls short. Bugs and questions:
https://github.com/Harrym1707/Mesh/issues/new

---

## Prepared answers

Use docs/launch/checklist.md § "Hard questions" — concede fast, one-sentence
licence answers, demo the do-not-pay-us verdict instead of arguing. The first
one to have ready is "what do I get if I just install it?". Fix any real bug
live and say so in-thread with the commit hash.

## Timing

Tuesday–Thursday, 14:00–15:00 UTC (3–4pm UK). Be free for the next 3+ hours.
Never ask anyone to upvote. If it dies under ~10 points, one quiet retry
another day is acceptable; no serial reposting.
