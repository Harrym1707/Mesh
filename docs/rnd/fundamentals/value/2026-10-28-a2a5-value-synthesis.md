# A2–A5 value synthesis — where the clear, defensible value actually is

Date: 2026-10-28. Synthesizer mandate: read the four axis analysts' measured
verdicts (A2 encoding, A3 redundancy, A4 irrelevance, A5 output), and give the
founder CLARITY — not "everything has potential". Blunt value tier per axis,
measured recoverable band + workload, lossless-vs-gated, the one proof. Then
where to invest, what to park/kill, and the ranked cheapest experiments.

Sources (read in full):
- `2026-10-28-A2-encoding-clear-value.md`
- `2026-10-28-A3-redundancy-clear-value.md`
- `2026-10-28-A4-irrelevance-tool-result-bloat.md`
- `2026-10-28-A5-output-recoverable-value.md`

Basis labels (measured / derived-from-data / literature / estimate) carried from
the source axes.

---

## Headline

**Only A5 has clear value, and only on one workload (verbose chat, where output
is 64% of the bill). A3 is a small-but-defensible agent lever. A4's real prize
lives entirely in a workload nobody has measured yet. A2 is dead as a lossless
billable lever and carries an active honesty liability that must be fixed.**

The transport axes (A1 cache, A6 batch) already did the heavy lifting, and that
is precisely why A3 and A4 shrank: **A1 caching already ate ~84% of the
re-emission cost** that A3/A4 would otherwise have reclaimed. The money left on
the input side is thin. The money left on the output side (A5) is real but
entirely gated.

---

## Per-axis verdict

### A5 — output reduction — **CLEAR VALUE (chat only), GATED**
- **Recoverable:** ~10–25% of the bill on **verbose chat / single-shot
  generation** (derived: 63.8% measured output share of I/O × a conservative
  20–40% gated length trim). On **agents**: ~1–4%, high-risk, not worth leading
  with (output is only 29.3% of a well-cached bill; effort trims thinking not
  visible output on Opus-class models).
- **Lossless or gated:** entirely GATED. Nothing in A5 is lossless — every byte
  not emitted is one the model would have emitted. The safe lossless floor
  (preamble boilerplate) is 0.4% of output. There is no unconditional bill here.
- **Why it's the real prize:** on chat, output *is* the bill, the `outputEffort`
  dial is already shipped and cache-safe as a stable top-level field, and the
  gap between it and revenue is purely proving quality holds on a customer's own
  traffic.
- **The one proof:** run the existing `evals/run-effort-gate.ts` LIVE on Sonnet
  5.5 — 48 calls, **~$0.11** (≤$0.50 worst case). Confirms or kills the
  *mechanism*: does `effort=low` cut measured output tokens while holding
  task-completion within 2%? (It cannot produce a per-customer billable number —
  that only ever comes from each customer's own traffic through the same gate.)

### A3 — redundancy — **CONDITIONAL VALUE (agents), GATED, cheapest to prove**
- **Recoverable:** ~1.4% of conversation tokens on coding-agent traffic
  (measured 1.43% mini-SWE+Sonnet, 1.42% OpenHands+GPT-5, 1.18% WildChat clean
  uncached) — cross-turn exact-duplicate fresh `tool_result` replacement. The
  famed ~8% duplicate ceiling is confirmed as a raw count but refuted as value:
  ~85% of it sits in the A1-cached prefix already discounted 10×.
- **Lossless or gated:** unconditionally-lossless A3 is EXHAUSTED (the shipped
  `dedupeRepeatedBlocks` already took within-message exact-dup). The one
  incremental lever is NEAR-lossless and therefore GATED.
- **Why it's worth keeping:** small but genuinely incremental (the duplicates
  are tiny — median 15 tok — so they slip below the shipped fresh-result cap),
  cache-safe (never edits the cached prefix), consistent across three
  independent workloads, and extends existing `crossTurnMemoryDedup` machinery
  rather than needing anything new.
- **The one proof:** extend the existing replay-gate harness over the 40
  already-downloaded SWE-bench trajectories, replacing each fresh exact-dup
  tool_result with a reference marker, and confirm task-completion is unchanged.
  **Zero API spend — pure offline replay.** Cheapest confirm/kill of all four.

### A4 — irrelevance — **CONDITIONAL VALUE, but the prize is UNMEASURED**
- **Recoverable (measured):** small — ~0–1.5% billable-today on
  harness-paginated code agents (SWE-agent, OpenHands, ToolBench). Observations
  dominate tokens (62–83%) but harnesses already cap them AND A1 cache already
  recovered ~84% of the re-emission. **Drop-stale mid-prefix compaction is
  net-NEGATIVE (−8.5% to −13.7%)** — it busts the cache it rides on. The only
  cache-stable lever (digest-on-arrival truncation) is single-digit % on these
  workloads.
- **Recoverable (estimated, the actual bet):** ~50–90% of oversized-observation
  cost on **raw browsing / document / data agents** injecting 10–50K-token
  pages/files/logs — but this is estimate/literature, with **no local dataset**.
- **Lossless or gated:** MIXED — lossless slice ≈0% (traffic already
  normalized); material slice is gated lossy truncation.
