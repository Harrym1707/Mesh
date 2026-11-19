# Show HN — the post (founder fires)

**Draft, not posted.** Refreshed 2026-11-18 for Mesh 0.2.3. Posting is the
founder's act.

Built from docs/launch/research/hackernews.md. Every savings number below is
in docs/NUMBERS.md and carries that file's label (LIVE or SIMULATOR); do not
add any that isn't. Mesh has not run on anyone's traffic but our own test
runs: write nothing that implies a customer, a user's result or a testimonial.

## Title (pick one — mechanism-led, never the billing, never "open source")

> Show HN: Mesh – local proxy that cuts Claude/OpenAI costs, with a verifiable ledger

Alternative:
> Show HN: Mesh – LLM cost proxy whose savings ledger you can recompute yourself

## URL

`https://github.com/Harrym1707/Mesh` — the repo, NOT mesh-technology.com (HN rules
treat a marketing page as a disqualifying "sign-up page"; the site link goes
in the first comment).

## First comment (post within ONE MINUTE of submitting)

---

Hi HN — I built Mesh after measuring something that surprised me: Anthropic's
prompt cache is opt-in, and most agents never opt in. The first time I ran
five test agent workloads through a meter, a five-turn coding agent was
re-paying full input rate for its entire conversation history on every single
turn — zero cache traffic. Multiply that by every agent loop running today
and it's a lot of money nobody meant to spend.

Mesh is a local proxy. No signup, no account, no waiting list. Install it
(macOS, Linux, or inside WSL on Windows; needs Node 22+):

    curl -fsSL https://www.mesh-technology.com/install.sh | sh
    # or: npm install -g @harrym1707/mesh

Then connect what you run:

    mesh start    # Claude Code: points it at Mesh, puts it back on Ctrl+C
    mesh proxy    # your own app: then set ANTHROPIC_BASE_URL=http://127.0.0.1:8787
                  #               or OPENAI_BASE_URL=http://127.0.0.1:8787/v1
    mesh verify   # re-check the ledger and recompute the figure yourself

(No install at all: `npx -y -p @harrym1707/sdk mesh-proxy` runs the proxy on
its own.) Keep your own API key — it passes through verbatim and is never
stored. Requests are reduced before they reach the provider (compacted tool
schemas that decode identically, exact-duplicate removal, relocating the
per-request timestamp that silently breaks the provider's cache, and correct
cache_control placement). Responses come back byte-identical, streaming
included. Your prompts go to your provider and nowhere else; the proxy added
~22ms p50 on 31KB agent requests on my machine against a local stub
(2026-10-20; measurement script in the repo, rerun it on yours).

The part I actually care about: every request appends one event to an
append-only, hash-chained ledger on YOUR disk — usage numbers from the
provider's own response, lever names, hashes, never prompt content. The
invoice is a pure function over that file. `mesh verify` recomputes it on
your machine with no network calls (it reports the all-time total for the
ledger), and the same check ships as a separate MIT package
(`@harrym1707/verify`) so checking me doesn't mean trusting my CLI. If your
recomputation and my statement disagree, yours prevails; that is in the
terms. To be exact about what is measured: the "after" side of a saving is
the provider's own reported usage; the "before" side is a baseline Mesh
computes. It is a counterfactual, which is why the computation sits in a
file you can re-run.

Honest numbers, because that's the whole point of the thing:

- Switching Claude's cache on correctly vs cache off, same multi-turn
  prompts: 37.9% — SIMULATOR (modelled at published prices, not proven on a
  real bill)
- My one live number: 18.2% net on a mixed 30-request basket,
  claude-sonnet-5-5, run 2026-10-26 — LIVE. That is $0.0365 saved of $0.2010
  spent: real API traffic, but my own five test agents and a tiny sample.
  Per agent: coding 38.1%, rag 22.0%, support 10.3%, batch 0%, already-lean
  0%. The hash-chained spools are in the repo
  (evals/live-exports-2026-10-26/); recompute them.
- A stack that's already well-optimised: 0–5%, and the output literally says
  "do not pay us"
- One of our own levers initially LOST money on an early live run (a cache
  breakpoint over a volatile prefix: a write premium every turn, no reads).
  The ledger caught it, it counted against us, and the guard that now
  refuses that placement is in the repo. That's the system working as
  designed.

What it has not done, stated up front: Mesh has not run on anyone's traffic
but my own test runs. No customers, no case studies. Where it loses: busy
interactive agents model at 25.9–29.4% (SIMULATOR) because the provider's
cache already does the heavy lifting; if you already place cache_control
correctly and dedupe your context, Mesh will mostly tell you to keep your
money.

Licence and pricing, plainly: the code is source-available under BUSL 1.1 —
not open source — free to use non-commercially and to evaluate, converting
to Apache-2.0 in 2030. Production use is a commercial agreement: 1% of
verified savings, monthly, nothing else; a month that saved nothing bills
nothing, and negative lever months count against us. I know %-of-savings
billing invites scepticism — that scepticism is exactly why the ledger is
recomputable by you and why the do-not-pay-us verdict exists.

Genuine question for this crowd: what would it take for you to trust a
savings number you didn't compute yourself? That question shaped most of the
design, and I'd rather hear where it still falls short. Bugs and questions:
https://github.com/Harrym1707/Mesh/issues/new

---

## Prepared answers

Use docs/launch/checklist.md § "Hard questions" — concede fast, one-sentence
licence answers, demo the do-not-pay-us verdict instead of arguing. Fix any
real bug live and say so in-thread with the commit hash.

## Timing

Tuesday–Thursday, 14:00–15:00 UTC (3–4pm UK). Be free for the next 3+ hours.
Never ask anyone to upvote. If it dies under ~10 points, one quiet retry
another day is acceptable; no serial reposting.
