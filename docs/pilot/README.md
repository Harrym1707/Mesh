# MESH pilot kit

Everything a design-partner conversation needs, in one directory. **All of it is
draft material: nothing here has been posted or sent, and sending is the
founder's act, not an agent's.**

| File | What it is |
|---|---|
| [onboarding.md](./onboarding.md) | **Start here.** The one canonical way to set a design partner up (proxy mode), with the Claude Code and build-from-source alternatives. |
| [runbook.md](./runbook.md) | The one-page partner runbook (day 0 → day 14) **and** the step-by-step [Operator playbook](./runbook.md#operator-playbook--manual-billing) for manual billing. |
| [PILOT_PLAN.md](./PILOT_PLAN.md) | The pilot plan: target ICP, cohort size, success metric, timeline, and what we measure. |
| [pilot-agreement.md](./pilot-agreement.md) | Draft lightweight pilot agreement + onboarding email (keys never held, data kept/where, fee basis, no-charge-if-no-savings) — flags that real ToS/DPA are still needed. |
| [VERIFICATION.md](./VERIFICATION.md) | VERIFIED/BROKEN summary of the happy path, run end-to-end on `main` 2026-11-07. |
| [data-handling.md](./data-handling.md) | The data-handling answer, verbatim-usable, sourced to the code paths it describes. |
| [outreach-litellm.md](./outreach-litellm.md) | Draft letter 1: LiteLLM proxy operator (spend logs ready to triage). |
| [outreach-helicone.md](./outreach-helicone.md) | Draft letter 2: Helicone user re-evaluating their stack. |
| [engagement-list.md](./engagement-list.md) | Where the conversation already exists: the named LiteLLM threads, verified 2026-10-13, with draft responses. |

## Number discipline

Every figure in this directory carries one of three labels and a segment caveat:

- **measured** — produced by `evals/run-agent-ab.ts` (40 tasks x 5 turns, provider
  cache rules simulated per published provider documentation) at HEAD `4e9e774`,
  quality held (fullyGoodTasks >= 36/40), verified by an independent run.
- **simulator-measured** — produced by the cache simulator against synthetic
  traffic shapes; the mechanism is real but no provider has confirmed it on real
  traffic yet.
- **projected** — an estimate with a stated basis; never used in a quote or an
  invoice.

The standing caveat on *every* number: **MESH has processed zero real customer
traffic.** The harness is synthetic. The first real gateway export retires the
biggest caveat on every band — which is exactly what the pilot is for.

## The quotable matrix (as of 2026-10-13, HEAD 4e9e774)

| Segment | Savings | Label | Caveat |
|---|---|---|---|
| Interactive multi-turn agents, warm cache | 26.0–29.4% | measured | band across cache-window configs; honest segment ceiling ~35–45% (projected) |
| One-shot workloads | 45.5% | measured | — |
| One-shot, latency-tolerant | 72.8% | measured | requires caller-flagged async tolerance |
| Async-eligible agent traffic (flex/batch x0.5 stacked with caching) | 64.3% | measured | OpenAI-priced only; Anthropic batch rate not yet catalogued; applies ONLY to caller-flagged latency-tolerant traffic |
| Sparse agent traffic, 1h cache TTL | 34.1% | simulator-measured | Anthropic-shaped, tasks >5 min apart; real-traffic validation open; per-model cacheable minimums not yet enforced, so the quote may overstate on some models |

Never quote the async multiplier for interactive traffic, never quote 34.1% for
warm or one-shot traffic, and never present a simulator-measured figure without
its label.
