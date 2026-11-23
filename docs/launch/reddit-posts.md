# Reddit posts — one per community, in that community's register

**Drafts, not posted.** Refreshed 2026-11-23 for Mesh 0.2.5. Posting is the
founder's act. Both install routes gave 0.2.5 when run on 2026-11-23
(website: build `59363e8`; npm: build `932bcd0`); the posts name no version,
so check `mesh version` on both routes the morning you post.

Rules of engagement (from research/reddit.md): text posts, no URL in the
title, GitHub link mid-body after the numbers, one sub per day, warm the
account with link-free helpful comments for 1–2 weeks first. Retype rather
than paste — these drafts are skeletons for YOUR voice, and communities
detect and punish copy that reads machine-written. Every savings number is in
docs/NUMBERS.md and carries its label (LIVE or SIMULATOR); add nothing that
isn't. Mesh has not run on anyone's traffic but our own test runs and has no
customers: say so when asked and imply nothing else.

Every post teaches the same one path: install
(`curl -fsSL https://www.mesh-technology.com/install.sh | sh` on macOS, Linux
or inside WSL, or `npm install -g @harrym1707/mesh`), then `mesh start` for
Claude Code or `mesh proxy` for your own app
(`ANTHROPIC_BASE_URL=http://127.0.0.1:8787` or
`OPENAI_BASE_URL=http://127.0.0.1:8787/v1`), then `mesh verify`. Questions go
to GitHub issues: https://github.com/Harrym1707/Mesh/issues/new

