# Lever scope — `tool-search-defer` (Anthropic Tool Search / `defer_loading`)

**Status:** scoped 2026-11-06. R&D shortlist item **S1** (`docs/rnd/cost-reduction-rnd-2026-11-04.md`),
the highest-value next lever. On branch `theo/tool-search-lever`, **all phases done**: Phase 1 (the
pure transform + tests), Phase 3 (catalogue + policy wiring), Phase 4 (measurement + replay-gate
harness + the generic gate→proof bridge), Phase 5 (the `taskCompletionGrader` verifier). The lever
runs end-to-end — transform → surfaced in coverage → gated on real traffic → publishable proof →
enforced — and stays correctly held until a customer-traffic gate run passes.

This document is the design the build follows. It is grounded in two things: the Mesh
reducer pipeline as it stands (`packages/sdk-js/src/reduce-request.ts`) and the Anthropic
API contract for Tool Search, confirmed against the live documentation on 2026-11-06.

---

## 1. What Tool Search actually is

Not a single `tool_search` type. You inject **one built-in search tool** into the request's
`tools` array — either `tool_search_tool_regex_20251119` or `tool_search_tool_bm25_20251119` —
and set **`defer_loading: true`** on each tool definition you want held back from the model's
working context. It is **GA / stable**: no beta header, only `anthropic-version: 2026-10-21`
or later.

