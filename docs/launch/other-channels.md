# Launch posts — other channels (founder fires each one)

**Drafts, not posted or sent.** Refreshed 2026-11-18 for Mesh 0.2.3. Posting
and sending are the founder's acts. Every savings number is in
docs/NUMBERS.md with its label (LIVE or SIMULATOR). Mesh has no customers and
has only run on our own test traffic: imply nothing else.

Sequencing (from research/channels.md): listings first (compounding GEO),
then HN, then DevHunt, X cadence throughout, Product Hunt later with social
proof. One community per day, never a blast.

---

## 1. console.dev pitch (email — their published criteria fit MESH exactly)

Subject: Mesh — local LLM cost proxy with a savings ledger you can recompute yourself

> Hi — Mesh might fit Console's selection criteria: it's dev-first,
> entirely self-service (one command, no signup, no sales call), and the docs
> lead with runnable commands.
>
> `curl -fsSL https://www.mesh-technology.com/install.sh | sh` (or
> `npm install -g @harrym1707/mesh`) installs it. `mesh start` connects
> Claude Code; `mesh proxy` starts a local proxy for your own app, which you
> point at it with `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` or
> `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`. It reduces each request before
> the provider sees it (lossless-only by default), then writes a hash-chained
> ledger of the provider's own reported usage to your disk. The differentiator
> is verification rather than claimed savings: the invoice is a pure function
> of a file the user holds, `mesh verify` recomputes it locally (a separate
> MIT package does the same), and the output for already-optimised stacks
> literally says "do not pay us". Published numbers include where it loses.
> It is new: so far it has only run on our own test traffic.
>
> Repo: https://github.com/Harrym1707/Mesh · Site: https://www.mesh-technology.com
> · Five-minute start: https://www.mesh-technology.com/start.html
>
> Happy to answer anything. — Harry

## 2. DevHunt listing

- Tagline: "Local proxy that cuts Claude/OpenAI API costs — with a savings
  ledger you can recompute yourself"
- Demo: the start page (five-minute walkthrough) + the evidence page
- Link GitHub repo as primary; first line is the zero-signup install
  (`curl -fsSL https://www.mesh-technology.com/install.sh | sh`, then
  `mesh start` or `mesh proxy`, then `mesh verify`).

## 3. X thread (no hashtags; story form; real numbers only)

1/ Anthropic's prompt cache is opt-in. Most agents never opt in. We metered
one of our own test agents, a five-turn coding agent, re-paying full input
rate for its ENTIRE history every turn — zero cache traffic. That's the
default state of most agent loops running right now.

2/ So we built Mesh: a local proxy. No signup.
`curl -fsSL https://www.mesh-technology.com/install.sh | sh`
(or `npm install -g @harrym1707/mesh`). Then `mesh start` for Claude Code, or
`mesh proxy` for your own app with `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`
or `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`. Keep your own key.

3/ Requests get reduced losslessly before the provider sees them; responses
come back byte-identical. Every request writes one event to a hash-chained
ledger on YOUR disk. The invoice is a pure function over that file.
`mesh verify` recomputes it on your machine — if our number and yours
disagree, yours prevails.

4/ Honesty test: one of our own levers lost money on an early live run (cache
breakpoint over a volatile prefix). The ledger caught it and counted it
against us. We published the loss, the root cause, and the fix.

5/ Numbers, labelled: 37.9% from correct cache placement alone (SIMULATOR:
modelled, identical prompts both arms). 18.2% net on our one live basket
(LIVE: 30 requests, run 2026-10-26, our own test agents). Already-optimised
stack? It says "do not pay us."

6/ Free to try, your prompts go to your provider and nowhere else, ~22ms
added p50 (local stub, 2026-10-20). Production pricing is 1% of verified
savings, monthly — a month that saves nothing bills nothing. No customers
yet; tell us where it breaks: github.com/Harrym1707/Mesh/issues/new ·
mesh-technology.com

## 4. Product Hunt (later — after HN + some social proof)

- Tagline (<60 chars): "Cut LLM API costs. Recompute every cent yourself."
- Maker's first comment: the ledger story (compress the Show HN first comment
  to 150 words, keeping the install → `mesh start` / `mesh proxy` →
  `mesh verify` path and the number labels); invite scepticism explicitly.
- Launch Tue/Wed 12:01 AM Pacific; reply to every comment within 15 min.
- Assets needed before listing: 240×240 animated thumbnail, 1270×760 gallery
  shots (hero waves, reducer demo, the receipt), 60–90s screen demo.

## 5. Listings (fire once each, order by GEO value)

1. AlternativeTo — create account NOW (must age 7 days before listing); list
   as alternative to Helicone / LiteLLM / OpenRouter, category LLM cost.
2. tensorchord/Awesome-LLMOps PR — "Cost Management" section, one line:
   "MESH — local proxy that reduces Claude/OpenAI request cost and meters
   verified savings into a hash-chained ledger you can recompute yourself."
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