Billing never goes in a title. Where a post or a reply gets to what it
costs, say what the Pricing and billing page says and link it
(https://www.mesh-technology.com/pricing.html): installing and
running Mesh is free; a fee exists only once billing has been agreed in
writing; it is 1% of verified savings for the calendar month, rounded down
to the cent, so never more than 1%; nothing is charged automatically (the
user runs `mesh statement --period YYYY-MM`, sends the statement file and
the ledger files, and gets a statement and an invoice back); the statement
is signed by the user's own install, whose key fingerprint
(`mesh statement --key`) they register once when billing is agreed. Keep the
measurement honest in the same breath: the usage after reduction is the
provider's reported number; the baseline it is compared with is computed by
Mesh.

---

## 1. r/ClaudeCode — flair: Built with Claude (fire first)

**Title:** I built a local proxy to cut Claude API costs, and its own ledger caught one of my levers losing money

**Body (skeleton):**

The thing that started this: Anthropic's prompt cache is opt-in, and when I
actually metered five test agent workloads, a five-turn coding agent was
re-paying full input rate for its entire history every single turn. Zero
cache traffic. The cache just… wasn't on, because nobody turns it on.

So I built mesh — a local proxy. No signup, no account:

    curl -fsSL https://www.mesh-technology.com/install.sh | sh
    mesh start

(macOS, Linux, or inside WSL; `npm install -g @harrym1707/mesh` works too.
Or read the source first: github.com/Harrym1707/Mesh — it's your API key
going through it, you should.)

`mesh start` points Claude Code at it and puts it back on Ctrl+C. For your
own agent it's `mesh proxy` and one setting,
`ANTHROPIC_BASE_URL=http://127.0.0.1:8787`. It compacts tool schemas (decodes
identically), removes exact duplicate context, moves the per-request
timestamp that silently breaks the provider cache, and places cache_control
on the actually-stable prefix. Responses come back byte-identical. Your key
passes through and is never stored; your prompts go to Anthropic and nowhere
else.

The part I'm most proud of is also the embarrassing part. Every request
writes one line to a hash-chained ledger on your disk, and `mesh verify`
recomputes the total from that file — on your machine, no network. On an
early live run that ledger caught one of our OWN levers losing money: a cache
breakpoint placed over a volatile prefix paid the write premium every turn
and got zero reads. It counted against us, we published it, and the guard
that now refuses that placement is in the repo.

Honest numbers: 37.9% from correct cache placement alone (SIMULATOR: same
prompts both arms, modelled, not proven on a real bill). 18.2% net on a
30-request live basket, run 2026-10-26 (LIVE: real API traffic, but my own
test agents, $0.0365 saved of $0.2010 spent; the spools are in the repo).
Nobody else has run it yet. If your stack already caches well, it literally
says "do not pay us" — that's a real verdict it produces.

Happy to answer anything about cache_control placement — I've now stared at
more cache-miss traces than I'd like to admit.

---

## 2. r/ClaudeAI — flair: Showcase (needs 50+ account karma; else the Megathread)

**Title:** How Claude's prompt cache actually bills (and the proxy I built after metering agents that never turn it on)

**Body (skeleton):** Lead with 150 words of genuinely useful teaching: the
cache is OPT-IN; breakpoints define exact-byte prefixes; writes bill 1.25×
(5m) / 2× (1h), reads 0.1×; one timestamp at the top of your system prompt
breaks everything after it; TTL counts from request START so a long
generation can expire its own cache ("bathroom breaks become a financial
decision" — their joke, reuse the sentiment, not the phrasing). THEN the
tool: the install one-liner and `mesh start` (or `mesh proxy` + the base
URL), what it automates, `mesh verify` and the recomputable ledger, the
published loss story, the do-not-pay-us verdict. Same honesty block as the
r/ClaudeCode post, compressed, labels included.

---

## 3. r/LLMDevs — engineering writeup (no flair needed; disclosure required)

**Title:** 18.2% net on a 30-request LIVE test basket (2026-10-26) — and here's the hash-chained ledger so you can check the math, including where it lost

**Body (skeleton):** This community's live anxiety is *proving* savings
claims, so structure as method-first:

1. The measurement problem: every router/optimizer claims a percentage;
   none let you recompute it. Baselines are counterfactuals, so the only
   honest move is to say which side is which: the "after" is the provider's
   own reported usage, the "before" is a baseline we compute with a
   deterministic pricing function, and both sit in an append-only ledger you
   hold.
2. The mechanism: hash-chained JSONL per app; invoice = pure function over
   events; `mesh verify` re-checks the chain and recomputes the all-time
   total with no network calls; `mesh statement --period YYYY-MM` recomputes
   one calendar month and writes a statement file signed by a key your own
   install holds; the MIT `@harrym1707/verify` package recomputes
   independently; if your recompute disagrees with ours, yours prevails.
3. The numbers with tradeoffs: 37.9% cache-only (SIMULATOR, same quality in
   both arms); the 57.3% full-stack figure (SIMULATOR) costs 5 points of
   quality against the raw baseline (−5pp) and is published with that cost,
   which is why 37.9% is the one we quote; 18.2% net on the live basket (LIVE,
   run 2026-10-26, our own test agents); already-lean stacks 0–5% and a
   do-not-pay-us verdict.
4. The loss: our own stamp lever lost money on an early live run; root cause
   (volatile prefix inside the breakpoint span); the guard that fixed it.
5. Try it: the one path above (install, `mesh proxy`, set the base URL,
   `mesh verify`).
6. Disclosure: I built it; no customers yet, it has only run on our own test
   agents; BUSL source-available (not open source — free to evaluate and use
   non-commercially, Apache-2.0 in 2030); installing and running it is free;
   a fee exists only once billing is agreed in writing, and is then 1% of
   the month's verified savings, rounded down to the cent, never charged
   automatically; a month that saves nothing bills nothing. Link the pricing
   page (https://www.mesh-technology.com/pricing.html) here, not
   in the title.

---

## 4. r/mlops — flair: Self-Promotion

**Title:** Our own cost lever was losing money on a live test run. The ledger caught it.

**Body (skeleton):** The post-mortem register — one measured fact, then the
anatomy: what the lever did (Anthropic cache stamping), why it lost (volatile
prefix inside the breakpoint span = write premium every turn, zero reads),
how the billing design surfaced it (negatives are never clamped; losses
count against the vendor), the fix, and the attribution angle this community
cares about: per-request, per-lever, per-app cost attribution from the
provider's own reported usage, recomputable from a file you hold. Say plainly
it was our own test traffic, not a customer's. Disclosure + link mid-body,
then the one path (install, `mesh proxy` + base URL, `mesh verify`).

---

## 5. r/ChatGPTCoding — the weekly Self Promotion Thread only

Three sentences: what it does (OpenAI + Claude, one base URL setting), the
install one-liner plus `mesh proxy` and
`OPENAI_BASE_URL=http://127.0.0.1:8787/v1`, then `mesh verify` for the
recomputable ledger + do-not-pay-us verdict. No more.

## 6. r/AI_Agents + r/OpenAI — comments only

Use the playbook in research/reddit.md §Natural-thread: answer the runaway-
spend / caching / budget-cap question fully and by hand, then the disclosure
line with the do-it-by-hand escape hatch. Never twice in one thread genre in
one week.

## Do not post

r/LocalLLaMA (cloud-API tooling is read as working for the enemy; disclosed
comments in hybrid-stack threads only), r/MachineLearning, r/artificial.
r/selfhosted only on a Wednesday, leading with the MIT verifier
(`@harrym1707/verify`, on npm) and the "what leaves the machine: nothing
new" security framing up top.
