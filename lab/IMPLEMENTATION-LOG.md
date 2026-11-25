# Token Engineering Lab — implementation log

Concise, auditable record of what was built and why. Newest first.

## 24-hour improvement loop — 2026-11-10 21:38 GMT → 2026-11-11 21:38 GMT

**North star:** blended % saved for the end user (`pnpm lab:status`).
**Rules for every iteration:** pick the top open queue item · build it in `lab/`
(product packages only for additive, opt-in, tested code) · run the full suite +
`typecheck:lab` · qualify honestly (basis label on every number; never inflate) ·
log it here · commit locally only when green · do not push (left for review).

### Standing queue (highest value first)

1. ~~Block-array prefix repair, measured.~~ **Done — iteration 2** (74.8% of the
   volatile session, SIMULATOR, gate-required).
2. ~~Simulated task-completion grader~~ and 3. ~~Paying-shape tier~~ —
   **Done together — iteration 3** (`lab/paying-shape.ts`).
3a. ~~Wire the tiers into the pipeline~~ — **Done — iteration 5.**
3b. ~~Long-session variant~~ and 5. ~~Cache-TTL sensitivity~~ — **Done — iteration 4.**

**Added 2026-11-16 (iteration 8), ahead of the list below:**
- **Tool-result JSON whitespace removal into the product**, lossless, as an
  opt-in lever first. The only new lever that needs no quality gate. Harry's call.
- **A real quality gate for the tool-result reducers**, starting with the two
  that act on the commonest agent work: a re-read file as its changes (coding)
  and JSON columns with repeated sub-objects as pointers (API and MCP tools).
  Needs a provider key and tasks with checkable answers.
- **Fix `minifyJsonBlocks` in `packages/core`** so it keeps number lexemes.
- **A real tokenizer** for the lab, so the line-number gutter of a file read and
  JSON indentation can be measured instead of estimated.
- **Longer sessions and non-GitHub API responses** in the task corpus.

**Added 2026-11-14 (iteration 7), ahead of the list below:**
- **One small live run** on the corrected cache guard, to turn the
  DERIVED-FROM-LIVE figure for the coding agent (20.7% of its bill, 6.1% of the
  live basket) into LIVE. Needs a provider key — Harry's call.
- **A browsing workload with a real grader**, so the two stale-snapshot levers
  (`needs_gate`) can be judged. Without one they stay lab-only.
- **Exclude page snapshots from the generic fresh tool-result cap.** On the
  browsing shape the cap truncates every page the agent is about to act on.
- **Stamping an unflagged workload once its prefix repeats** (the live support
  chat) is still lab-only; in the product the cache flag comes from the caller
  or a Theo policy.

**Added 2026-11-12 (iteration 6):**
- ~~Span-keyed cache stamping into the product~~ — **Done — iteration 7**, for
  workloads that carry the cache flag.
- **Output.** 57.7% of the remaining live bill and no measured lever. Needs a
  task-completion gate with a real model before `outputEffort` can be judged.

**Open after the 24-hour run (in priority order):**
- **Real replay gate for the `needs_gate` levers** (fresh tool-result cap,
  block-array prefix repair). Needs real traffic or a provider key — Harry's call.
- **Cadence-aware TTL selection in the proxy.** The lab shows the mechanism
  (5m stamp loses 12.3% at slow cadence; 1h saves 27.0%); the product still
  takes the TTL as a caller flag.
- **Block-array prefix repair into the product**, off by default behind the gate.
3c. **Calibrate the modelled mix against LIVE.** Use the LIVE per-agent figures
   from `docs/NUMBERS.md` where they exist (coding 38.1%, RAG 22.0%); the RAG
   fixture overstates real traffic 2.5× and should be rebuilt or down-weighted.
4. **Already-caching share.** Make the fleet number an explicit range model over
   the share of customer traffic that already caches.
5. **Cache-TTL sensitivity.** Spacing sweep (30s / 8m / 45m) × 5m vs 1h TTL via
   `simulateCache` to make the cadence-aware TTL lead measurable.
6. **Red-team hardening.** Property tests for every reducer: never increases
   tokens, idempotent, preserves fenced code, byte-identical on clean input.
7. README + floorplan refresh; final report at 24h.

### Iteration 10 — 2026-11-24 · a conversation keeps the policy it started with

**Why.** Iteration 9 found that every lever except history compaction keeps a
cached prefix stable, but only while the SAME levers act on every turn. The
proxy re-reads its policy on every request. A lever Theo publishes, a policy
file edited by hand, or a proxy started under a client that is already
mid-conversation changes the bytes of the prefix from that turn on, and the
provider writes the whole history again at 1.25x instead of reading it at a
tenth.

**What was built.** `packages/sdk-js/src/conversation-policy-pins.ts`
(`ConversationPolicyPins`), used by the proxy on every request and on by
default (`conversationPolicyPins: false` restores the old behaviour). The rules:

- A conversation is its model plus its first message, keyed with an HMAC, with
  cache markers stripped and a plain-string body treated as the one text block
  it equals.
- A conversation in flight keeps the policy it was first given.
- A request that STARTS a conversation takes the current policy: the model has
  not answered in it yet, or it is no longer than when the conversation was
  first seen. One-shot calls are always starts, so they are never held on an
  old policy.
- Idle for longer than one hour (the longest cache lifetime offered), nothing
  can still be cached, so the conversation is re-pinned to the current policy.
- A conversation the proxy did not see the start of, whose caller is caching
  it, is left untouched (no lever at all) for one hour from when it was first
  seen, then joins the current policy.
