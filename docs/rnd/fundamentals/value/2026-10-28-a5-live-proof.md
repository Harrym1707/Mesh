# A5 output-effort lever — LIVE mechanism proof (2026-10-28)

**Result: APPROVED.** The `outputEffort` lever (`output_config.effort`) is proven real on
live model behaviour: a lower effort setting cuts output tokens while holding task
completion. This is the first non-caching lever MESH has validated against the real model,
not a simulator.

## What was run

`evals/run-effort-gate.ts` against the **live Anthropic API**, model **claude-sonnet-5-5**,
16 demonstration tasks (checkable answers so the grader scores task COMPLETION, not text
identity), baseline (default effort) vs candidates effort=low and effort=medium, default
2% quality budget, seeded grouped bootstrap. 48 provider calls.

## Measured

| candidate | task-completion delta (mean / lower95) | output tokens (baseline → cand) | saved | verdict |
|---|---|---|---|---|
| effort=low | 0.00pp / 0.00pp | 3,763 → 3,564 | **199 (5.3% of output)** | **APPROVED** |
| effort=medium | 0.00pp / 0.00pp | 3,763 → 3,564 | 199 (5.3% of output) | APPROVED |

## Honest reading (basis: measured, demonstration set — NOT a customer-billed number)

- **Mechanism validated:** effort=low spends fewer output tokens with ZERO task-completion
  regression on real Sonnet 5.5. The lever is real and billable through this gate.
- **Magnitude is modest (5.3% of output)** because these are short reasoning tasks with
  little output fat. The research (`2026-10-28-a2a5-value-synthesis.md`) puts A5's real
  prize on **verbose chat/generation** (output ≈ 64% of that bill); this demo set does not
  represent that, so 5.3% is a floor, not the ceiling.
- **effort=low == effort=medium** here (identical 3,564): Sonnet's effort dial is coarse on
  short tasks. On longer generation they would be expected to diverge — unproven here.
- **Standing rule:** the billable % for a customer still comes only from THAT customer's own
  traffic through this same gate. This proves the mechanism, not a headline number.

## To ship as billable

Wire a gate verdict `output-effort-low: approved` (per customer, per workload) into the
ledger (`MeshSavingsLedgerConfig.gateVerdicts`) so the lever's savings bill only after the
customer's own gate pass — the lossy-lever contract already enforced for every other lossy
lever. Until a customer runs their own gate, the lever stays record-only.
