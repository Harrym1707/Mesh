# Launch posts — other channels (founder fires each one)

**Drafts, not posted or sent.** Refreshed 2026-11-24 for Mesh 0.2.5. Posting
and sending are the founder's acts; retype each one before it goes out. Mesh
has no customers and has only run on our own test traffic: imply nothing
else. Both install routes gave 0.2.5 when run on 2026-11-23 (website: build
`59363e8`; npm: build `932bcd0`); the texts below name no version, so check
`mesh version` on both routes on the day.

**Who these are for.** Teams running their own agents on the API (coding,
browsing, support, RAG, multi-agent). Claude Code users should expect little
from a fresh install; say so where it comes up, without a number.

**Rules for every text below** (set 2026-11-23 and 2026-11-24; the facts
behind them are in show-hn.md):

- Every figure is in docs/NUMBERS.md with its label (LIVE or SIMULATOR), and
  the same sentence says whether it is out of the box or names the levers
  that were switched on. No out-of-the-box percentage is published, so none
  is stated.
- Mesh is not sold as a token compressor and nothing promises a smaller
  bill: nobody has measured Mesh against a real provider bill. Lead with
  keeping prompts cacheable and with the ledger the reader can recompute.
- Say what a fresh install does: three changes that do not alter the
  provider's answer (compact tool schemas, remove exact duplicate context,
  keep the cacheable prefix stable). The cache stamp and anything that can
  change an answer are opt-in.
- Write "Mesh" (`mesh` only for the command).
- Where a text says what Mesh costs, it follows the Terms word for word and
  links the Pricing and billing page
  (https://www.mesh-technology.com/pricing.html): no fee is due unless
  billing has been agreed in writing; where it has, the fee is 1% of
  verified savings for the month, rounded down to the cent, and nothing
  else. Nothing is charged automatically. Billing never goes in a title,
  tagline or subject line.

Sequencing (from research/channels.md): listings first (compounding GEO),
then HN, then DevHunt, X cadence throughout, Product Hunt later with social
proof. One community per day, never a blast.

---

## 1. console.dev pitch (email — their published criteria fit Mesh)

Subject: Mesh — a local proxy for agent API traffic, with a ledger you can recompute yourself

> Hi — Mesh might fit Console's selection criteria: it's dev-first,
> entirely self-service (one command, no signup, no sales call), and the docs
> lead with runnable commands.
>
> It is for teams running their own agents on the Claude or OpenAI API.
> `curl -fsSL https://www.mesh-technology.com/install.sh | sh` (or
> `npm install -g @harrym1707/mesh`) installs it; `mesh proxy` starts a local
> proxy, and you point your agent at it with
> `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` or
> `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` (`mesh start` does the same for
> Claude Code). Out of the box it makes three changes that do not alter the
> provider's answer: it compacts tool schemas, removes exact duplicate
> context, and keeps the cacheable prefix stable. Anything further is opt-in.
> Every request is written to a hash-chained ledger of the provider's own
> reported usage, on the user's disk.
>
> The differentiator is that the figures can be checked: the invoice is a
> pure function of a file the user holds, `mesh verify` recomputes it locally
> (a separate MIT package does the same), `mesh statement --period YYYY-MM`
> gives one month's figure in a file signed by the user's own install, and
> where there is nothing to bill the output literally says "do not pay us".
> We do not call it a token compressor or promise a smaller bill, and what we
> publish includes a lever of our own losing money. It is new: so far it has
> only run on our own test traffic.
>
> Repo: https://github.com/Harrym1707/Mesh · Site: https://www.mesh-technology.com
> · Five-minute start: https://www.mesh-technology.com/start.html
> · Pricing and billing: https://www.mesh-technology.com/pricing.html
>
> Happy to answer anything. — Harry

## 2. DevHunt listing

- Tagline: "A local proxy that keeps your agents' prompts cacheable — with a
  ledger of API spend you can recompute yourself"
- Demo: the start page (five-minute walkthrough) + the evidence page
- Link GitHub repo as primary; first line is the zero-signup install
  (`curl -fsSL https://www.mesh-technology.com/install.sh | sh`, then
  `mesh proxy` for your own agent or `mesh start` for Claude Code, then
  `mesh verify`).
- Second line: what a fresh install does (the three out-of-the-box changes;
  further levers are opt-in). No figure in the listing.
- If the listing has a pricing field or link: "Free to install and run. No
  fee is due unless billing has been agreed in writing; then 1% of verified
  savings for the month, rounded down to the cent, and nothing else", linked
  to https://www.mesh-technology.com/pricing.html

## 3. X thread (no hashtags; story form; labelled numbers only)

1/ Anthropic's prompt cache is opt-in. We metered one of our own test agents,
a five-turn coding agent, re-paying full input rate for its ENTIRE history
every turn — zero cache traffic. It had never opted in.

2/ So we built Mesh for teams running their own agents on the API: a local
proxy that keeps prompts cacheable and writes every request to a ledger you
can recompute. No signup.
`curl -fsSL https://www.mesh-technology.com/install.sh | sh`, then
`mesh proxy` and one base-URL setting. Keep your own key.

3/ Out of the box it makes three changes, none of which alters the answer:
compacts tool schemas, removes exact duplicate context, keeps the cacheable
prefix stable. That's all a fresh install does. Placing cache_control for
you is one opt-in line; anything that could change an answer stays off until
proven on your own traffic.

4/ Every request writes one event to a hash-chained ledger on YOUR disk. The
invoice is a pure function over that file. `mesh verify` recomputes it on
your machine — if our number and yours disagree, yours prevails.

5/ Honesty test: one of our own levers, the cache stamp, lost money on an
early live run (placed over a volatile prefix). The ledger caught it and
counted it against us. We published the loss, the root cause, and the fix.

6/ Numbers, with what was switched on. 37.9% is the cache stamp alone, on vs
off (SIMULATOR, modelled); the stamp is off out of the box. 18.2% net on our
one live basket (LIVE, 30 requests, 2026-10-26, our own test agents) had the
cache stamp and a tool-result cap on; the three out-of-the-box changes are
under half of it.

7/ What we won't say: that it's a token compressor, or that your bill will
shrink. Nobody has measured Mesh against a real provider bill, and there is
no out-of-the-box percentage to quote. No customers yet; tell us where it
breaks: github.com/Harrym1707/Mesh/issues/new

8/ Free to install and run. No fee is due unless billing has been agreed in
writing; then it is 1% of verified savings for the month, rounded down to
the cent, and nothing else. Nothing is charged automatically.
mesh-technology.com/pricing.html

## 4. Product Hunt (later — after HN + some social proof)

- Tagline (<60 chars): "A ledger of agent API spend you can recompute"
- Maker's first comment: the ledger story (compress the Show HN first comment
  to 150 words, keeping the install → `mesh proxy` / `mesh start` →
  `mesh verify` path, what a fresh install does, and each figure's label and
  levers); invite scepticism explicitly.