How it saves tokens (the key fact for Mesh's model):

> **You still send every tool's full definition in the `tools` array on every request,
> including the deferred ones. The API excludes the deferred tools from the system-prompt
> prefix** — Claude doesn't process their definitions up front. When Claude needs a capability
> it isn't holding, it emits a `server_tool_use` search; the API runs the search **server-side,
> inside the same request**, expands the matching definitions into context (`tool_search_tool_result`
> → `tool_reference` blocks), and continues. There is **no extra client round trip for the
> search itself** — the only client round trip is the normal one to execute a tool Claude
> actually calls.

So the bytes stay on the wire; the **billed/processed input tokens drop**, because Claude's
processed context excludes the deferred definitions until it searches for them. Anthropic
reports a ~85% cut on a ~55k-token definition set, loading only the 3–5 tools a turn needs.

Where the saving lands: on **cold / cache-miss turns**. On a cache-warm turn the definitions
were already discounted to ~0.1x by the prompt cache, so deferring buys almost nothing there.
The saving concentrates on the first turn of a session and on any turn whose tool prefix
missed the cache.

**When it is worth it (Anthropic's own guidance):** ≥10 tools, or >10k tokens of definitions,
or aggregating many MCP tools. Below ~10 tools or ~100 tokens of definitions, standard tool
use is better and this lever should no-op.

---

## 2. Why this fits Mesh's model cleanly

Mesh's other tool levers (`tool-schema-compaction`, `tool-schema-description-trim`) physically
shrink the bytes and measure a **body-token delta** (`minified.tokensBefore - tokensAfter`).
Tool Search does **not** shrink the body — the deferred definitions are still sent in full, and
we also *add* the search tool and the `defer_loading` flags, so the serialised `tools` array is
marginally **larger**. A body-delta measurement would read zero (or negative).

That means `tool-search-defer` is **not a body-shrink lever**. It belongs with the
**rate / provider-usage levers** — `cache-ttl-5m`/`1h`, `execution-tier-flex`, `output-effort-*` —
which already push a change with `estimatedTokensSaved: 0` and whose real saving is read from
the provider's reported usage and proven by the replay-gate before it is ever billed. This is a
*good* fit: Mesh bills on verified savings read from provider usage, and deferral reduces exactly
the provider-reported input-token count on cold turns. The saving is measurable from the usage
delta, never estimated.

**Classification: `lossless: false` (needs-verification), never on by default.** In principle the
answer is unchanged — the full tools remain reachable via search — but deferral *can* change
whether Claude picks the right tool, and adds a server-side search step. So it is treated like
`output-effort`: recorded, held, and billed only after a tool-selection / task-completion gate
passes on the caller's own traffic. We do not claim it lossless the way compaction is
(byte-identical decoded schema); we prove it.

---

## 3. Integration points in the Mesh codebase

All line numbers are against `reduce-request.ts` as of branch `theo/tool-search-lever`.

| Concern | Where | Change |
|---|---|---|
| Config | `MeshTokenReductionConfig` (type, ~line 63) | add `toolSearch?: boolean \| { variant?: "regex" \| "bm25"; residentTools?: number; minTools?: number }` |
| Transform | `reduceRequest`, right after the `toolSchemas` block (~line 986) | call a new pure helper `applyToolSearchDefer(next, config, changes, countTokens)` so it defers the **already-compacted** tools |
| Saving attribution | the change it pushes | `lever: "tool-search-defer"`, `lossless: false`, `estimatedTokensSaved: 0` (saving read from provider usage by the gate), `detail` explaining deferral + where the saving lands |
| Economics catalogue | `packages/core/src/savings-model.ts` `PUBLISHED_LEVERS` | new entry `tool-search-defer` (phase 3) |
| Policy wiring | `packages/sdk-js/src/theo-policy.ts` — `applyLever`, `knownLeverIds()`, `ENFORCEABLE_LEVERS` | map `tool-search-defer` → `config.toolSearch` (phase 3) |
| Coverage surfaces | dashboard / `mesh status` | picks it up automatically once it is in `ENFORCEABLE_LEVERS` (phase 3) |

---

## 4. Hard constraints the transform must honour

These are the real work; each gets a dedicated test.

1. **`cache_control` + `defer_loading` = HTTP 400.** A tool carrying `cache_control` must never
   be marked `defer_loading`. *Good news from the code:* Mesh's own cache stamp
   (`stampAnthropicCacheTtl`) only ever stamps `system` / `messages`, **never `tools`** — and it
   bails entirely if `next.tools` already carries a `cache_control` (lines 778–780). So the only
   way a tool carries `cache_control` is the caller placing it. **Rule: keep every
   cache-control-bearing tool resident (non-deferred).** The breakpoint stays on a non-deferred
   tool, which is exactly what Anthropic requires.

2. **Anthropic surface only.** Act only on a `claude-*` model with an Anthropic-shaped `tools`
   array (objects with a direct `name` and an `input_schema`). OpenAI-shaped tools
   (`function.name`) and Bedrock Converse's `toolConfig.tools[].toolSpec` shape don't match, so
   the transform naturally no-ops on them — which also covers the **Bedrock Converse** exclusion
   (Tool Search is InvokeModel-only) without a runtime probe. The proxy can add a belt-and-braces
   surface check in phase 3.

3. **Model gate (dated allow-list, deny by default).** Supported on **Claude 4.5 and later and
   all 5.x** (opus/sonnet/haiku 4-5, 4-6, 4-7, 4-8, and 5.x). **Not** Opus 4.1 or earlier, not
   3.x. Mirror `anthropicEffortSupport`'s deny-by-default shape: an unrecognised id returns
   `false` and the lever no-ops rather than risk a 400. Widen only against a provider source.

4. **At least one non-deferred tool.** All-deferred is a 400. The injected search tool is always
   non-deferred, and the resident set is ≥1, so this holds by construction — but assert it before
   returning.

5. **Threshold.** No-op unless `tools.length >= minTools` (default 10). Below that, standard tool
   use wins and deferral would only add a search tool for no gain.

6. **Idempotence.** If a `tool_search_tool_*` tool is already present (caller or a previous Mesh
   pass), do nothing — never inject a second search tool, never re-defer.

---

## 5. Resident-set policy

Anthropic: keep your **3–5 most-used tools** resident (non-deferred). v1 keeps the **first N**
(default 4, configurable via `residentTools`) resident and defers the rest, because Mesh has no
per-tool usage ranking at reduce time. Any cache-control-bearing tool is forced resident
regardless of position (constraint 1). A usage-ranked resident set is a later enhancement once
the ledger carries per-tool call counts.

Namespacing note to carry into docs: tools named by service prefix (`github_`, `slack_`) let one
search match a whole group, which improves recall on large aggregated catalogues.

---

## 6. Measurement & replay-gate path

- The transform records the change with `estimatedTokensSaved: 0`; the **estimated** saving for
  Theo's catalogue is `Σ(token size of the deferred definitions)` on a cold turn (Mesh knows
  exactly which tools it deferred and their serialised size). This is the projection, not a bill.
- The **realised** saving is read from the provider's reported input tokens — the usage delta on
  cold turns between a deferred and a non-deferred request for the same workload — exactly as the
  ledger already records rate-lever savings.
- **Gate:** `needs-verification` → held until a shadow/replay harness proves, on the caller's own
  traffic, (a) the input-token drop on cold turns and (b) that tool selection / task completion
  stays within the quality ceiling. Only then may Theo enable it and bill its saving.

---

## 7. Phased build plan

1. **[DONE] Transform + unit tests** — `applyToolSearchDefer` (pure): injects the search tool,
   defers the tail honouring all six constraints, idempotent, no-op when unsupported. Plus the
   `toolSearch?` config field and wiring into `reduceRequest`.
2. **[DONE] Cache-stamp interaction test** — a request with both `toolSearch` and `cacheTtl`, and a
   caller-placed `cache_control` on one tool: that tool stays resident, and no deferred tool carries
   `cache_control`.
3. **[DONE] Catalogue + policy wiring** — `PUBLISHED_LEVERS` entry, `applyLever` / `knownLeverIds` /
   `ENFORCEABLE_LEVERS`; coverage surfaces it (as a "held for the gate" lever).
4. **[DONE] Measurement + gate** — `toolSearchGate` (`tool-search-gate.ts`) replays a cold-turn
   corpus both ways through the existing `replayGate`, reads the realised input-token drop from
   provider usage, grades with `toolSelectionGrader`, and on approval emits a publishable
   `TheoGateProof` via the new generic `gateProofFrom` bridge (the missing seam between a gate
   result and a policy). `responseToolCalls` was taught the Anthropic `tool_use` shape so the grader
   is not blind on tool-search traffic.
5. **[DONE] Verify** — `taskCompletionGrader` (`graders.ts`): scores the RECALL of the baseline's
   actions, so a benign search-detour step (which deferral legitimately causes on a multi-step
   agent) is not failed the way the Jaccard `toolSelectionGrader` fails it, while a missed or wrong
   required call still fails. Optional `requireAnswer` stops a do-nothing run from passing.
   `toolSearchGate` takes it via `grade` + `graderLabel: "task-completion"`, so the proof records how
   quality was judged. `toolSelectionGrader` remains the strict default; task-completion is the
   lens for multi-step agents.

---

## 8. Open decisions

- **Default search variant** — `bm25` (natural-language queries) is the safer default for an
  arbitrary catalogue; `regex` suits pattern/prefix matching. Proposed default: `bm25`.
- **Resident-set ranking** — first-N for v1; usage-ranked once the ledger carries per-tool counts.
- **Resident count default** — 4 (middle of Anthropic's 3–5).
