# Reddit posts — one per community, in that community's register

**Drafts, not posted.** Refreshed 2026-11-23 for Mesh 0.2.5. Posting is the
founder's act. Both install routes gave 0.2.5 when run on 2026-11-23
(website: build `59363e8`; npm: build `932bcd0`); the posts name no version,
so check `mesh version` on both routes the morning you post.

Rules of engagement (from research/reddit.md): text posts, no URL in the
title, GitHub link mid-body after the numbers, one sub per day, warm the
account with link-free helpful comments for 1–2 weeks first. Retype rather
than paste — these drafts are skeletons for YOUR voice, and communities
detect and punish copy that reads machine-written. Mesh has not run on
anyone's traffic but our own test runs and has no customers: say so when
asked and imply nothing else.

**Who these posts are for (set 2026-11-23).** Teams running their own agents
on the API: coding agents, browsing agents, support, RAG, multi-agent loops.
A Claude Code user on a fresh install should expect little, because Claude
Code already manages its own prompt cache and the out-of-the-box changes add
little on top; say that without putting a number on it. So the order has
changed: r/LLMDevs is the first Reddit post, then r/mlops; r/ClaudeAI is
kept only as the teaching post for people calling the API; r/ClaudeCode is
held. The order is in communities.md.

**Two rules for every figure.** It is in docs/NUMBERS.md with its label
(LIVE or SIMULATOR), and the same sentence says whether it is what a fresh
install gives ("out of the box") or names the levers that were switched on.
No out-of-the-box percentage is in docs/NUMBERS.md, so no post states one.
No percentage in a title.

**Two rules for the pitch (set 2026-11-24).** Mesh is not sold as a token
compressor and no post promises a smaller bill: nobody has measured Mesh
against a real provider bill, and the LIVE figure is the ledger's own
arithmetic (provider-reported usage against a baseline Mesh computes), not a
comparison of two invoices. A post may say what the out-of-the-box changes
do and quote a labelled figure with its levers. Lead with keeping prompts
cacheable and with the ledger the reader can recompute. Write "Mesh"
(`mesh` only for the command), and give the fee as the Terms give it.

**What every post says about a fresh install**, in the post's own words (the
facts were checked on `main` and on an installed 0.2.5 on 2026-11-23; the
detail is in show-hn.md):

- Out of the box Mesh makes three changes, none of which alters the
  provider's answer: it compacts tool schemas so they decode identically,
  removes exact duplicate context, and keeps the cacheable prefix stable by
  moving a per-request timestamp out of it. Nothing else is applied.
- The cache stamp (Mesh placing cache_control on the stable prefix) is off
  out of the box. It is switched on with one line in the `levers` list of
  `~/.mesh/theo-policy.json`, `{ "lever": "cache-ttl-5m", "class": "lossless" }`,
  or `MESH_PROXY_CACHE_TTL=5m` with the no-install proxy.
- Changes that can alter an answer (trimming tool descriptions, compacting
  stale history, a lower output-effort setting) stay off until proven on the
  user's own traffic: `mesh proxy --capture <file>` records a sample on
  their disk, Theo replays it with their key and measures saving and
  quality, and a lever that holds is proposed and accepted with
  `mesh theo --accept <lever>`. That loop has only been run against a
  stand-in provider so far; say so.
- The tool-result cap is in the SDK; the installed proxy holds it back
  because nothing in the CLI proves it today.

Every post teaches the same one path: install
(`curl -fsSL https://www.mesh-technology.com/install.sh | sh` on macOS, Linux
or inside WSL, or `npm install -g @harrym1707/mesh`), then `mesh proxy` for
your own app or agent (`ANTHROPIC_BASE_URL=http://127.0.0.1:8787` or
`OPENAI_BASE_URL=http://127.0.0.1:8787/v1`), then `mesh verify`. `mesh start`
is the Claude Code route; mention it second. Questions go to GitHub issues:
https://github.com/Harrym1707/Mesh/issues/new