- The exception: a LOSSY lever the current policy no longer has is dropped at
  once, cache or no cache. Theo withdraws a lossy lever when quality drifts,
  and that outranks one re-write.
- With `blindFeaturesKey` set the pins are kept across restarts in
  `<ledgerDirectory>/conversation-pins.json`: keyed hashes and lever settings,
  never content.

`pnpm lab:cache` gained two columns: "pinned" (the lever published halfway
through a conversation, as the proxy now handles it) and "withdrawn" (a lossy
lever on from the first turn, removed halfway).

**Basis: SIMULATOR.** `corepack pnpm lab:cache`, as iteration 9: real recorded
tool outputs, scripted sessions, estimated tokens, documented cache rates,
turns 20 s apart. No model ran; no provider was called. Figures are the worst
change in billed input cost among cached conversations; minus is dearer.

| Lever | Published halfway, applied to the next request | Published halfway, pinned | Lossy lever withdrawn halfway |
|---|---|---|---|
| Tool-schema compaction (default) | -40.8% | +0.0% | n/a |
| Duplicate-context removal (default) | -5.8% | +0.0% | n/a |
| Cache-prefix repair (default) | +0.0% | +0.0% | n/a |
| JSON tool-result compaction | -34.9% | +0.0% | n/a |
| Tool description trim (lossy) | -45.0% | +0.0% | -45.1% |
| Fresh tool-result cap (lossy) | +25.5% | +0.0% | -12.6% |
| Cross-turn memory dedup (lossy) | -0.8% | +0.0% | -7.3% |

1. **Pinned, a policy change costs a conversation in flight nothing**: +0.0%
   for every lever. The lever reaches conversations that start after it.
2. **A lossy withdrawal still costs a re-write, by design**: up to 45.1% more
   input for that conversation (description trim).
3. **The lab check caught a bug in the first version.** It keyed a
   conversation on its raw first message. A client that moves its
   `cache_control` marker to the newest block every turn (Claude Code does)
   sends the first message with a marker on turn one and without it on turn
   two, so turn two looked like a new conversation joined mid-flight and was
   left untouched. The "withdrawn" column showed it: description trim read
   -32.2% and the overridden compaction +0.0%, against -45.1% and -26.6% once
   fixed.
   The unit tests had only put markers on the system prompt and did not see
   it. Fixed by stripping cache markers from the identity; a test now covers a
   moving marker.

**Also checked, at the release session's request.** `historyCompaction: true`
does nothing on an Anthropic tool loop that has one user message: 9 steps of
assistant `tool_use` and user `tool_result` blocks, 80,345 bytes of history in
and 80,345 out, no lever recorded. It counts a turn only at a real user
message, tool-result carriers are not turns, and it starts at 3 turns, so a
single-task tool loop never has a stale turn. It does digest tool results once
user text turns separate them (81,219 to 29,323 bytes with one between each
step), and plain-text assistant turns (5,177 to 2,087 bytes over 9 turns).
Checked with a throwaway script against `reduceRequest`; not changed.

**Limits.** Two conversations open at once with the same model and an
identical first message share one pin. An untouched conversation joins the
current policy one hour after it was first seen, which is one re-write if it
runs that long. The check measures a policy change at the halfway turn only.
The pin applies in the proxy; `withMesh` takes a fixed configuration and needs
none.

### Iteration 9 — 2026-11-24 · cache compatibility: which levers can raise a bill

**Why.** A published study of Claude Code (arXiv 2607.12161, read by the
release session, not by this one) found that cutting tool-output tokens raised
the billed cost, and that another local proxy raised it by about half. The
mechanism is the prompt cache: an agent's history is a prefix it re-sends every
turn and a caching client pays a tenth of the input rate for it. A proxy that
changes that prefix differently on two turns turns reads into writes at 1.25x.
Mesh had never been checked for this.

**What was built.** `pnpm lab:cache` (`lab/cache-compat.ts`, pricing in
`lab/cache-stream.ts`). 22 multi-turn sessions (the five recorded agent tasks,
a browsing agent, five chat shapes; each with a client that does not cache,
one that places breakpoints, and one that uses automatic caching) against each
lever alone. Three checks: A, every reduced turn is still an exact prefix of
the next where the provider caches; B, are the bytes inside a caller-cached
prefix unchanged; C, the stream priced under the cache rules, raw against
reduced, with the lever on from the first turn and switched on halfway.

**Basis: SIMULATOR.** Real recorded tool outputs, scripted sessions, estimated
tokens, documented cache rates (write 1.25x, read 0.1x, 5-minute lifetime,
1,024-token minimum), turns 20 s apart. No model ran; no provider was called.

**Found.**

| Lever | A: prefix stable where cached | C: billed input, cached conversations | Switched on halfway |
|---|---|---|---|
| Tool-schema compaction (default) | yes | +5.0% cheaper | -40.8% (dearer) |
| Duplicate-context removal (default) | yes | +7.8% | -5.8% |
| Cache-prefix repair (default) | yes | 0.0% | 0.0% |
| JSON tool-result compaction | yes | +7.9% | -34.9% |
| Cache stamp | yes | n/a (defers to the caller) | n/a |
| Tool description trim (lossy) | yes | +0.2% to +10.4% | -45.0% |
| Fresh tool-result cap (lossy) | yes | +53.6% to +89.6% | +25.5% |
| Cross-turn memory dedup (lossy) | yes | +11.9% to +40.7% | -0.8% |
| **Stale-history compaction (lossy), before this iteration** | **NO: 4 cached sessions** | **-80.6% to +12.3%** | -79.0% |
| Stale-history compaction, gated | yes | does not act | does not act |

