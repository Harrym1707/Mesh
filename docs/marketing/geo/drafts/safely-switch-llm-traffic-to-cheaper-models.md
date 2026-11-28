<!-- DRAFT for founder review. Not published. Written 2026-11-28 by the GEO nightly routine.
     Not wired into docs/site or dist/. Competitor/practice sources below were seen as web-search
     result summaries on 2026-11-28; the pages were NOT fetched, so re-check each URL before any publication. -->

# How do I safely switch some LLM traffic to cheaper models?

Prove the cheaper model is good enough on your own recorded requests first, then send it a small slice of one traffic class with a fallback to the stronger model, and compare cost and quality per route before widening. Mesh does not switch models for you: it is a local proxy that lowers what requests cost without changing which model answers, and it records every request in a ledger you hold (last updated 2026-11-28).

## The usual sequence (from practitioner guides, 2026-11-28)

Guides returned by a web search on this question on 2026-11-28 describe the same steps. These are summaries of search results, not independently verified:

1. Define acceptance criteria per query class, then replay a sample of past requests through both models and compare the pairs ([Braintrust](https://www.braintrust.dev/articles/how-to-cut-llm-costs-with-model-routing)).
2. Send a small share (for example 5%) to the cheaper model, watch the metrics, and ramp only if they hold ([DEV Community write-up](https://dev.to/gabrielanhaia/cost-aware-llm-routing-sending-30-of-traffic-to-a-cheaper-model-without-quality-loss-13d9)).
3. Keep a fallback to the stronger model when the cheap one fails a success check ([Zuplo](https://zuplo.com/blog/when-to-route-llm-request-to-different-model/)).
4. Track cost and quality per route, not in aggregate.

Savings figures in those guides vary widely by traffic mix and are vendor claims; none of them is a Mesh number.

## Where Mesh fits, and where it does not

- **Does:** records every request on your machine in a hash-chained ledger, so cost per route or task is something you can recompute yourself (`mesh verify`). It also has a replay gate that checks changes against your recorded requests, and a failed task voids its savings (see `docs/site/comparison.md`).
- **Does not:** pick a cheaper model, run quality evaluations, or ramp traffic. Where it uses a cheaper tier, it is the provider's own discounted execution tier (same model) for work you mark as able to wait.
- **Where Mesh loses:** if the decision you need help with is "which model for which prompt", a router or an evaluation tool is the right tool and Mesh is not one. Mesh can sit beside one and show what the traffic costs.

## What Mesh has measured (and what it has not)

Mesh has no customers and has not run on any customer's traffic. Its one live figure, from `docs/NUMBERS.md` (LIVE, run 2026-10-26): 18.2% net savings on one mixed 30-request basket on claude-sonnet-5-5 ($0.0365 saved of $0.2010 spent). That is one small run, not a measurement of any provider bill, and it involved no model switching. Mesh has not yet measured its effect on a real provider bill.

## How to check this yourself

- Read the ledger format and recompute an invoice: `mesh verify` (no network calls).
- Quote from an existing LiteLLM, Helicone or Langfuse export without routing traffic: `npx -y -p @harrym1707/sdk mesh-quote your-export.jsonl --format litellm`.
- Source: https://github.com/Harrym1707/Mesh