- **The one proof:** capture ~20 raw un-paginated browsing/document-agent
  trajectories, measure the raw observation distribution, apply head+tail
  truncation at a 2K cap on arrival, and run the replay gate. One decision: does
  task-completion hold? Yes + fat raw obs → A4 is real and large there. No → A4
  is gated-and-small everywhere and MESH ships only the near-lossless normalizer.

### A2 — encoding — **DEAD END (as a lossless billable lever) + HONESTY LIABILITY**
- **Recoverable:** ~0% billable beyond the free canonicalization the proxy does
  anyway. The minifier's headline "lossless ~39.5%" is 100% whitespace against a
  pretty-printed baseline real clients never send (they already emit compact);
  the structural key-drop pass saved **0 tokens on 0/100 real catalogues**; and
  the `tools` field is likely re-rendered by the provider so the whitespace may
  **not be billed at all**. The one genuinely clean lossless slice
  (pretty-printed JSON arriving as verbatim string content, 15–31%) was **absent
  from every real capture held** — real but workload-dependent and unmeasured in
  the wild. The tabular format-swap (JSON→TOON/CSV) is LOSSY and **net-negative
  on average** (−1.1% across all payloads), winning only on the ~30% of tool
  results that are uniform object-arrays.
- **Lossless or gated:** the lossless part is ~0-and-maybe-unbillable; the
  material part is gated lossy and narrow.
- **The one proof (do this regardless — it's an honesty fix):** one FREE
  Anthropic `count_tokens` call submitting the same real tool catalogue once
  pretty-printed and once compact. Identical counts → the provider re-renders
  the field, JSON whitespace is unbillable, and the minifier's whitespace claim
  must be **de-claimed from the published numbers**. This defends the moat.

---

## Where to invest next (1–2 axes)

**Invest in A5 and A3 — they cover the two workload shapes between them, and
their proofs are the cheapest and most decisive.**

1. **A5 (verbose chat).** The single biggest defensible prize: output is ~64% of
   the chat bill (measured), the lever is already shipped and cache-safe, and
   $0.11 buys a definitive go/no-go on the mechanism. Everything else about the
   chat number is just running a customer's own traffic through the gate. This
   is where the headline revenue on chat customers comes from.

2. **A3 (coding agents).** Not because 1.4% is large — it isn't — but because it
   is the most defensible incremental lever we have on agent traffic, it is
   cache-safe, it reuses existing machinery, and its proof costs **zero API
   dollars**. It is the natural complement to A5: A5 pays on chat, A3 pays on
   agents, and together they give MESH a defensible line on both customer
   shapes while A1/A6 carry the transport savings.

The logic: A5 is the biggest clear prize, A3 is the cheapest clear proof. Fund
both; they are not competing for the same workload.

---

## Park or kill

- **KILL — A2 as a lossless billable lever.** Stop chasing lossless value here.
  Keep the minifier as cache-neutral canonicalization only, and **de-claim the
  whitespace-lossless number** after the free count_tokens check. The honesty
  liability (billing for whitespace the provider may never charge) is more
  urgent than any upside.
- **KILL — A4 drop-stale mid-prefix compaction.** Measured net-NEGATIVE under
  the shipped A1 cache (−8.5% to −13.7%, worse on long trajectories). It fights
  the cache. Do not build it.
- **PARK — A2 tabular format-swap (TOON/CSV).** Narrow, opt-in, gated; wins only
  on uniform-array tool results and is net-negative elsewhere. Not a headline;
  revisit only if a customer's traffic is measured to be array-heavy.
- **PARK — A4 on harness-paginated code agents.** Marginal (single-digit %, A1
  already ate the re-emission). Do not invest build effort; the near-lossless
  normalizer is the only piece worth shipping here.
- **PARK (pending data) — A4 raw-browsing digest-on-arrival.** This is the only
  place A4 could be large. It is a *find-the-data* decision, not a build
  decision: do not fund the build until ~20 raw un-paginated browsing
  trajectories are captured and measured. High potential, entirely unproven.
- **PARK — A5 on agents.** Low single digits, high-risk, effort trims thinking
  not visible output. Not worth leading with; the agent output prize lives in a
  different (reference/diff) lever family, out of this axis.

---

## Ranked cheapest experiments (do them in this order)

1. **A2 free `count_tokens` check — $0.** Pretty vs compact tool catalogue, one
   call. Confirms/kills the minifier's whitespace claim and resolves the honesty
   liability. Cheapest possible and the most urgent for the moat.
2. **A3 offline replay gate — $0 (no API).** Replay the 40 recorded SWE-bench
   trajectories with fresh exact-dup tool_results replaced by reference markers;
   confirm task-completion unchanged. Confirms or kills the ~1.4% agent lever
   for free.
3. **A5 live effort gate — ~$0.11 (≤$0.50).** 48 calls on Sonnet 5.5 via the
   already-runnable `evals/run-effort-gate.ts`. Confirms or kills the chat
   mechanism — the biggest prize for the price of a coffee.
4. **A4 raw-browsing capture + replay — highest cost.** Requires acquiring ~20
   un-paginated browsing/document-agent trajectories first, then head+tail
   truncation + replay gate. Do this only after 1–3, and only because it's the
   one way to resolve whether A4 has a big number anywhere.

The first three cost **~$0.11 combined** and decisively resolve three of the
four axes. Run them before any build commitment.