1. **One lever could do what the study measured: stale-history compaction.**
   On conversations a client was caching it removed 7.2% to 34.2% of the input
   tokens and RAISED the billed input cost by 7.1% to 80.6%. It moves its
   boundary every two turns by default, and every move re-writes the history.
   The same happened under Mesh's own cache stamp: on four chat shapes the
   stamp alone saved 75.3% to 85.7% of the input bill and the stamp plus
   compaction 52.7% to 81.7%.
2. **It is now gated in the product** (`packages/sdk-js/src/reduce-request.ts`):
   compaction is withheld on a request whose history is under a cache
   breakpoint (the caller placed one in the conversation, the caller uses
   automatic caching, or Mesh's stamp will place one on the newest message)
   and a `stale-history-compaction-suppressed` record says why.
   `historyCompaction: { allowUnderCache: true }` overrides it. Where nothing
   caches the history it still runs: +7.2% to +34.2% there, and +32.7% on top
   of the stamp for a conversation whose instructions open with a clock (the
   stamp places no breakpoint on that history).
3. **Every other lever keeps the prefix stable.** Each is a pure function of
   the bytes it changes, so it changes them the same way on every turn.
4. **They do change bytes the caller cached, and that has a price once.**
   Switched on halfway through a cached conversation, tool-schema compaction
   costs that conversation 40.8% more input, description trim 45.0%, JSON
   compaction 34.9%: the prefix is re-written one time. On from the first turn
   they cost nothing. Mesh reloads its policy at any moment, so this is what a
   lever Theo applies mid-conversation, or a proxy started under a running
   client, costs. Not fixed here: the fix is to hold a policy change until a
   conversation starts.

**Limits.** Sessions are scripted; a 20-second turn gap means nothing expires;
the pricer has no 20-block lookback and no provider-side rounding; the
automatic-caching client is modelled as one breakpoint on the last block.
Output cost is left out of check C on purpose (no lever here changes it).

### Iteration 8 — 2026-11-16 · agent tasks: where the tokens go, and what Mesh can take out

Harry (relayed by the release-staging session): "I also want the engineering
lab to focus today on reducing agent token usage across different tasks."

**Why this, and why now.** The people waiting to use Mesh run Claude Code,
which caches for itself. On that traffic the cache is not Mesh's to claim, and
the release-staging session measured the default tool-schema lever on the real
Claude Code CLI at about 1.7% of one request's bytes (30 tools, only `$schema`
to remove). So the question is what is left.

**Built** (lab-only; no product code)
- `lab/agent-tasks/capture.sh` + `lab/agent-tasks/corpus/` — 22 REAL tool
  outputs recorded from this repository: file reads, search hits, a directory
  listing, git log and diff, passing and failing test runs (one inside a
  pseudo-terminal), compiler errors, an install log, a build log, three GitHub
  API responses for this repository and three pages of the project's own site.
  Paths are normalised. No customer content.
- `lab/agent-tasks.ts` (+ `pnpm lab:tasks`) — five scripted agent sessions over
  those outputs (fix a bug, explore a codebase, answer from API responses,
  triage a failing build, research from web pages), each priced for a client
  that already caches and for one that does not.
- `lab/experiments/tool-result-codecs.ts` — reducers that act on a tool result
  before it is first sent. Each is a pure function of the text, so a result is
  rewritten identically on every turn and a client's cached prefix is unaffected
  (tested: history is byte-identical from one model call to the next).

**Basis for every figure below: SIMULATOR.** Real tool outputs; scripted
sessions; the system prompt, tool definitions and the agent's own words are
ESTIMATES; tokens estimated (no provider tokenizer, about ±15%); documented
cache multipliers. No model ran: quality is unmeasured. Not in `docs/NUMBERS.md`.

**Finding 1 — an agent's input is its tool results.** 74.6%–93.2% of the input
these sessions send is tool results. For a client that caches, 64%–87% of the
bill is cache WRITES: each new result is written once at 1.25x. So every token
taken out of a result before it is first sent saves at least 1.25 tokens, plus
0.1 for each later turn that would have re-read it.

**Finding 2 — Mesh's built-in policy saves 0.0% on these sessions**, cached or
not. The tool definitions here are hand-written and already clean, so read that
as "close to nothing", in line with 0.06% on the wire captures and the Claude
Code measurement above. For a client with no cache, turning the cache on is
worth 32.8%–71.2%; that is still the first thing to get right for such a client.

**Finding 3 — which reducer matters depends on the task.** Whole-bill saving
against the same client with no reducer; each line includes the ones above it.

| Task | Tier reached | Client caches | No caching |
|---|---|---|---|
| Answer from API responses | parse-equal (JSON layout whitespace) | 7.7% | 7.2% |
| | + reversible (columns, repeated sub-objects) | 58.3% | 58.8% |
| | + repeated result as a pointer | 63.7% | 60.8% |
| Fix a bug | + reversible (grouped search hits) | 3.2% | 4.3% |
| | + a re-read file shows only what changed | 15.3% | 13.3% |
| | + lossy (passing-test lines folded) | 19.3% | 15.6% |
| Explore a codebase | + reversible (grouped search hits) | 4.5% | 5.2% |
| | + repeated result as a pointer | 13.7% | 10.6% |
| Triage a failing build | everything short of lossy | 0.0% | 0.0% |
| | + lossy (passing-test lines folded) | 8.2% | 4.4% |
| Research from web pages | everything short of lossy | 0.0% | 0.0% |
| | + lossy (HTML as readable text) | 52.6% | 47.1% |

