# A5 output-reduction — the CLEAR, DEFENSIBLE value (2026-10-28)

Axis owner: A5-output value analyst. Question: how much output-token **cost** is
really recoverable by MESH's one black-box output lever — the shipped
`outputEffort` dial (`output_config.effort`) — split by **workload shape**, every
number honesty-labelled, lossless-vs-gated called, plus the single cheapest live
experiment that confirms or kills it. Builds on the literature mine
(`../2026-10-28-output-token-reduction-literature.md`), the agent ground-truth
(`docs/rnd/knowledge/2026-10-26-output-token-ground-truth.md`), and the measured
chat distribution (`evals/fundamentals/value/wildchat_output_headroom.json`). No
new API money spent.

> Labels: `measured` = tiktoken o200k_base on real data in this repo;
> `derived` = arithmetic on measured anchors; `literature` = published claim;
> `estimate` = my judgement. MESH can only rewrite the request body + read
> provider usage. LOSSLESS → billable unconditionally. LOSSY → changes what the
> model emits → must clear a task-completion replay gate on the customer's own
> traffic before a cent is billed.

---

## Bottom line

**Output reduction has clear value on exactly ONE workload shape — verbose
chat/generation — and it is entirely GATED, never lossless.** There is no
lossless output lever: every byte the model does not emit is a byte it would
have emitted, so A5 can bill nothing unconditionally. The shipped `outputEffort`
dial is the only black-box lever, and its prize splits hard by workload:

- **Chat / single-shot generation:** output is **63.8% of the I/O bill**
  (`measured`). This is where the dial pays. A gated effort downshift that the
  literature says trims output length ~20–50% (`literature`, quality-variable)
  maps almost 1:1 onto the bill because output *is* the bill. Realistic
  defensible recoverable: **~10–25% of the chat bill, GATED** (`derived` from the
  64% share × a conservative trim, quality-gate-conditional). The provably-safe
  floor (boilerplate preamble) is tiny — **0.4% of output** (`measured`).
- **Agents (SWE-bench-shaped):** output is only **29.3% of a well-cached bill**
  (`measured/derived`, repo ground-truth), and the dial's own caveat is that on
  Opus-class models effort cuts *thinking*, not visible output — while agent
  visible output is already terse (median 62–71 tok/turn) and dominated by tool
  calls + code. Effort headroom on agents is **small and high-risk**, concentrated
  in the fat top-decile reasoning turns that are the most quality-critical to
  touch. Honest recoverable via the effort dial on agents: **low single digits of
  the bill, GATED, not worth leading with**. (The larger agent output prize —
  re-emission/diff, 24% of output is context-duplicate — is a *different* lever
  family, metering-first, out of scope for the effort dial; see §4.)

**Biggest opportunity:** the effort dial on verbose-chat traffic. **Cheapest
proof:** the existing `evals/run-effort-gate.ts`, run live on Sonnet 5.5 — 48
calls, **~$0.11 (≤ $0.50 worst case)** — which confirms or kills the *mechanism*
(does effort=low cut output tokens while holding task completion?) for the price
of a coffee. It is already runnable; I verified the harness end-to-end offline.

---

## 1. The two workload shapes and why output matters so differently

The whole A5 story is that "output is the dear half of the bill" is true for chat
and **false** for a well-cached agent — because caching collapses the input cost
line, not the output line, but only agents have a big cacheable input.

| | Verbose chat (WildChat) | Agent (SWE-bench mini) |
|---|---|---|
| output / **uncached** I/O tokens | 63.8% (`measured`) | 1.33% (`measured`) |
| output / **cached** real $ bill | ~60%+ (`derived`) | **29.3%** (`measured/derived`) |
| why | short context, little cache, output dominates | 31k context re-read ~27×, cheap via cache; output is #2 line behind cache reads (51.6%) |
| per-turn output p50 / p90 | 262 / 630 tok (`measured`) | 62 / 566 tok (`measured`) |

The agent "1.33% of uncached I/O" vs "29.3% of the cached bill" is the key
reconciliation: raw token counts make agent output look trivial; the real $ bill
makes it the #2 line, because prefix caching cuts the input *price* ~20× (Sonnet
cached $0.1/M vs input $2/M) while output stays at full $10/M and carries ~1.5×
echo leverage (each output token is re-read ~27× and adds ~0.5× its price in later
cache reads — `derived`, ground-truth doc). So on agents output still matters, but
the effort dial is a poor tool for it (§3).

## 2. Measured: output share of cost, by workload

