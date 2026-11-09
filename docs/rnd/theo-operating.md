# Operating Theo — modes and safety knobs

Theo is the autonomous token-engineer: he observes your traffic (content-blind),
proves lossy levers on your own captured requests, applies the ones that save
money within your quality ceiling, and rolls them back if quality drifts. This is
the operator's view of how to run him safely.

> **Not yet validated on real traffic.** Everything below is enforced in code and
> tested against mocks, but the gate's quality graders have not been checked
> against real output. Keep `optimise` off on real traffic until they are.

## Autonomy ladder (`--autonomy`, default `recommend`)

| Level | What Theo does |
|---|---|
| `observe` | Finds opportunities, changes nothing. |
| `recommend` | **Default.** Applies lossless levers; surfaces proven lossy levers as proposals for you to accept. |
| `test` | As recommend, and self-initiates gate experiments (queues the next levers to prove). |
| `optimise` | **Auto-applies** a lossy lever once it has a passing proof within the ceiling. Prints a one-time caution. |

Running: once (`mesh theo`), continuously (`mesh theo --watch 15m`), or always-on
inside the daemon (`mesh serve` / `mesh install`, which runs Theo alongside the
proxy and hot-reloads the policy he applies).

## The layered safety guarantees (all enforced in code)

1. **Quality gate.** A lossy lever is only ever enabled with a replay-gate proof,
   measured on your own traffic from the provider's reported usage.
2. **Hard quality-ceiling cap.** Enforcement clamps any route's ceiling to a hard
   maximum (`MAX_QUALITY_CEILING_PERCENT` = 5%); a lever whose measured drop
   exceeds it is never enforced, whatever the policy says. Tighten per environment
   with `--quality-ceiling <p>` (can only make Theo more cautious).
3. **Drift auto-rollback.** After a lever is applied, Theo watches the retry rate
   AND the provider failure rate; a rise past the threshold rolls the lever back
   and blocks it from being re-proposed.
4. **Exploration budget.** The gate makes paid provider calls; `--max-gate-calls`
   (default 200) caps them per run so auto-proving can't run up a bill.
5. **Capture is opt-in and bounded.** `mesh start --capture <file>` is the only
   path that writes prompt content, owner-only, capped by count and by size on
   disk (`--capture-max-mb`, default 5), bounded across restarts.
6. **Reversible.** Every change is a policy version; rollback is publishing the
   prior one. A bad or mid-write policy file falls back to the last good config
   and never breaks the request path.

## Recommended posture for a first (supervised) environment

- `recommend` autonomy, lossless-only auto, lossy as proposals you accept.
- Capture off unless you want pre-contract proofs; if on, keep the size cap small.
- Watch `mesh dashboard` (active / held / proposals / auto-rolled-back).
- Turn on `optimise` only after validating the gate's graders against real output.
