# "How do you know Theo found the savings?" We made that a number, not a claim.

Theo is the agent that walks your traffic and applies our reduction levers —
schema compaction, prefix caching, batch routing, and the rest. Every vendor
in this space will tell you their optimizer is thorough. Almost none of them
will tell you what it misses. We spent the last build turning "thorough" into
something you can check: a coverage oracle that reports, per workload, how
many of the applicable levers Theo actually applies, and for every one he
doesn't, the specific reason why.

## The problem with "Theo found everything"

Theo doesn't invent levers. He runs a fixed, published catalogue
(`PUBLISHED_LEVERS`) against your traffic and applies whatever fits. That's
deliberately boring — we don't want an agent improvising cost cuts on your
production prompts. But it means the honest question isn't "is Theo smart,"
it's "how much of the catalogue actually touches this workload, and what's
left on the table." Before this, the answer to that question was: trust the
dashboard. Now it's a function (`coverageForProfile` in
`packages/core/src/theo-coverage.ts`) that takes a workload profile and a
price table and returns, deterministically, the same report every time —
safe to diff across builds, safe to assert on in tests (5 new tests, 239/239
core suite green).

## What it actually reports

Three things, none of them a single invented "achievable max" dollar figure
— we specifically didn't build that, because summing published reduction
factors into one ceiling is itself a guess, and guessing dressed as
measurement is the thing this whole project exists to push back against.
Instead:

1. **Lever coverage** — of the N catalogue levers that target a segment this
   workload actually has, how many (M) does Theo apply. `M/N` is the
   headline.
2. **Realized saving, split by confidence** — the percentage that's
   deterministic and billing today, versus the percentage that's held for a
   replay-gate proof before it's allowed to bill. These are not the same
   number, and showing one without the other is exactly the kind of
   conflation the evidence page calls out other vendors for.
3. **Every gap, named** — each applicable-but-unapplied lever, with its
   standalone projected headroom and the reason it's not applied. Two of
   those reasons are structural: `code-mode` and `progressive-disclosure`
   both require rebuilding how the agent calls tools (a sandbox, or a
   search-based tool catalogue instead of a static one), which a local proxy
   cannot retrofit transparently. We don't silently claim that headroom —
   we flag it as yours to capture, not ours.

## What it looks like on real workload shapes

We ran `pnpm demo:theo-coverage` today (2026-11-09) against the five
synthetic workload profiles already in the repo, priced at current
Sonnet 5.5 rates. This is the actual output, not a mocked example:

| Workload | Baseline | Projected saving | Live-now vs held-for-replay | Lever coverage | Gaps |
|---|---|---|---|---|---|
| Tool-heavy agent (6 MCP servers) | $191 | 88.6% | 30.7% live / 57.9% held | 7/9 (77.8%) | code-mode, progressive-disclosure |
| Support assistant | $356 | 85.1% | 50.0% live / 35.1% held | 8/10 (80.0%) | code-mode; progressive-disclosure correctly left off (−34.7% here) |
| RAG document QA | $328 | 77.9% | 14.3% live / 63.7% held | 4/4 (100%) | none |
| Reasoning-heavy analysis | $438 | 61.0% | 4.6% live / 56.4% held | 4/4 (100%) | none |
| One-shot varied prompts | $104 | 40.4% | 0.0% live / 40.4% held | 1/1 (100%) | none |

A few things worth sitting with in that table. First, on every workload the
"held for replay" share is bigger than the "live now" share — most of what
we project has not yet cleared the quality gate that lets it bill, which is
the point of having the gate. Second, the support-assistant row shows the
oracle correctly refusing a lever: progressive-disclosure projects *negative*
35% on that workload (it would cost more than it saves, because the extra
round trip per novel tool call isn't worth it there), so Theo leaving it off
isn't a gap, it's the right call, and the report labels it that way instead
of just going quiet. Third, the two architecture-level gaps on the
tool-heavy and support workloads are real money — 84.8% and 68.5%
respectively — that we're telling customers we cannot touch, instead of
building a vaguer lever that pretends to.

## Why this is the kind of thing we publish

Nobody asked us to build a module whose main output is a list of things our
own product doesn't do. We built it because "trust the agent" isn't a
measurement, and we don't get to hold other vendors to a standard we don't
apply to ourselves — the whole comparison page exists on that premise. The
coverage oracle doesn't change what Theo bills; it changes whether you can
check his homework. If a workload shows 4/10 coverage next month, that's not
a story we'll quietly fix in a changelog. It's a number on a dashboard you
already have access to, with a reason attached to every point it's missing.

Source: `packages/core/src/theo-coverage.ts`, `scripts/theo-coverage-demo.ts`,
commits `bcb6949` and `6ff7ec0`. Run the demo yourself: `pnpm demo:theo-coverage`.
