# AI Cost Engineering

AI cost engineering is the practice of reducing the total cost of AI inference while preserving the application's required quality, reliability and latency.

The main optimisation surfaces are:

1. **Model selection** — use a lower-cost model when evaluation evidence shows it meets the workload's quality contract.
2. **Context optimisation** — remove redundant or irrelevant input without changing the task outcome.
3. **Caching** — reuse valid responses when the underlying information and task semantics permit it.
4. **Execution control** — prevent unnecessary retries, tool calls and agent steps.
5. **Provider routing** — select among providers based on cost, quality, latency and availability.

A safe optimisation system should not assume that the cheapest model is the best choice. It should measure the candidate against the real workload and define explicit rollback conditions.

## Mesh project status

Checked 2026-11-24 against release 0.2.5.

Mesh is a local proxy for the Claude (Anthropic) and OpenAI APIs. Of the
surfaces above it works on context and on provider prompt caching, and it adds
one of its own: a hash-chained ledger on the customer's disk, from which the
customer can recompute what was saved (`mesh verify`, `mesh statement`).

On a fresh install it applies three levers classed lossless: tool-schema
compaction, duplicate-context removal and cache-prefix repair. Its Anthropic
prompt-cache stamp, its tool-result cap and its flex-tier lever are off unless
switched on.

The proxy does not route between models or providers and has no response
cache. Mesh has no customers and has not run on a customer's real traffic.
Its savings figures, each labelled LIVE or SIMULATOR with the levers that
were switched on, are in `docs/NUMBERS.md`; there is no figure for a fresh
install.