Billing never goes in a title. Where a post or a reply gets to what it
costs, say what the Pricing and billing page says and link it
(https://www.mesh-technology.com/pricing.html): installing and
running Mesh is free; no fee is due unless billing has been agreed in
writing; where it has, the fee is 1% of verified savings for the month,
rounded down to the cent, and nothing else; the month is the calendar month
in UTC; nothing is charged automatically (the
user runs `mesh statement --period YYYY-MM`, sends the statement file and
the ledger files, and gets a statement and an invoice back); the statement
is signed by the user's own install, whose key fingerprint
(`mesh statement --key`) they register once when billing is agreed. Keep the
measurement honest in the same breath: the usage after reduction is the
provider's reported number; the baseline it is compared with is computed by
Mesh.

---

## 1. r/LLMDevs — engineering writeup (first Reddit post; no flair needed; disclosure required)

**Title:** A ledger of agent API spend you can recompute: what our local proxy does out of the box, what our one live number needed switched on, and where it lost

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
3. What a fresh install does, before any number: the three out-of-the-box
   changes, then how the cache stamp and the answer-changing levers get
   switched on (the four points above). Say that no out-of-the-box
   percentage has been measured and published, so none is quoted. Say too
   that this is not a token compressor and that nobody has measured it
   against a real provider bill: removing tokens is not the same as lowering
   a bill, which is the reason the ledger exists.
4. The numbers, each with what was switched on, none of them a provider
   invoice compared before and after:
   - 18.2% net on the live basket (LIVE, run 2026-10-26, our own test
     agents) is not an out-of-the-box figure: the run had the cache stamp
     and the tool-result cap switched on, and the three out-of-the-box
     changes account for under half of it. The spools carry a row per
     lever, so readers can split it themselves.
   - 37.9% (SIMULATOR) is the cache stamp alone, on versus off, with the
     same quality in both arms; the stamp is off out of the box.
   - 57.3% (SIMULATOR) is the lossless stack plus the cache stamp against a
     raw uncached baseline, not out of the box, and it costs 5 points of
     quality against that baseline (−5pp), which is why the cache-stamp
     figure is the one we quote.
   - Already-lean stacks: 0–5% is the reference band, not an out-of-the-box
     measurement, and the verdict is do-not-pay-us.
5. The loss: the cache stamp lost money on an early live run; root cause
   (volatile prefix inside the breakpoint span); the guard that fixed it.
6. Try it: the one path above (install, `mesh proxy`, set the base URL,
   `mesh verify`).
7. Disclosure: I built it; no customers yet, it has only run on our own test
   agents; BUSL source-available (not open source — free to evaluate and use
   non-commercially, Apache-2.0 in 2030); installing and running it is free;
   no fee is due unless billing has been agreed in writing; where it has,
   the fee is 1% of verified savings for the month, rounded down to the
   cent, and nothing else, and nothing is charged automatically. Link the pricing
   page (https://www.mesh-technology.com/pricing.html) here, not
   in the title.

---

## 2. r/mlops — flair: Self-Promotion

**Title:** Our own cost lever was losing money on a live test run. The ledger caught it.

**Body (skeleton):** The post-mortem register — one measured fact, then the
anatomy: what the lever did (the Anthropic cache stamp, which is off out of
the box and was switched on for that run), why it lost (volatile prefix
inside the breakpoint span = write premium every turn, zero reads), how the
billing design surfaced it (negatives are never clamped; losses count against
the vendor), the fix, and the attribution angle this community cares about:
per-request, per-lever, per-app cost attribution from the provider's own
reported usage, recomputable from a file you hold. Say plainly it was our own
test traffic, not a customer's. Then what a fresh install does (the three
out-of-the-box changes) and how the cache stamp and the answer-changing
levers get switched on. If the live figure is quoted, quote it whole: 18.2%
net (LIVE, run 2026-10-26) with the cache stamp and the tool-result cap
switched on, under half of it from the three out-of-the-box changes.
Disclosure + link mid-body, then the one path (install, `mesh proxy` + base
URL, `mesh verify`).

---

## 3. r/ChatGPTCoding — the weekly Self Promotion Thread only

Three sentences: what it is (a local proxy for agents you run on the OpenAI
or Claude API, one base URL setting), what it does out of the box (compacts
tool schemas, removes exact duplicate context, keeps the cacheable prefix
stable; further levers are opt-in), then the install one-liner plus
`mesh proxy`, `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` and `mesh verify`
for the recomputable ledger + do-not-pay-us verdict. No figure. No more.

## 4. r/AI_Agents + r/OpenAI — comments only

Use the playbook in research/reddit.md §Natural-thread: answer the runaway-
spend / caching / budget-cap question fully and by hand, then the disclosure
line with the do-it-by-hand escape hatch. These are the agent builders the
product is for, so this is where the patient work goes. If a figure comes
up, it carries its label and what was switched on, as above. Never twice in
one thread genre in one week.

---

## 5. r/ClaudeAI — flair: Showcase (needs 50+ account karma; else the Megathread). Optional, after the posts above

**Kept, lower priority.** It is worth posting only as the teaching post
below, aimed at people who call the Claude API from their own agents. It is
not a pitch to Claude Code or Claude app users, who should expect little from
a fresh install.

**Title:** How Claude's prompt cache actually bills (and the proxy I built after metering agents that never turn it on)

**Body (skeleton):** Lead with 150 words of genuinely useful teaching: the
cache is OPT-IN; breakpoints define exact-byte prefixes; writes bill 1.25×
(5m) / 2× (1h), reads 0.1×; one timestamp at the top of your system prompt
breaks everything after it; TTL counts from request START so a long
generation can expire its own cache ("bathroom breaks become a financial
decision" — their joke, reuse the sentiment, not the phrasing). THEN the
tool, for agents you run on the API: the install one-liner and `mesh proxy`
+ the base URL. Say plainly that out of the box Mesh does NOT place
cache_control for you: it makes the three out-of-the-box changes (one of
which is moving that timestamp), and the cache stamp is the one-line opt-in
above. Then `mesh verify` and the recomputable ledger, the published loss
story, the do-not-pay-us verdict. One line for this sub's Claude Code
users: it already manages its own cache, so expect little from a fresh
install there. Same honesty block as the r/LLMDevs post, compressed, every
figure with its label and what was switched on.

---

## 6. r/ClaudeCode — HELD, not a launch venue

**Held on 2026-11-23. Do not post this as a launch post.** Why: the sub is
Claude Code users, and a Claude Code user on a fresh install should expect
little, since Claude Code already manages its own prompt cache. The earlier
draft led with `mesh start` and described cache_control placement as
something the install does; a fresh install does not do that. Posting it as
it was would have promised this audience a saving they will not see. It is
kept, corrected, for one case only: a thread in this sub where people are
building their own agents on the API and ask about cost. Then use it as a
reply or a text post, flair "Built with Claude".

**Title:** I built a local proxy that keeps my API agents' prompts cacheable, and its own ledger caught one of my levers losing money

**Body (skeleton):**

Up front, because of where I'm posting: this is for agents you build on the
API. Claude Code itself already manages its own prompt cache, so if you only
use Claude Code, expect little from this out of the box.

The thing that started it: Anthropic's prompt cache is opt-in, and when I
actually metered five test agent workloads, a five-turn coding agent of mine
was re-paying full input rate for its entire history every single turn. Zero
cache traffic. The cache just… wasn't on.

So I built Mesh — a local proxy that keeps an agent's prompts cacheable and
writes every request to a ledger you can recompute. I'm not calling it a
token compressor and I'm not promising a smaller bill; nobody has measured
it against a real provider bill yet. No signup, no account:

    curl -fsSL https://www.mesh-technology.com/install.sh | sh
    mesh proxy

(macOS, Linux, or inside WSL; `npm install -g @harrym1707/mesh` works too.
Or read the source first: github.com/Harrym1707/Mesh — it's your API key
going through it, you should.)

Point your agent at it with one setting,
`ANTHROPIC_BASE_URL=http://127.0.0.1:8787`. Out of the box it does three
things, none of which changes the model's answer: it compacts tool schemas
(decodes identically), removes exact duplicate context, and moves the
per-request timestamp that silently breaks the provider cache. That's all a
fresh install does. Placing cache_control for you is a lever that's off out
of the box; you switch it on with one line in `~/.mesh/theo-policy.json`
(`{ "lever": "cache-ttl-5m", "class": "lossless" }`). Anything that could
change an answer stays off until it's been replayed on your own captured
requests and you've said yes. Your key passes through and is never stored;
your prompts go to Anthropic and nowhere else.

The part I'm most proud of is also the embarrassing part. Every request
writes one line to a hash-chained ledger on your disk, and `mesh verify`
recomputes the total from that file — on your machine, no network. On an
early live run that ledger caught one of our OWN levers losing money: the
cache stamp, placed over a volatile prefix, paid the write premium every
turn and got zero reads. It counted against us, we published it, and the
guard that now refuses that placement is in the repo.

Honest numbers, with what was switched on. 37.9% is the cache stamp alone,
on versus off (SIMULATOR: same prompts both arms, modelled, not proven on a
real bill), and the stamp is off out of the box. 18.2% net on a 30-request
live basket, run 2026-10-26 (LIVE: real API traffic, but my own test agents,
$0.0365 saved of $0.2010 spent by the ledger's arithmetic, not checked
against an invoice), had the cache stamp and a tool-result cap switched on,
and the three out-of-the-box changes are under half of it. I
don't have a measured out-of-the-box percentage, so I'm not quoting one.
Nobody else has run it yet. If your stack already caches well, it literally
says "do not pay us" — that's a real verdict it produces.

Happy to answer anything about cache_control placement — I've now stared at
more cache-miss traces than I'd like to admit.

## Do not post

r/LocalLLaMA (cloud-API tooling is read as working for the enemy; disclosed
comments in hybrid-stack threads only), r/MachineLearning, r/artificial.
r/selfhosted only on a Wednesday, leading with the MIT verifier
(`@harrym1707/verify`, on npm) and the "what leaves the machine: nothing
new" security framing up top.