Per output (tokens before → after, applied alone): the pull-request list
23,427 → 7,674 with repeated sub-objects as pointers (-67.2%: GitHub repeats the
whole repository object on every row); check runs 7,289 → 2,818 (-61.3%);
branches 3,658 → 2,835 as columns (-22.5%); search hits -26.7% and -29.3%;
pages -60.0% to -69.6% as text; a verbose passing test run -93.8% folded. File
reads, the directory listing, git output, the failing test run and the compiler
errors: no reducer here applies.

**Finding 4 — rewriting old history is the wrong tool for a client that
caches.** Trimming the OLDER copy of a re-read file saves 13.7% with no cache
and RAISES a caching client's bill by 11.1% (-14.3 points against the rung
below it): the rewrite invalidates everything cached after it. The mirror
image, which leaves history alone and shrinks only the newest read, saves 15.3%
and 13.3%. Both are in the pipeline; the first is recorded as failed.

**Finding 5 — two honest negatives.** Stripping terminal colour codes found
nothing: the pseudo-terminal recording of a real test run carries 9 escape
sequences and no colour codes. Runs of identical lines: none of the 22 outputs
has one long enough to be worth a marker.

**Finding 6 — a flaw in an earlier lab reducer.** `minifyJsonBlocks` in
`packages/core` (added by this lab, promoted here as lossless, called by no
product path) goes through `JSON.parse`, so it rewrites numbers: `1.0` → `1`,
`1e3` → `1000`, and `12345678901234567890` → `12345678901234567000`. The new
`json-minify` codec keeps every lexeme as written. The core reducer needs the
same fix before anything uses it; raised as its own change.

**Tiers, and what the lab will and will not claim**
- parse-equal: the same JSON document (tested: equal after parsing, every
  number and string as written). Promoted as lossless. **1 lever.**
- reversible: an exact inverse exists and is tested on every recorded output
  (columns, repeated sub-objects, grouped search hits). Nothing is lost, but the
  model reads a different layout → `needs_gate`.
- content-preserving (pointer, re-read as changes): the content stays verbatim
  elsewhere in the transcript → `needs_gate`.
- lossy (HTML as text, folded test lines) → `needs_gate`.

**Qualification**
- Output is 2%–9% of these scripted bills, because the agent's own words are
  short here. On the LIVE run output was 57.7% of the remaining bill. An
  input reducer's whole-bill saving shrinks in proportion: at the live share
  these figures would be a little under half their size.
- With a tool catalogue of ~9,124 tokens instead of ~1,564 the
  content-preserving figures read 11.2% / 8.7% (bug fix), 9.7% / 6.2%
  (exploration) and 53.4% / 47.6% (API responses).
- Sessions are 3 to 10 tool calls. Longer sessions re-read each result more
  often, which favours every reducer here; not measured.
- The API responses are GitHub's, which repeat sub-objects heavily. Other APIs
  will differ; the columns figure (22.5% on a plain list) is the safer guide.
- The web-page figure assumes a fetch tool that returns raw HTML. Many return
  Markdown already, and then there is nothing to take.
- The estimator counts indentation as free, so the JSON whitespace figure is
  likely understated.

**Pipeline.** 9 new leads (40 on a fresh ledger): `tool-result-json-minify`
promoted (lossless, 7.7%); six at `needs_gate` with quality unmeasured (JSON
columns and repeats 50.6 points, HTML as text 52.6, re-read as changes 12.2,
repeated-result pointer 9.2, folded test lines 8.2, grouped search hits 3.2);
two failed (older-read trimming, terminal codes). Totals: 17 promoted, 10
`needs_gate`, 7 failed or rejected, 6 inconclusive.

**Verification:** `tsc -b` and `typecheck:lab` clean; 987 tests in 67 files at
default timeouts (16 new).

### Iteration 7 — 2026-11-14 · the cache guard fix ships; browsing agents

Harry: "as long as it does not affect quality then do it"; look at
vercel-labs/agent-browser and "see if we can do it better"; "make sure we ship
this to live code".