- Chat: `assistant_output / (user+assistant) = 63.84%` on 2,500 WildChat English
  convos / 5,843 assistant turns (`measured`, o200k_base,
  `wildchat_output_headroom.json`). Chat gets little caching, so output share of
  the *bill* ≈ its share of I/O tokens, i.e. **output is the bill**.
- Agent: **output 29.3%**, cache reads 51.6%, cache writes 19.0%, uncached input
  ~0.1% of a well-cached mini-SWE-agent bill at Sonnet 4.5 prices (`measured/
  derived`, ground-truth doc; raw distribution in
  `evals/trace-analysis/swebench-output-distributions.json`).
- Concentration (both workloads): the **top 10% of turns hold 28% (chat,
  `measured`) to 47–64% (agents, `measured`) of all output** — the fat turns are
  where the tokens are, and they are the most quality-critical to trim.

## 3. Measured: verbosity / re-emission headroom the EFFORT dial could trim

What the effort dial can plausibly reach is *verbosity* (preamble, over-long
reasoning), not re-emission (that needs a reference/diff lever). Measured ceilings
on the chat corpus:

- **Preamble boilerplate** ("Sure!", "Certainly!", "Here's…"): present on 9.2% of
  turns but only **0.4% of output tokens** (`measured`). The one near-safe free
  lunch is near-zero. The effort/terse-style win is NOT in killing preambles.
- **Re-emission** (lines verbatim-repeated from earlier in the same convo): only
  **4.2% of chat output** (code 2.9%, prose 1.3%) (`measured`). Chat barely
  repeats itself — unlike agents (§4).
- **The real trim is reasoning/response *length*, which is unmeasurable without a
  counterfactual.** The literature is the only guide and it is a *range with a
  cliff*: Concise-CoT cut length −48.7% but math accuracy −27.7pp (`literature`);
  Chain-of-Draft cut GSM8K tokens −79% at −4.3pp accuracy, but sports tasks −92%
  tokens with accuracy *up* (`literature`). Direction is robust; the magnitude and
  the quality cost are entirely workload- and task-dependent. **This is precisely
  why the number is gate-determined, not assertable.**

Agent side (for contrast, `measured`, ground-truth doc): re-emission is **24.2%**
of output (code lines 34.8% re-emitted, prose 2.5%), and whole-file rewrites are
57% compressible to changed-lines. That is a large, real output waste — but it is
*structural duplication*, reachable only by a reference/diff lever that rewrites
what the model emits (deep lossy, high blast radius), **not by the effort dial**.
The effort dial does not make a model emit a diff instead of a whole file.

## 4. What is recoverable, and is it lossless or gated

**Nothing in A5-output is lossless.** Every lever changes the emitted sequence:

| Lever | Workload | Recoverable (honesty-labelled) | Lossless? |
|---|---|---|---|
| `outputEffort` dial (SHIPPED) | **chat / generation** | **~10–25% of bill** (`derived`: 64% output share × ~20–40% gated trim, quality-conditional) | LOSSY → **GATED** |
| `outputEffort` dial | agents | **~1–4% of bill** (`estimate`: 29% share × small, high-risk trim; effort cuts thinking not visible output on Opus-class) | LOSSY → **GATED** |
| stable concise-prefix instruction | chat | overlaps the dial; **reject as a silent proxy mutation** (rewrites the customer's own prompt; −27pp math cliff) | LOSSY → GATED + advisory-only |
| re-emission reference / diff | agents | ceiling ~7% of bill (`measured`, ground-truth) | LOSSY, **metering-first — different lever, out of this axis** |

The only "lossless" record the effort lever emits is the `output-effort-suppressed`
one: on a model NOT in the dated allow-list (e.g. Sonnet 4.5, Haiku, 3.x) it
changes nothing and bills nothing — honesty, not savings (verified in §5).

## 5. The gate: `run-effort-gate.ts` IS runnable — verified, no fix needed

The mandate asked me to make `evals/run-effort-gate.ts` runnable and fix blockers.
**I found no blockers; the harness runs.** Verified without spending money:

1. **No-key path runs clean** (`node --import tsx evals/run-effort-gate.ts`, no
   key) → prints the "NO API KEY — nothing proven" explanation and exits 0. The
   script refuses to simulate the lever's value, which is correct (a stub that
   assumed "low = 40% fewer tokens" would be the fixture-juicing the honesty rules
   forbid).
