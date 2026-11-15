# Mesh Token Engineering Lab

An **internal, autonomous R&D team** that continuously researches, tests and
promotes new ways to reduce token usage in Mesh/Theo themselves. It is distinct
from **Theo**, who optimises Mesh's configuration inside a *customer's*
environment ([docs/rnd/theo-token-engineer-agent.md](../docs/rnd/theo-token-engineer-agent.md)).
The Lab improves Mesh and Theo; Theo improves a customer's bill.

It automates the R&D process that the repo already runs by hand in
[docs/rnd/lever-backlog.md](../docs/rnd/lever-backlog.md),
[docs/rnd/rnd-doctrine.md](../docs/rnd/rnd-doctrine.md) and
[docs/rnd/scout/](../docs/rnd/scout/) — turning a hand-maintained queue into a
working pipeline grounded in Mesh's **real** primitives (the reducer, the replay
gate, the hash-chained ledger).

```
Discover → Research → Design → Build → Challenge → Evaluate → Promote → Learn → Repeat
```

## Quick start

```bash
pnpm lab:demo      # one complete end-to-end workflow, narrated
pnpm lab:run       # advance the persistent ledger (lab/ledger) to quiescence
pnpm lab:status    # print the ledger + the promoted-lever portfolio
pnpm lab:verify    # verify the hash-chained audit trail
pnpm test lab      # the lab test suite
```

## The agent team

Each agent has a narrow responsibility and a narrow set of capabilities
([permissions.ts](permissions.ts)). No agent has unrestricted access; the ledger
refuses any mutation a role is not entitled to make.

| Agent | File | Does | Capabilities |
|---|---|---|---|
| **Scout** | [agents/scout.ts](agents/scout.ts) | Discovers techniques, records each as a structured lead. Writes no code. | `lead:create` |
| **Research** | [agents/research.ts](agents/research.ts) | Validates a lead against six constraints; rejects weak ideas early. | `record:research` |
| **Design** | [agents/design.ts](agents/design.ts) | Turns a validated lead into the smallest experiment spec. | `record:design` |
| **Builder** | [agents/builder.ts](agents/builder.ts) | Implements the experiment in an isolated workspace + produces the measurement dataset. Never promotes. | `record:build` |
| **Red Team** | [agents/red-team.ts](agents/red-team.ts) | Tries to prove it should *not* ship: privacy, token increase, hidden quality loss, reliability. | `record:red-team` |
| **Evaluation** | [agents/evaluation.ts](agents/evaluation.ts) | Independently measures candidate vs baseline via the real replay gate → PASS / FAIL / INCONCLUSIVE. | `record:evaluate` |
| **Maintainer** | [agents/maintainer.ts](agents/maintainer.ts) | The only role that may promote. Verifies every gate before admitting a change to the live portfolio. | `record:promote`, `portfolio:write` |

Two separations are **structurally enforced**, not merely documented: the
Builder holds neither `record:promote` nor `record:evaluate`, so it can never
declare its own experiment successful, and the Evaluator is a different role
from the Builder.

## The lifecycle & the ledger

The ledger ([ledger.ts](ledger.ts)) is the lab's durable shared memory. Each
optimisation is one record carrying its full lifecycle; every mutation also
appends to a **hash-chained** event log (same construction as
[packages/core/src/savings-ledger.ts](../packages/core/src/savings-ledger.ts)),
so any reordering, edit or deletion of history is detectable
(`pnpm lab:verify`).

```
discovered → researching → designed → building → red_team → evaluating → maintaining → promoted
                        ↘ rejected                        ↘ failed                    ↘ failed / inconclusive
```

Each non-terminal status maps to exactly one responsible agent; the orchestrator
([orchestrator.ts](orchestrator.ts)) advances the furthest-along work first, and
when nothing is in flight it dispatches Scouts — so **no human starts any
stage**.

Storage (plain, git-diffable files under `lab/ledger/`, gitignored at runtime):

- `records/<id>.json` — the current state of each optimisation
- `events.jsonl` — the append-only, hash-chained audit trail
- `portfolio.json` — the promoted-lever set (self-documenting: each lever carries *why it is on*)
- `workspaces/<id>/` — the Builder's isolated experiment workspace

**Duplicate / failed-experiment awareness:** a lead's fingerprint is
`sha256(category + techniqueKey)`. A lead already in flight is blocked; a settled
(failed/rejected/inconclusive) idea can only be re-opened with an explicit
`newReason`, which is logged.

## The non-negotiable constraints ([constraints.ts](constraints.ts))

Applied by Research (early rejection) and re-checked by the Maintainer (final
gate). They cannot be overridden by a lead's own claims.

1. **Content-blind, always** — an experiment may read only blind-feature inputs
   (keyed prefix hashes, structural/token counts, aggregated telemetry, timing,
   model/route ids). Declaring any raw-content input fails.
2. **Mesh-side only** — must act on an approved control surface (compaction,
   deduplication, cache placement, model/tier routing, output caps).
3. **No customer-application changes.**
4. **Objectively testable** — must have a runnable technique + a fixture.
5. **Meaningful saving** — below a floor it is not worth the risk.
6. **Acceptable risk.**

**Strict by default:** the default maximum permitted quality degradation is
**2%** (`DEFAULT_MAX_QUALITY_DEGRADATION`), configurable per experiment.

## Research allocation ([agents/scout.ts](agents/scout.ts))

Effort is split **50% core / 30% adjacent / 20% exploratory**, and within that
envelope biased by what has worked: `categoryOutcomes()` counts promotions and
failures per category, and the Scout favours categories with promoted wins and
damps ones with repeated failures — the lab learns where to look.

## How it is grounded in real Mesh primitives

The Lab measures genuine reduction; it does not mock it.

- **Builder** applies the real core reducers
  ([packages/core/src/token-reduction.ts](../packages/core/src/token-reduction.ts):
  `dedupeRepeatedBlocks`, `collapseWhitespace`) to fixture inputs and records the
  real token delta.
- **Evaluation** runs the real replay gate
  ([packages/core/src/replay.ts](../packages/core/src/replay.ts): `evaluateReplay`)
  to produce the quality/cost verdict.
- The honesty basis of "lossless-first": a lossless reducer removes only bytes
  the model does not need, so the model's visible content — and therefore its
  answer — is unchanged. The gate still measures the (zero) accuracy drop and the
  real cost saving.

The seed catalogue ([catalog.ts](catalog.ts)) deliberately spans every outcome:
runnable content-blind winners (dedup, whitespace) that promote; spec-only leads
with a measurement plan but no implementation yet (cache-TTL, stale-tool
compaction) that evaluate INCONCLUSIVE; and a prompt-rewriting idea that Research
rejects on the content-blind / Mesh-side constraints.

## Promoting into production

The Lab promotes into its **own** portfolio and records the decision with
evidence and code links; it never commits to the protected branch autonomously.
A promoted lever is a policy version the proxy would hot-reload (as Theo does),
so promotion is reversible by reverting to the previous version — matching the
decide-async / enforce-sync separation in the Theo design.