**1. Product change — the cache guard decides each breakpoint separately.**
`packages/sdk-js/src/cache-volatility-guard.ts`, `reduce-request.ts`.
- The guard now compares the content the system breakpoint would actually cover
  (after Mesh's levers), supplied by the reducer, instead of the client's raw
  `{tools, system}`. A clock that prefix repair has moved behind the breakpoint
  is no longer churn.
- A history that does not extend withholds only the breakpoint on the newest
  message. The tools + system breakpoint stays: it sits before the history.
- Each track recovers after two consecutive stable turns, as before.
- Quality: placement only. A test asserts that, with the markers removed, the
  guarded request equals the unguarded one on every turn of both live shapes.
  Money: a span that really changes is still suppressed (tested); nothing is
  stamped that the existing first-turn rule would not already stamp.
- The guard as it shipped for the live run is frozen in
  `lab/experiments/legacy-guard.ts` so the replica still reproduces the spool
  (stamp, stamp, –, –, –). Under the product guard the same replica is stamped
  on all five turns: **SIMULATOR −53.4% input** on the replica;
  **DERIVED-FROM-LIVE 20.7% of the live coding agent's bill, 6.1% of the
  $0.20103 basket** — a counterfactual, not a re-run. LIVE stays 18.2%.
- Not covered: the live support chat (never stamped) carries no cache flag, so
  this fix does not reach it. Its 29.1%–36.9% needs the flag from the caller or
  a Theo policy (`cache-ttl-5m` is already a policy lever).
- Reaches users only when this branch is merged and a release is cut; the
  release branch (`theo/autonomous-agent`) does not have it yet.

**2. agent-browser — what it does, and what Mesh can do that it cannot.**
agent-browser (Rust CLI over CDP) returns a page as a compact accessibility
snapshot with an element ref per line; `snapshot -i` keeps interactive elements
only. Its site claims ~200–400 tokens against ~3,000–5,000 for a full DOM, with
no method given. That cuts the cost of EACH snapshot, at the source, and needs
the customer to swap their browser tool. It leaves every earlier snapshot in
the transcript, re-sent on every later turn — the quadratic part.

`lab/browsing-shape.ts` (+ `pnpm lab:browse`) is a synthetic 6/12/24-snapshot
shop checkout priced with explicit breakpoints. **SIMULATOR, synthetic; sizes,
script and length are ESTIMATES; no grader.** Whole bill:

| Arm (12 snapshots) | vs no Mesh | vs Mesh today | Page text readable | Customer change |
|---|---|---|---|---|
| Mesh defaults (no cache flag) | 0.0% | — | 79/79 | no |
| Mesh today (lossless + cache flag) | 73.5% | 0.0% | 79/79 | no |
| Interactive-only at the source (agent-browser idea) | 80.4% | 26.3% | 0/79 | yes |
| Mesh: stale-snapshot line dedup | 76.8% | 12.7% | 79/79 | no |
| Mesh: stale snapshots superseded | 81.8% | 31.6% | 7/79 | no |
| Source-side + Mesh supersession | 85.5% | 45.4% | 0/79 | yes |

- Old snapshots being re-sent are 64.8% of the raw input bill at 12 snapshots
  (48.0% at 6, 76.2% at 24). The Mesh arms grow with session length: line dedup
  3.3% / 12.7% / 22.6%, supersession 21.4% / 31.6% / 44.6% at 6 / 12 / 24.
- Out of the box Mesh saves nothing on this shape. The cache flag is what pays.
- `lab/experiments/page-snapshots.ts` (lab-local): line dedup drops from each
  older snapshot only the lines the next one repeats, with dead refs masked so
  tools that renumber refs do not defeat it — every element and text line is
  kept at its last occurrence (tested). Supersession replaces older snapshots
  with a stub. Both move the breakpoint to just before the fresh snapshot;
  with the breakpoint ON it, every write is spoiled one turn later (tested).
- Both change what the model reads → both rest at `needs_gate`, quality
  unmeasured. The two ideas are complementary, not rivals.
- Warning arm: the generic fresh tool-result cap truncates all 12 fresh pages.

**Verification:** full suite green, `tsc -b` and `typecheck:lab` clean (counts
in the commit message).

### Iteration 6 — 2026-11-12 · what the LIVE run still leaves on the table (agents)

Asked: find more ways to cut token usage on agentic workflows. Instead of
another fixture, this reads the LIVE spools (`evals/live-exports-2026-10-26/`,
the run behind the 18.2% in `docs/NUMBERS.md`) — content-blind: token counts,
lever ids, dollars.

**Built**
- `lab/live-study.ts` (+ `pnpm lab:live`): `liveResidual()`, `guardStudy()`,
  `stampStudy()`, and a span pricing model for replicas.
- `lab/live-shapes.ts`: constant-for-constant replicas of the live coding agent
  and support chat (the script itself cannot be imported — importing runs it).
  A test checks the replicas still match the script.
- `lab/experiments/span-keyed-stamp.ts` (lab-local, NOT in the product).

**Finding 1 — LIVE: output is most of what is left.** After Mesh, output is
**57.7%** of the remaining live bill (coding agent 62.5%); fresh uncached input
is 39.2%; cache reads + writes together 3.0%. The lab has no measured lever for
output. That is now the largest open item, with a LIVE basis.

**Finding 2 — the cache guard suppresses breakpoints that would still read.**
The live coding agent's spool: stamped, stamped, then `cache-ttl-suppressed` on
turns 3–5. Turn 2 read 2,267 cached tokens, so the repaired prefix is provably
stable; turns 3–5 then paid full price for that same prefix. The replica
reproduces this pattern exactly under the product guard. Two causes, each
pinned by its own test:
1. The guard hashes the RAW `{tools, system}`, so a per-turn clock reads as
   churn even after `repairCachePrefix` has moved it out of the stamped span.
2. It is all-or-nothing: a history that does not extend also suppresses the
   tools + system breakpoint, which sits before the history and still reads.

The existing product test that shows the repaired placement "earns" calls the
reducer without the guard; the proxy installs the guard automatically. No
branch (`main`, `integration/trunk`, `theo/autonomous-agent`) changes this.

**Finding 3 — a reusable prefix that was never stamped.** The live support chat
shipped the same tools + system on all six requests and carried no stamp
(`cacheTtl` is a per-workload caller flag); every request was billed fresh.

**Experiment — span-keyed stamping.** Key the system breakpoint on the exact
span Mesh would stamp (tools + stamped system blocks, after Mesh's deterministic
levers): stamp once that span has been seen before; keep the message breakpoint
only when the raw history extends. Lossless — it emits only bytes the product
already emits, stamped or unstamped (tested).

| Agent | Basis | Stamp once the span repeats | Stamp at first sight (known route) |
|---|---|---|---|
| Coding agent replica, input cost | SIMULATOR | −35.6% | −53.4% |
| Coding agent, share of live bill | DERIVED-FROM-LIVE | 13.8% ($0.00816) | 20.7% ($0.01224) |
| Support chat replica, input cost | SIMULATOR | −54.3% | −69.1% |
| Support chat, share of live bill | DERIVED-FROM-LIVE | 29.1% ($0.01519) | 36.9% ($0.01927) |
| Both, share of the $0.20103 live basket | DERIVED-FROM-LIVE | 11.6% | 15.7% |

**Qualification.**
- DERIVED-FROM-LIVE is counterfactual arithmetic on verbatim provider usage with
  the documented multipliers (write 1.25×, read 0.1×). It is **not** a re-run:
  no request was sent. It is not LIVE and does not change the 18.2%.
- The live basket is 30 requests; the "agents" in it are scripted. The coding
  agent's history is rebuilt each turn by the script, which is one of the two
  triggers. Real agents that window or summarise their history hit the same
  path; how common that is on customer traffic is unknown.
- "Stamp once the span repeats" never pays a write premium on a prefix that does
  not repeat (tested: cost equals uncached). "At first sight" does lose on
  non-repeating prefixes (tested), so it needs a route already known to repeat.
- The support-chat figure uses the 2,267-token prefix the provider actually
  cached in the coding run (same tools + system), not the replica's estimate.

**Pipeline.** New lead `span-keyed-cache-stamping` → promoted as lossless, with
basis recorded and a Red Team note that the saving is a counterfactual.

**Verification:** 584 tests green (10 new), `typecheck:lab` clean.

### Iteration 5 — 14:36 → 21:00 · harness evidence in the pipeline; `needs_gate`

**Built**
- `lab/evidence.ts`: the one place a lead's techniqueKey maps to the harness
  measurement behind it (paying-shape rung, cadence sweep, wire capture), each
  with its basis and grader.
- New terminal status **`needs_gate`**: a LOSSY lever whose saving is measured
  but whose quality was judged only by a simulated grader (or not at all). It is
  worth pursuing and is never promoted from this harness.
- Builder binds a lead to its harness; Red Team attacks the evidence (simulated
  grader, synthetic inputs, a bill that goes up); Evaluation applies the same
  gates (≥3 saving, ≤2% quality drop); Maintainer promotes only lossless levers.
- Two new leads so the ledger remembers them: fresh tool-result cap, and the
  output-token cap (recorded as a failure so it is not re-investigated blind).

**Pipeline verdicts on harness evidence (SIMULATOR)**

| Lead | Evidence | Verdict |
|---|---|---|
| Cadence-aware cache TTL | 22.2% at 8-minute turn gaps in the pipeline's 4-task evidence run (27.0% in the 10-task sweep), where a 5m stamp loses money; lossless | **PROMOTED** |
| Fresh tool-result cap | +9.9 pt on the paying shape, 40/40 simulated | **NEEDS GATE** |
| Block-array prefix repair | 74.8% of one captured volatile session; quality unmeasured | **NEEDS GATE** |
| Output-token cap | +5.9 pt but −5.0 pp quality | FAILED (quality) |
| Tool-description truncation | +0.4 pt | FAILED (not meaningful) |
| Stale tool-result (history) compaction | +0.0 pt on top of the fresh cap | FAILED (subsumed) |
| Reasoning-effort / output-conciseness governors | no harness, needs a real model | INCONCLUSIVE |

**Qualification.** "+N pt" is points of whole-bill saving a lever adds on top
of the rung below it on the repo agent fixture; it is not a fleet number. The
cadence figure rests on a synthetic gap. `needs_gate` items need a real replay
gate on real traffic — that needs a provider key and Harry's go-ahead, so it
was not attempted. (Correction: commit `aeaf811`'s message quotes 27.0% for the
promoted TTL lever; the pipeline's own evidence run reads 22.2%.)

**Verification:** 574 tests green (6 new), `typecheck:lab` clean (run under
`caffeinate`, wall-clock timeouts raised).

### Close of the 24-hour run — 21:30 GMT, 2026-11-11

Five iterations landed in the 24 hours; the host slept for roughly half of it.
Final `pnpm lab:status` on a fresh ledger (28 leads, 240-event audit trail intact):

- **LIVE 18.2%** (docs/NUMBERS.md) — unchanged; the lab ran no live traffic.
- **Floor 0.1%** on real wire captures with lossless levers (SIMULATOR).
- **Paying shape 39.6% lossless / 51.4% inside the 2% ceiling** (SIMULATOR).
- **Modelled mix 38.2%** (constructed fixtures × ESTIMATE weights) — known to
  be miscalibrated against LIVE (RAG 54.8% modelled vs 22.0% LIVE).
- 15 promoted (all lossless), 2 awaiting a real gate, 5 failed/rejected, 6 inconclusive.

Nothing was pushed, `docs/NUMBERS.md` was not edited, and no paid API call was made.

### Iteration 4 — 03:02 → 13:00 · session-length and cadence × TTL sweeps

(Wall-clock stretched because the host machine kept sleeping; see "Environment".)

**Built** `lab/sweeps.ts` (+ `pnpm lab:sweep [--tasks n] [--full]`) on a
generalised `runPayingShapeArm` (turns, tasks, task spacing, turn gap, 5m/1h
TTL). Default arguments are byte-for-byte the previous run, so the
`docs/NUMBERS.md` cross-check still pins it.

**Measured (SIMULATOR; repo agent fixture; 10 tasks; whole bill)**

Session length — savings compound as history grows, all at 10/10 clean:

| Turns | Lossless | + fresh tool-result cap | + history compaction |
|---|---|---|---|
| 5 | 31.4% | 46.4% | 46.4% |
| 12 | 49.4% | 61.4% | 61.4% |
| 20 | 59.4% | 70.4% | 70.4% |

Turn cadence × cache TTL (lossless stack, 5 turns; gaps are synthetic ESTIMATES):

| Gap between turns | 5m TTL | 1h TTL | Better |
|---|---|---|---|
| 3s | 31.4% (hits 71%) | 27.0% | 5m |
| 2m | 31.4% (hits 71%) | 27.0% | 5m |
| 8m | **−12.3%** (hits 0%) | 27.0% (hits 71%) | 1h |
| 45m | **−12.3%** (hits 0%) | 27.0% (hits 71%) | 1h |

**Findings**
- **A 5-minute stamp on a slow conversation makes the bill worse.** Once turns
  are more than 5 minutes apart every write expires unread: −12.3%, where the
  1-hour TTL saves 27.0%. Picking the TTL from observed inter-arrival gaps (a
  blind feature) is worth ~39 points on slow traffic. This makes the
  cadence-aware TTL lead (lever-backlog P2) measurable for the first time here.
- **History compaction is subsumed by the fresh tool-result cap.** Isolated at
  12 turns: compaction alone +2.2 pt (and it costs cache hits, 87% → 75%); the
  cap alone +7.8 pt; both together = the cap alone. With the cap on at
  injection, nothing stale and oversized is left to compact.
- **Longer sessions pay more.** Lossless alone goes 31% → 59% from 5 to 20
  turns. The 5-turn fixture understates long-running agents.

**Qualification / caveats.** Simulated grader; synthetic gaps; the fixture's
tool results are uniform ~2.5 KB, so the cap-vs-compaction result may differ on
traffic with a few very large and many small results. The stamping count now
ignores `cache-ttl-suppressed` records (a withheld stamp is not a stamp).

**Environment.** The host slept repeatedly (wakeups hours late, load average
58 on wake). A vitest run that spans a sleep reports wall-clock "timeouts" in
unrelated tests. Verification runs are therefore made under `caffeinate -i`
with a raised test timeout; no test logic depends on wall-clock.

### Iteration 3 — 23:45 · paying-shape tier, quality gate, and the LIVE anchor

**Found** `docs/NUMBERS.md` is the source of truth: one LIVE number (18.2% on a
mixed 30-request basket; coding 38.1%, RAG 22.0%, support 10.3%, batch 0%,
lean 0%), everything else SIMULATOR, and "0–5%" as the documented
do-not-pay-us band — which is where the wire-capture floor (0.06%) sits.

**Built**
- `lab/paying-shape.ts`: drives the repo's shared agent fixture (uncached
  Claude agent, 40 tasks × 5 turns) through `reduceRequest` + `simulateCache`,
  adding one lever per rung, graded by the fixture's simulated model and judged
  against the lab's 2% quality ceiling. Ladder runs are memoised per spacing.
- `lab/numbers.ts`: reads the LIVE headline and per-agent figures out of
  `docs/NUMBERS.md` at runtime (linked, never copied; never invents a number).
- `lab:status` now leads with LIVE, then labels every lab figure SIMULATOR /
  experimental / not for external quoting, and shows LIVE beside modelled where
  the doc has a per-agent figure.

**Measured (SIMULATOR; whole bill, input + output; 30s task spacing)**

| Arm | Saving | Clean | vs 2% ceiling |
|---|---|---|---|
| Lossless only (schema + dedup + 5m stamp) | 39.6% | 40/40 | PASS |
| + cache-prefix repair | 41.1% | 40/40 | PASS* |
| + description truncation (40 tok) | 41.5% | 40/40 | PASS* |
| + fresh tool-result cap | **51.4%** | 40/40 | PASS* |
| + history compaction | 51.4% | 40/40 | PASS* (adds nothing here) |
| + output cap 2,000 (full stack) | 57.3% | 38/40 | **FAIL (−5.0pp)** |

- **Harness cross-check:** full stack 57.3% and cache contribution 37.9% match
  the SIMULATOR rows in `docs/NUMBERS.md` to one decimal; pinned by a test.
- **Ceiling-breaker: the output cap.** It buys 5.9 points for 2 failed tasks in
  40. The best stack inside the ceiling is the full stack *minus* the cap:
  51.4% at 40/40. This independently reproduces the lever-backlog verdict that
  max-token right-sizing only saves by truncating.
- **History compaction adds nothing on 5-turn sessions** → queue 3b.

**Qualification / caveats.**
- \* "PASS" on a lossy rung is only as good as the simulated grader. It does not
  model sensitivity to where a date anchor sits (prefix repair), and the
  fixture's discriminating phrase survives a 40-token description cut. These
  rungs still need the real replay gate before any saving is billed.
- Calibration against LIVE: the constructed RAG fixture (54.8%) overstates real
  traffic (LIVE 22.0%) by 2.5×; coding is modelled at 30.9% vs LIVE 38.1%.
  The modelled mix is therefore renamed from "upper bound" to "modelled mix" —
  it is neither a bound nor a measurement → queue 3c.
- None of the lab's figures are in `docs/NUMBERS.md`; that file is Harry's to
  update. Flag for the final report.

**Verification:** 566 tests green (7 new), `typecheck:lab` clean.

### Iteration 2 — 22:42 · block-array prefix repair, measured on the capture

**Built** `lab/experiments/block-array-repair.ts` (lab-local, NOT in the product):
relocates volatile lines (timestamps, UUIDs) out of each block-array `system`
text block into one trailing unstamped block, so the stamped block stays
byte-identical across turns. Every line survives verbatim; only position
changes. No-op on a string system, on a system with nothing volatile, and on a
block that would be left empty; idempotent. Added as a fourth capture arm
(`blockRepair`) alongside a `GATE_REQUIRED_ARMS` list.

**Measured (SIMULATOR, derived-from-captures).** Volatile LiteLLM session input
cost $0.1615 → $0.0406, **74.8% saved**, landing within 7% of what the stable
session already pays. Stable and framework sessions: unchanged. Cost-weighted
across all six capture sessions: 55.8% — but that figure is carried by one
session and must not be read as a fleet number.

**Qualification / caveats.**
- GATE-REQUIRED: it moves a date anchor from the top of the prompt to the end of
  the system section. Cost effect is measured; quality effect is not. It stays
  out of the lossless floor (still 0.06%) and cannot be promoted from this harness.
- The simulator matches by character prefix and bills the post-hit remainder as
  fresh rather than as a 1.25× write; on this session that under-costs the
  repaired arm by roughly the message tail (hundreds of tokens against ~7,000).
- `lab:status` now labels every figure SIMULATOR (none is LIVE), per the
  standing decision of 2026-10-28, and prints floor / gated / upper bound.

**Verification:** 559 tests green (4 new), `typecheck:lab` clean.

### Iteration 1 — 21:38 · qualification on real wire captures

**Built** `lab/captures.ts`: replays the Mesh-owned framework wire captures
(LangChain, OpenAI SDK, Agents SDK, Anthropic SDK, LiteLLM) through the
product's own `reduceRequest` and `simulateCache`, net of the customer's own
caching (Anthropic stamps already present; OpenAI automatic caching).

**Finding (basis: derived-from-captures) — the headline needed correcting.**
Lossless levers save **0.06%** cost-weighted on the real captures. The framework
requests are 300–700 tokens (below the 1,024-token cache minimum, no duplicate
blocks; only the Agents SDK tool schema yields 2.5%), and the LiteLLM customer
already stamps its own cache. The 38.2% modelled number comes from fixtures I
constructed with redundancy in them, so it is an UPPER BOUND for uncached,
redundancy-heavy traffic — not a real-traffic measurement. `lab:status` now
prints both: upper bound (constructed fixtures) and floor (real captures).

**Opportunity found in the same data.** The LiteLLM "volatile" session (a clock
at the head of a block-array system prompt) costs **4.2× the stable one — 76.4%
of its input bill** — because every turn pays the 1.25× write premium and never
reads. Mesh's prefix repair only handles a string `system`. Recorded as a lead
(`block-array-prefix-repair`, gate-required) and promoted to queue item 1.

**Verification:** 555 tests green, `typecheck:lab` clean.

## 2026-11-09 — Initial build (end-to-end operational)

**Decision: top-level `lab/`, not `packages/lab`.** The Lab is internal R&D
tooling (parallel to `evals/`, `scripts/`, `floorplan/`), not shipped to
customers. It runs via `tsx` like `evals/` and imports core with `../packages/
core/src/*.js` (NodeNext ESM, matching the repo).

**Decision: agents are deterministic modules operating REAL primitives, with an
LLM seam left open.** The mission says "prefer working software over mock
architecture." Each agent is a narrow function over the ledger; the reduction is
measured by the real core reducers and the real replay gate, so the pipeline is
fully operational and testable today. Swapping a rule-based Scout/Design for an
LLM-backed one later is additive (same structured inputs/outputs).

**Decision: permissions enforced by the ledger, not convention.** `advance()`
derives the required capability from the record's current status, so only the
responsible role can move a record. The Builder holds neither `record:promote`
nor `record:evaluate` — the two load-bearing separations are structural.

**Decision: hash-chained event log reusing the savings-ledger construction.**
`sha256(seq, prevHash, canonicalEvent)`. Bug found and fixed during the first
demo run: the canonicalizer emitted `undefined`-valued keys as `null` while
`JSON.stringify` drops them on write, so re-hashing on read failed; the
canonicalizer now skips `undefined` keys. `pnpm lab:verify` is green.

**Decision: quality gates use two thresholds.** The 2% ceiling maps to the
replay gate's `maximumAccuracyDrop` (the real guarantee); a separate
`minimumCandidateAccuracy` (0.7 default) is the Wilson lower-bound sanity floor,
which small sample sizes cannot otherwise clear even at 100% accuracy.

**Files:** `types.ts`, `constraints.ts`, `permissions.ts`, `registry.ts`,
`fixtures.ts`, `catalog.ts`, `ledger.ts`, `orchestrator.ts`, `cli.ts`,
`index.ts`, `agents/{scout,research,design,builder,red-team,evaluation,maintainer}.ts`,
`lab.test.ts`, `README.md`.

**Wiring:** `vitest.config.ts` includes `lab/**/*.test.ts`; `package.json` gains
`lab:demo|run|status|verify` and `typecheck:lab`; `.gitignore` excludes the
runtime `lab/ledger/`.

**Verification:** `pnpm lab:demo` runs a full workflow — Scout discovers 6 leads;
dedup promotes at a measured **54.8%** token reduction with **0%** quality drop;
a cache-TTL spec-only lead evaluates INCONCLUSIVE; the prompt-rewrite idea is
rejected at Research on the content-blind / no-customer-app constraints; the
48-event audit trail verifies intact. Lab suite: 18/18 green; full repo suite:
542/542 green; `typecheck:lab` clean.

**Known next steps (not blocking the Definition of Done):**
- LLM-backed Scout discovery and Design drafting behind the existing seam.
- Real runnable implementations for the spec-only leads (cache-TTL needs
  timestamped captures; stale-tool needs a fat-tool-result capture) — both
  currently and correctly INCONCLUSIVE for want of data.
- A trajectory-level evaluator for output-side levers (per lever-backlog P4).