2. **All imports resolve.** `reduceRequest / replayGate / responseText /
   ReplayCandidate / ReplayGateResult / ReplayGrader` are exported from
   `packages/sdk-js/src/index.ts`; `lookupPrice / publishedModelPrices /
   resolveModelId` via `packages/core/src/index.ts` wildcard re-exports
   (`model-prices.js`, `price-catalogue.js`). `AT` from `evals/agent-fixture.ts`.
3. **The lever engages as the gate asserts.** Offline mechanics check
   (`evals/fundamentals/value/_gate_mechanics_check.ts`, local stub, no network)
   confirmed the reducer emits `output-effort-low` (lossless=false) on
   sonnet-5 / opus-5 / sonnet-4-6 / opus-4-8 and correctly emits
   `output-effort-suppressed` on sonnet-4-5; and that `replayGate` + grader +
   `reduceRequest` wire end-to-end (baseline + 2 candidates, approvals computed).
4. **The gate's `supportsLowAndMedium` allow-list matches the reducer's
   `anthropicEffortSupport`** — so the picker never selects a model the lever
   would then silently suppress on (which would read as a false "no saving").

One soundness note (not a blocker): the catalogue carries "Sonnet 5.5" but
`pickModel` falls back to the bare id `claude-sonnet-5`; if that bare id does not
resolve to a priced entry the gate still runs (price is optional — the token-delta
verdict stands; only the `$` line is omitted). To guarantee the `$` line appears,
set `MESH_LIVE_MODEL=claude-sonnet-5-5` (or whatever the workspace serves) before
the live run.

### The cheapest live proof — exact spec

- **Model:** Sonnet 5.5 (`claude-sonnet-5-5`) — cheapest effort-capable tier; the
  picker already prefers Sonnet. Its full effort range includes low/medium.
- **Requests:** the 16 built-in demonstration tasks × 3 runs (baseline default
  effort + `effort=low` + `effort=medium`) = **48 provider calls**, `max_tokens`
  1024 each.
- **Grader:** `effortTaskGrader` — task-completion, not text identity. Each task
  has a checkable `expected` answer read off the model's `FINAL:` line; a task the
  **baseline itself failed is not charged to the candidate** (only lever-caused
  regressions count). Quality budget = production default **2%**, with a seeded
  grouped bootstrap lower-95 bound.
- **Expected cost (Sonnet 5.5, $2/M in, $10/M out):** **~$0.11 realistic**
  (baseline ~350 / low ~110 / medium ~200 output tok per task), **≤ $0.50 absolute
  worst case** if every call ran to the 1024-token cap (`derived`).
- **Run:** `set -a && source ~/.config/mesh/anthropic.env && set +a &&
  MESH_LIVE_MODEL=claude-sonnet-5-5 node --import tsx evals/run-effort-gate.ts`

**What it proves / kills.** It is a *mechanism* proof on a reasoning-heavy demo
set (the regime where overthinking-waste is highest, so a favorable but legitimate
test): if `effort=low` does NOT cut measured output tokens on Sonnet (the Opus
caveat — effort steers thinking, not visible length), the lever is **killed for
~20 cents**. If it cuts output while holding task-completion within 2%, the
mechanism is real and the dial is worth offering on chat routes — but the
*billable %* for any customer still comes only from that customer's own traffic
through this same gate. The $0.11 run cannot produce a billable number; it
produces a go/no-go on the mechanism, which is exactly the cheapest confirm/kill.

### One cheap follow-on (only if the mechanism passes)

Swap the 16 demo tasks for ~50 real WildChat prompts (verbose-chat shape) with a
lightweight completion grader, same 2% budget. ~150 calls, still **< $2**
(`estimate`). This is the first measurement that looks like the target workload
and begins to bound the real chat recoverable % — but it is a second step, not the
confirm/kill.

## 6. Honesty caveats that cap every number here

- No number in A5-output is a per-request counterfactual. "Recoverable %" is
  always **gate-determined, estimated-baseline forever** — the token the model
  *would* have emitted at default effort is never observed.
- The effort dial's magnitude is model-specific: on Opus-class models it
  compresses thinking, not necessarily visible output, so the gate must read the
  **measured output delta**, never the dial setting.
- Cache interaction: effort set as a **stable top-level field** on a request is
  cache-safe; a per-turn effort *change* inside a cached conversation invalidates
  the prefix cache (use the per-message effort beta if ever varying it). On a
  well-cached agent a cache-busting effort change can net **negative**.
- The chat "~10–25% of bill" is the honest *gated* range, not a promise; the
  −27pp math cliff means it can be **killed per-customer** by their own gate.
