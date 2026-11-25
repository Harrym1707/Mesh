# Mesh compared with LiteLLM, Helicone and Langfuse for cutting LLM API cost

Mesh is a local proxy for LLM API traffic that makes three lossless changes to requests out of the box and bills 1% of verified savings from a ledger you can recompute; this page compares that with the tools it is most often named beside, including the rows where Mesh loses.

Most cost-saving tools publish their best number. Independent measurement keeps
finding a gap between claimed and delivered, so this page compares *methods*.
Competitor facts below come from each vendor's own documentation and pricing
pages, checked 2026-10-22; if something is wrong,
[tell us](https://github.com/Harrym1707/Mesh/issues) and we will correct it.

## What a fresh install of Mesh does today

Out of the box Mesh makes three lossless changes: tool-schema compaction,
exact-duplicate removal and cache-prefix repair. On Mesh's own 30-request test
basket (LIVE, run 2026-10-26, not a customer's traffic) those three account
for under half of the 18.2% recorded; the rest came from a 5-minute Anthropic
cache stamp and a gate-approved cap on oversized tool results, both off by
default. A Claude Code user gains little on the defaults. Mesh has no
customers yet and has not been measured on a customer's provider bill, and
nobody independent has measured it. The larger figures on this site needed
levers that you or Theo switch on: [how](start.md), [which](evidence.md).

## The independent findings this market needs to answer

- Three popular open-source token trimmers (rtk, headroom, caveman), claiming
  60–90%, were independently replayed over a 614M-token corpus of real coding
  sessions: **3.7% combined actual saving** (codepointer.dev deep dive).
- Progressive disclosure of tool schemas, modelled at ~77% token savings,
  measured **~13% in production**, because the router it adds costs an extra
  round trip per novel tool call (archestra.ai bench). Per-request measurement
  cannot see this; per-task measurement can.
- The best-funded commercial router ranked **12th of 12** on the independent
  RouterArena leaderboard while advertising 30%+ savings.
- Mesh's own history belongs on this list. Its first caching claim was 29%
  (SIMULATOR, an early model, withdrawn); its own per-task harness cut that to
  about 2% on busy agent traffic because the provider's cache was already
  doing the work. Later its own ledger caught one of its levers *losing* money
  on its live test basket (−$0.0063, LIVE, run 2026-10-19: a cache breakpoint
  over a prefix that changed every turn); the loss counted against Mesh, and
  the fix shipped with a test that prices both placements. On 2026-10-29 it
  stopped counting JSON formatting as a tool-schema saving, after the
  provider's own token count showed there was none. And on 2026-11-23 it
  found that its site quoted figures a fresh install does not give, which is
  why every figure here now names the levers it needed.

## Method comparison

| | Typical trimmer / router | Mesh |
|---|---|---|
| Unit of measurement | per request | **per completed task** |
| Quality check | self-graded or none | replay gate on your recorded requests; failed tasks void savings |
| Cache economics | usually ignored (trimming can *raise* bills: one measured case cut tokens 38% and raised cost +6.8%) | simulated to provider rules; the cache stamp is off by default, and when switched on a cross-turn volatility guard refuses to stamp prefixes that churn |
| Customer's existing savings | silently absorbed into the claim | itemised, excluded, never billed |
| Headline number | one global percentage | a figure per workload shape, each with its label, date and the levers it needed, including "do not pay us" |
| The invoice | trust us | hash-chained events; recompute it yourself |

## Where Mesh loses, stated plainly

- **A fresh install does three things.** The cache stamp, the tool-result
  cap and the discounted tiers are off until you switch them on, and Theo
  proposes a lossy lever only after proving it on a capture of your own
  requests. A gateway with one-flag cache placement gets you that lever
  sooner.
- **Claude Code users gain little on the defaults.** Claude Code already
  caches, and its tools leave the default changes little to remove.
- **Busy interactive agents: 25.9–29.4%** (SIMULATOR, verified 2026-10-13;
  needed the J lever stack, four of whose six levers are off by default). The
  provider's cache already delivers 35–40% there
  (SIMULATOR, harness re-run 2026-11-24; never claimed by Mesh).
- **Already-optimised stacks: 0–5%** (SIMULATOR, fixture, 2026-10-11; nothing
  to switch on). Mesh's quote will tell you not to buy.
- **A free trimmer may be all you need** if your waste is one obvious thing and
  you do not need the saving verified. What Mesh adds is a bill you can
  recompute; if you do not need that, rtk is free.
- **Most Mesh figures are SIMULATOR figures, and none is from a customer.**
  The one current LIVE figure is 18.2% of real spend (LIVE, run 2026-10-26,
  Mesh's own 30-request test basket, with a cache stamp and a tool-result cap
  switched on; the three default changes account for under half). Its
  hash-chained spools are committed to the repo so you can recompute it.

## The comparison grid

Facts dated 2026-10-22 from each vendor's own documentation (the LiteLLM
volatility row is our own empirical test, wire captures published in the
repo). Blank praise sells nothing: each tool wins its own rows.

| | Mesh | LiteLLM | Helicone | Langfuse |
|---|---|---|---|---|
| What it is | Cost-reduction proxy with verified-savings billing | MIT gateway + SDK, 100+ providers | Observability platform + AI gateway | Observability, prompt mgmt, evals |
| Licence | BUSL-1.1 (verifier MIT) | MIT (enterprise carve-out) | Apache-2.0 | MIT except ee/ |
| Price | 1% of verified savings for the month, rounded down to the cent, and nothing else | $0 core; enterprise custom | Free tier; Pro $79/mo; Team $799/mo | Free tier; Core $29/mo; Ent $2,499/mo |
| Changes the request | Yes: tool-schema compaction, exact-duplicate removal and cache-prefix repair out of the box (lossless); more levers off by default | Partially — MCP tool-schema deferral; compression via third-party sidecar | No | No (not in request path, by design) |
| Automatic Anthropic cache placement | Off by default; you switch it on. When on, it has a cross-turn volatility guard and a per-model minimum guard | Yes (one flag) — but stamps volatile prefixes verbatim every turn, no guard, no zero-read warning (our empirical test, v1.106.4) | No — customer writes their own cache_control | No |
| Response caching (identical repeats) | No | Yes (exact + semantic) | Yes (edge, exact-match) | No |
| Measures the saving | Yes: per lever, net of cache write premiums, into a ledger on your machine. Removed tokens are an estimated baseline; what you paid is the provider's reading | No | Cost tracking (best-effort on direct integrations) | Cost tracking (best-in-class auditability) |
| Customer-recomputable invoice | Yes — hash-chained ledger + MIT verifier; if your recompute disagrees, yours wins | No | No | Partially — exact-cost ingestion can match your provider invoice |
| Losses counted against the vendor | Yes — negatives never clamped, deficits carry forward | n/a (nothing measured) | n/a | n/a |
| "Do not pay us" verdict | Yes — literal output for already-optimised stacks | No | No | n/a (free tier exists) |
| Prompts leave your machine | Never — local proxy, analysis in-process | Self-hosted: no; their cloud: yes | Cloud-hosted path: yes | Yes (traces to their backend or your self-host) |

## Claimed vs independently measured — the market's problem in one table

| Tool / class | Claimed | Independently measured | Source |
|---|---|---|---|
| Three popular OSS token trimmers | 60–90% | **3.7%** combined, 614M-token real-traffic replay | codepointer.dev deep dive |
| Progressive tool-schema disclosure | ~77% modelled | **~13%** in production | archestra.ai bench |
| Best-funded commercial router | 30%+ | ranked **12th of 12** | RouterArena leaderboard |
| Mesh | SIMULATOR figures by workload shape, each with named levers switched on ([savings by shape](segments.md)) | **Not independently measured.** Mesh's own run: 18.2% of real spend (LIVE, run 2026-10-26, its own 30-request test basket, with a cache stamp and a tool-result cap switched on; the three default changes account for under half) | [evidence](evidence.md): every figure traces to a command |

Nobody independent has measured Mesh, and Mesh has not been measured on a
customer's provider bill. The right-hand cell says so because the same is
asked of everyone else on this page.

## LiteLLM, Helicone, Langfuse — what each actually does about cost

These three are excellent tools we are often mentioned alongside. They solve
different problems, they are each genuinely better than Mesh at those
problems, and Mesh reads all three of their export formats directly — if you
run any of them, you are one file export away from a quote.
[Runbook →](../pilot/runbook.md)

### LiteLLM (MIT gateway + SDK)

Better than Mesh at: breadth (100+ providers behind one OpenAI-format API),
production routing (six load-balancing strategies, fallbacks, cooldowns,
budgets, virtual keys), community and maturity — and the core is free.

On cost specifically, as of 2026-10-22 it **does** have reduction levers:
one-flag automatic Anthropic `cache_control` placement (5-minute default,
1-hour option), MCP tool-schema deferral (collapsing tool catalogues to two
virtual tools), exact-match and semantic **response** caching, and prompt
compression via a third-party sidecar (Headroom). Spend tracking prices usage
against a community-maintained price map, with per-deployment overrides.

What it does not do: **measure or verify the saving.** There is no per-lever
net accounting, no counterfactual baseline, and no customer-recomputable
record. And placement without metering can lose money silently: we tested
LiteLLM 1.106.4's auto-placement empirically against a system prompt carrying
a per-turn timestamp — it stamped the changed block verbatim on every one of
six turns, with no stability check and no signal after six consecutive
zero-read responses (wire captures in our repo under evals/wire-captures/).
Under Anthropic's documented billing that traffic pays the 1.25× write
premium every turn and never reads — the exact loss our own ledger once
caught us making, which is why Mesh's cache stamp, when you switch it on,
carries a volatility guard and nets every cache write against its reads. If
you want free levers that are on with one flag, LiteLLM ships good ones; if
you need a record of what a lever saved, net, that you can recompute, that is
what Mesh is for.

### Helicone (Apache-2.0 observability + AI gateway)

Better than Mesh at: observability (dashboards, sessions, custom query
language, alerts), a hosted multi-provider gateway with unified billing, and
prompt management — a mature platform (Pro $79/mo, Team $799/mo, as of
2026-10-22).

On cost: its gateway's exact-match **response caching genuinely avoids
provider charges on byte-identical repeated requests** — credit where due —
but it does nothing for novel requests or growing agent contexts, which is
where agent spend lives. It does not reduce request tokens, and for
Anthropic's prompt cache the customer writes their own `cache_control`.
Cost figures on direct integrations are self-described best-effort estimates.

### Langfuse (MIT-except-ee observability)

Better than Mesh at: tracing and evals depth (agent graphs, LLM-as-judge,
datasets, experiments), team features, and — worth crediting plainly —
**cost-tracking auditability**: daily automated price audits against provider
sources, customer-overridable model prices, and exact-cost ingestion that can
make its numbers match your invoice (Cloud from $29/mo; unlimited MIT
self-host; as of 2026-10-22).

On cost reduction: none, by design. Langfuse is async observability and is
never in the request path, so it cannot compact, dedupe, place cache
breakpoints, or cache responses, and it does not claim to. It tells you where
the money went; Mesh changes the next request and records the difference in a
ledger you can recompute.