- Pricing field: link https://www.mesh-technology.com/pricing.html;
  one line only, "free to install and run; no fee is due unless billing has
  been agreed in writing; then 1% of verified savings for the month, rounded
  down to the cent, and nothing else". Not in the tagline.
- Launch Tue/Wed 12:01 AM Pacific; reply to every comment within 15 min.
- Assets needed before listing: 240×240 animated thumbnail, 1270×760 gallery
  shots (hero waves, reducer demo, the receipt), 60–90s screen demo.

## 5. Listings (fire once each, order by GEO value)

1. AlternativeTo — create account NOW (must age 7 days before listing); list
   as alternative to Helicone / LiteLLM / OpenRouter, category LLM cost.
2. tensorchord/Awesome-LLMOps PR — "Cost Management" section, one line:
   "Mesh — local proxy for agent API traffic that keeps prompts cacheable and
   records every request in a hash-chained ledger you can recompute
   yourself."
3. The smaller awesome lists (awesome-llm, awesome-llmops, awesome-claude
   variants) — same line, one PR each, spread over days not minutes.
4. MLOps Community Slack #be-shameless — short factual post, affiliation in
   profile first.
5. Anthropic Discord project-share channel — read #rules, then showcase post.

## 6. The newsletter asset (needed before TLDR/Latent Space have anything to link)

They link primary technical content, not landing pages. The asset to write
(Growth agent drafts, founder reviews): "How we verify LLM API savings with a
hash-chained ledger you can recompute yourself" — the mechanism post, with
the live-export spools and the published-loss story. Pitch Latent Space on
the incentive-design angle (billing only on verifiable savings), not the tool.
