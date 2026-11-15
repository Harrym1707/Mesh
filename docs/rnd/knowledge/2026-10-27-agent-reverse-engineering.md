# Agent request-path reverse-engineering — token economics (2026-10-27, day shift)

**Shift marker.** This is **day-shift output for the 2026-10-27 dispatch (Mission A)**. It
consolidates the eight agents read today (Cline, OpenHands, Aider, SWE-agent,
gpt-researcher, CrewAI, LangGraph, AutoGen) after an adversarial review. The
nightly shift should **extend, not redo**: OpenAI Agents SDK and Claude Agent SDK
examples are still unread (dispatch list), and several items below are marked
UNKNOWN pending a line-level or wire-capture pass — pick those up rather than
re-reading what is already cited here.

**Single pricing anchor (applies to every figure below).** Source:
`https://claude.com/pricing`, checked **2026-10-27**. The page lists Sonnet 5.5,
Opus 5, Haiku, Fable, and legacy 4.6/4.7/4.8. It does **not** list "Sonnet 4.5" or
"Opus 4.5". All arithmetic therefore uses **Claude Sonnet 5.5: input $2.00/MTok,
output $10.00/MTok, cache-read $0.10/MTok, 5-min cache-write $2.50/MTok** (Opus 5
reference: $4 / $20 / $0.20 / $5.00). This replaces the drafts' uncitable
"Sonnet 4.5 @ $3" anchor (review D1/D2 FATAL) and the mislabelled "Opus 4.5"
(D3). Every per-task number is an **estimate** unless tied to a provider-reported
usage capture; agents are model-agnostic and Sonnet 5.5 is the worked example.

**Honesty frame (project rule).** Savings are measured per completed task, from
provider-reported usage, with the customer's pre-existing savings excluded and
credited to them. A lever that an agent already implements in its own code is
**ALREADY-DONE** and may not be billed. The dangerous error is marking a lever
APPLIES when the agent already does it; the drafts lean conservative and avoid
this everywhere except one borderline case, now corrected (Cline retry, D6).

---

## Cline

Repo `github.com/cline/cline`, sha `775d0398039977ca5447ed39c1a7f178df69aa87`
(`main`, read 2026-10-27). Monorepo: agent loop `sdk/packages/agents`, tool/context
`sdk/packages/core`, provider transport `sdk/packages/llms`.

**Context assembly.** Full-history resend every turn. The whole transcript lives
in `state.messages`; each iteration rebuilds the request from a clone:
`systemPrompt: this.config.systemPrompt, messages: cloneMessages(this.state.messages)`
(`sdk/packages/agents/src/agent-runtime.ts:1676-1677`, again `:2258-2260`). No
per-turn truncation. Each turn appends the assistant `tool_use` blocks and a
following user message with `tool_result` blocks (capped, see below).
Summarisation — not sliding truncation — fires at 90% of usable input budget:
`COMPACTION_TRIGGER_RATIO = 0.9` (`sdk/packages/core/src/extensions/context/compaction-shared.ts:19`),
evaluated `requestInputTokens >= requestTriggerTokens` (`compaction.ts:370`).
Usable budget = reported `maxInputTokens` else `contextWindow * 0.9`
(`CONTEXT_WINDOW_INPUT_RATIO = 0.9`, `compaction-shared.ts:17,65-84`). On trigger,
LLM-summarise older turns to a 0.7 target (`DEFAULT_TARGET_RATIO = 0.7`, `:28`)
preserving the most recent 20,000 tokens verbatim
(`DEFAULT_PRESERVE_RECENT_TOKENS = 20_000`, `:29`; `findCutIndex` `:368-401`).
Token sizing is char-based at 3 chars/token (`CHARS_PER_TOKEN = 3`,
`sdk/packages/shared/src/llms/tokens.ts:8`), deliberately over-counting so the
trigger fires early.

**Tool schemas.** Rebuilt and sent every request, generated from Zod via
`z.toJSONSchema` (`sdk/packages/shared/src/parse/zod.ts:21-23`, zod `^4.3.6`).
Serialized Anthropic wire shape `{name, description, input_schema}`, byte counts
(reviewer reconstruction, "regenerated the exact JSON with zod 4" — not a cited
artifact):

| tool | total B | desc B | schema B |
|---|---|---|---|
| read_files | 2223 | 635 | 1534 |
| search_codebase | 754 | 444 | 251 |
| run_commands | 1469 | 994 | 419 |
| fetch_web_content | 881 | 337 | 483 |
| editor | 2144 | 551 | 1543 |
| skills | 916 | 528 | 322 |
| ask_question | 911 | 401 | 454 |
| apply_patch | 1928 | 1224 | 607 |
| submit_and_exit | 2657 | 788 | 1810 |

Default `act` preset (`sdk/packages/core/src/extensions/tools/presets.ts:24-36`)
enables 7 builtins (apply_patch, submit_and_exit OFF) = **9,298 bytes**. Token
figure carries an **assumed bytes/token divisor** (review D8): at ~3.7 B/tok that
is ~2,513 tok; call it **~2,300–3,100 tok/request (estimate, divisor assumed, not
tokenizer-measured)**. Full 9-tool superset ≈ 13.9 KB. spawn_agent/agent-team and
MCP tools append dynamically (**UNKNOWN** additional bytes — user config).

**Caching behaviour.** Implemented. `cache_control: { type: "ephemeral" }`
(`sdk/packages/llms/src/providers/routing/utils.ts:12-16`), gated
`anthropic-compatible.ts:179-194,273-293`, applied `ai-sdk.ts:416-439`. One rolling
breakpoint on the last `role:"user"` message (`ai-sdk.ts:425-438`,
`applyPromptCacheToLastTextPart` `anthropic-compatible.ts:114-177`), which caches
the entire prefix (system + tools + prior messages); each turn reads the prior
prefix at 0.1x and writes the delta at 1.25x. Only 1 of Anthropic's 4 breakpoints
used; a second static breakpoint would not lower cost (tail breakpoint already
covers tools+system). **Prefix is volatility-clean:** the only dynamic system
field is `{{CURRENT_DATE}}` = `new Date().toLocaleDateString()`
(`sdk/packages/shared/src/prompt/cline.ts:203`) — date-only, daily granularity,
stable within a day; `run_commands` is explicitly built "without probing a version
or adding volatile prompt text" (`definitions.ts:437-440`); reminder/hook messages
are appended as immutable tail messages (`agent-runtime.ts:774-789`), never mutated
into the cached prefix. No per-turn timestamp/counter in the cached region.

**Retries.** Empty-response middleware resends the byte-identical request on an
empty turn or a transient pre-output stream death; its own header documents the
re-bill: "a turn that took three requests reports three requests' worth of usage"
(`sdk/packages/llms/src/providers/middleware/retry-empty-response.ts:24-50`),
default up to 3 attempts (`:97`). Tool-call-only, non-empty, token-limit, and
post-output failures are not retried (`:52-67`). The AI SDK's own request-start
retry `maxRetries: 3` (`MODEL_REQUEST_MAX_RETRIES = 3`, `ai-sdk.ts:1096`, wired
`:2446`) guards pre-stream failures (typically un-billed 4xx/5xx); budgets "do not
multiply" (`ai-sdk.ts:1087-1095`).

**Output shape.** Diff/patch, never whole-file reprint. `editor` replaces
`old_text`→`new_text` or inserts at `insert_line` (`schemas.ts:198-233`,
`definitions.ts:719-...`); `apply_patch` uses a context-based unified-diff grammar,
"Do not use line numbers; this format is context-based"
(`definitions.ts` APPLY_PATCH_TOOL_DESC ~`:618-665`). Routing: OpenAI/Codex/GPT get
`apply_patch`, everyone else (incl. Claude) gets `editor`
(`model-tool-routing.ts:59-73`). Output already diff-shaped.

### MESH lever map — Cline
| lever | verdict | arithmetic / reason |
|---|---|---|
| Tool-schema compaction | **APPLIES on cache-miss/cold turns ONLY** | On warm turns the schemas sit at the **front** of the cached prefix; editing them invalidates the entire downstream prefix, forcing a 1.25x re-write of system+tools+history — so a warm-turn trim is net-negative, not a saving (review D4, consistent with OpenHands reasoning). Addressable surface = cold/cache-miss turns: a 30% trim (~750 tok) saves `750 × $2/MTok ≈ $0.0015` on that cold turn; the turn-1 cache-write saves `750 × $2.50/MTok ≈ $0.00188` once. The drafts' "$0.011 over a 50-turn session @ cache-read" warm figure is withdrawn. |
| Exact duplicate-context dedup | **N/A — neutralised by caching** | Full transcript resent verbatim but the duplicated prefix already bills at cache-read 0.1x; dedup would only recover value on cache-miss turns and editing the prefix forces a 1.25x re-write downstream. Exclude. |
| Cache placement + volatility guard | **ALREADY-DONE — exclude** | Rolling ephemeral breakpoint (`ai-sdk.ts:425-438`); prefix carries no per-turn volatility. Residual ~0 (at most one daily-date cache roll). |
| Fresh-tool-result cap | **ALREADY-DONE — exclude** | Generation-time caps: read/run/search 48,000 chars (`output-limits.ts:18,47,50`; `MAX_READ_LINES = 2000` `:41`) ≈ ~16k tok each; compaction truncates stale results to 2,000 chars (`TOOL_RESULT_CHAR_LIMIT`, `compaction-shared.ts:35,132-156`). MESH could only add value by capping below 48k on the live turn, which deletes context the agent chose to keep. |
| Byte-identical retry metering | **N/A / visibility only** (downgraded, review D6) | Cline already aggregates and reports the re-billed attempts in `finish.usage` (`retry-empty-response.ts:24-50`). Metering what the agent already surfaces adds no user-verifiable new value, so this is not a billable lever here. |
| Output re-emission metering | **N/A** | Diff/patch output (above); no whole-file reprint, output not cacheable. |

---

## OpenHands

**Repo-location note (surprising but confirmed by review).**
`github.com/All-Hands-AI/OpenHands` now 302-redirects to
`github.com/OpenHands/OpenHands`, which is a TypeScript/Electron desktop app
(`package.json` name `@openhands/agent-canvas`) with **no Python request
construction**. The autonomous agent (V1) lives in
`github.com/OpenHands/software-agent-sdk`, HEAD `main`
**`d0d9d81324210414462fb676b377e0563a08a0cb`** (read 2026-10-26). All cites below
are that sha. **Line-cite caveat (review D13):** the sha and directory structure
are verified, but the individual `agent.py` / `llm_summarizing_condenser.py` line
numbers below were **not** line-verified in review and need a line-level pass
before any figure ships; in particular the `effective_max_tokens = min(...)`
paraphrase is suspect (`min(None, int)` would raise in Python, so the real code
must guard None — the condenser-trigger description is likely imprecise).

**Context assembly.** Full-history resend, cached, condensed past a threshold.
Each step builds messages from the entire view: `prepare_llm_messages()` converts
every event (`openhands-sdk/openhands/sdk/agent/utils.py:610-633`), called with the
running view (`agent/agent.py:746-748`) and passed to `self.llm.generate(...)`
(`agent/agent.py:786-793`). Default condenser on: `LLMSummarizingCondenser` via
`default_condenser(llm)` (`openhands-tools/openhands/tools/preset/default.py:71-73,103-104`),
`max_size=80` events, `keep_first=4`
(`openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py:558-565`).
Triggers (`get_condensation_reasons`, `:140-174`): token-based (total > the model's
full input window) and size-based (> 80 events); on fire it makes a separate
summarization LLM call and rebuilds as keep_first + summary + recent suffix
(target 40 events, `:293-312`). Between condensations the full prefix resends every
turn; no mid-range truncation.

**Tool schemas.** Default agent (browser off): `terminal`, `file_editor`,
`task_tracker` (`openhands-sdk/openhands/sdk/tool/defaults.py:27-31`) + `switch_llm`
(`:40-41`) + builtins `finish`, `think` ≈ 6 tools, each with an injected
`security_risk` enum param (`agent/agent.py:594-596`, `:790`). Sent every request
(`tools=list(self.tools_map.values())`, `agent/agent.py:788`, async `:1000`).
**Byte size ESTIMATE / UNKNOWN exact** (pydantic→OpenAI schema not serialized):
descriptions read directly — terminal `UNIX_TOOL_DESCRIPTION` ≈ 1.7 KB
(`openhands-tools/openhands/tools/terminal/descriptions.py:3-46`), file_editor ≈ 3 KB,
task_tracker largest (458 lines) — full block estimated **≈ 10–16 KB ≈
2,500–4,000 tok/request (divisor assumed)**. Native tool calling default
(`llm/llm.py:547-548`); non-native inlines via `mixins/fn_call_converter.py`, still
in the cached prefix.

**Caching behaviour.** Implemented with a deliberate volatility split.
`_apply_prompt_caching()` (`llm/llm.py:2998-3026`): system block 0 (static) →
`cache_control: ephemeral` (`:3012,3016`); the dynamic block (index 1) explicitly
`cache_prompt=False` (`:3013`) "to enable cross-conversation cache sharing"
(`:3002-3004`, `agent/agent.py:581-600`); a second rolling breakpoint on the last
user/tool message (`:3021-3026`). Content-block `cache_control` is
`{"type":"ephemeral"}` (`llm/message.py:203-204,217-218,395`), applied every
completion when active (`llm/llm.py:3044-3047`), gated by
`is_caching_prompt_active()` (`:2847`); min-size fallback retries with caching off
(`:1839-1848`). **Prefix does not churn:** the volatile datetime lives in the
unmarked dynamic block (`prompts/sections/dynamic.py:28-43`, `DateTimeSection` →
`cache_tier = DYNAMIC`) and the `SystemPromptEvent` carrying it is built once at
`init_state` and persisted (`agent/agent.py:589-601`), so within a conversation it
is frozen at start; cwd/repo/skills/secrets resolved once. Cached prefix is
byte-stable across turns.

**Retries.** `RetryMixin.retry_decorator` (tenacity) default `num_retries=5`,
exp 8→64 s (`openhands-sdk/openhands/sdk/llm/utils/retry_mixin.py:77-94`). On a
retryable exception it re-invokes the same completion with the same messages/tools
→ byte-identical (modulo the caching-off fallback). **Billed twice? UNKNOWN /
conditional** — retries fire on rate-limit/timeout/connection/5xx classes, most of
which fail before the model meters tokens; a 5xx after partial processing *can*
bill. OpenHands does not dedupe or meter. Per the honesty rule this is UNKNOWN, not
asserted waste.

**Output shape.** Diffs, not whole-file reprints. `file_editor` commands
`view | create | str_replace | insert | undo_edit`
(`openhands-tools/openhands/tools/file_editor/definition.py:26`); `str_replace`
sends only `old_str`+`new_str`, `insert` one hunk, only `create` emits a whole file
once for a new file (`:39-57`); GPT-5 preset uses diff-based `apply_patch`.
Observations capped at creation: terminal `MAX_CMD_OUTPUT_SIZE = 30000` chars
(`terminal/constants.py:17`), file_editor `MAX_RESPONSE_LEN_CHAR = 16000`
(`file_editor/utils/config.py:1`).

### MESH lever map — OpenHands
| lever | verdict | arithmetic / reason |
|---|---|---|
| Cache placement + volatility guard | **ALREADY-DONE — exclude** | Static/dynamic split, frozen datetime, rolling 2nd breakpoint (`llm/llm.py:2998-3026`, `agent/agent.py:581-601`, `dynamic.py:28-43`). This *is* the lever, in code. |
| Fresh-tool-result cap | **ALREADY-DONE — exclude** | 30,000 / 16,000-char caps. Capping lower changes agent behaviour, not a free saving. |
| Output re-emission metering | **N/A (≈already-done)** | `str_replace`/`insert` diffs; only `create` emits a full file once. No reprint loop. |
| Exact duplicate-context dedup | **N/A — net-negative under cache** | Full history resent (`agent/utils.py:610-627`) but cached (2nd breakpoint); a duplicated token costs $0.10/MTok (read), and editing the prefix invalidates everything downstream forcing a 1.25x re-write. For any token read ≥1 more time, dedup loses money. Exclude. |
| Tool-schema compaction | **APPLIES on cache-miss/cold turns, small** | Cold request: ~3,000 tok × $2/MTok = $0.006; halving ≈ $0.003 that turn. Warm: schema is in the cached prefix at $0.10/MTok and editing busts the cache — exclude. Addressable surface = cold turns only. |
| Byte-identical retry metering | **UNKNOWN (visibility at most)** | Retries resend identical bytes (`retry_mixin.py:77-94`); whether billed is provider/error-dependent (above). Cannot state a derivable saving. |

**Worked cached-turn example (Sonnet 5.5, estimate).** Mid-conversation: ~3,000
tool + ~4,000 static-system + ~20,000 history cached, + ~1,500-tok new delta.
Naive no-cache full resend: 28,500 × $2/MTok = **$0.057/turn**. OpenHands as-is:
~27,000 read × $0.10 = $0.0027 + ~1,500 write × $2.50 = $0.00375 → **≈
$0.0065/turn** (~89% already saved by the agent's own caching). A MESH
dedup/compaction pass operates on the $0.0027 cache-read portion and risks a
$2.50/MTok re-write — near-zero, possibly negative.

---

## Aider

Repo `github.com/Aider-AI/aider`, sha
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c` (`main`, read 2026-10-27). Aider
rebuilds the whole request each turn from eight typed `ChatChunks`; order
(`aider/coders/chat_chunks.py:16-26`): `system + examples + readonly_files + repo +
done + chat_files + cur + reminder`. Review spot-checked this order and the
3-breakpoint `add_cache_control_headers` against ground truth — **exact match**.

**Context assembly.** Full-history resend, but file bodies live in a separate
rebuilt chunk, not baked into history (`base_coder.py:789-793`,
`get_files_content()`). History (`done`) accumulates user/assistant text only; a
file's content is sent once per turn (current version), never duplicated across
history and the file chunk. What grows: `done` and `cur`; everything else resends
at roughly constant size. Summarisation: once history exceeds
`max_chat_history_tokens` (`base_coder.py:510-513` → `aider/history.py:15-18`),
default `min(max(max_input_tokens/16, 1024), 8192)` (`models.py:356-358`), run on
the weak model in a background thread (`base_coder.py:1011-1017`; `history.py:33-90`).
Repo-map bounded: default `map_tokens=1024` (`repomap.py:49,70`; `base_coder.py:489`),
up to ~4,096 for large-context models (`models.py:782-789`), rebuilt each turn but
capped, not stored in history.

**Tool schemas.** For the default/recommended `diff` edit format: **ZERO tool-schema
bytes.** `Coder.functions = None` (`base_coder.py:96`); `model-settings.yml` sets
`edit_format: diff` on every Claude entry (e.g. L149, L189, L218). `tools` is added
only if `functions is not None` (`models.py:1006-1009`), and even then it is one
function with forced `tool_choice`. Only opt-in `*_func` coders populate
`functions` with a single small schema. No multi-tool registry resent.

**Caching behaviour.** Mechanism exists, well-structured, **OFF by default**.
`add_cache_control_headers()` (`chat_chunks.py:28-55`) places ephemeral breakpoints
on up to three chunk groups: (examples else system), (repo else readonly_files),
and chat_files; `cacheable_messages()` (`:57-64`) trims to the last marked message.
Activates only with `--cache-prompts` (CLI default **False**, `args.py:233-236`;
`cache_prompts=False`, `base_coder.py:329`; gate `:426-427`) or
`caches_by_default: true` (10 models). So a default Claude run sends no
`cache_control` and pays full input on every resent prefix. **Prefix volatility:**
the system prompt date-stamps at day granularity (`strftime("%Y-%m-%d")`,
`base_coder.py:1143-1144`) plus static platform/shell/lint/test
(`get_platform_info()`, `:1127-1172`) — stable intra-session. The repo-map chunk is
volatile under default `refresh="auto"` (cache key includes
`mentioned_fnames`/`mentioned_idents` from the current user message,
`repomap.py:597-602`; `base_coder.py:713-730`) but sits after system/examples, so
its churn only invalidates `repo` onward. Because `done` grows every turn, the
`chat_files` breakpoint (placed after `done`) typically misses; the reliably-cached
span is system/examples (+repo when mentions unchanged).

**Retries.** Byte-identical resend on transient errors (`base_coder.py:1456-1488`,
same `messages` object, same hash `models.py:1015-1019`) but these fire on
`ex_info.retry` exceptions (rate-limit/5xx/timeout) — failed calls that produced no
billable output, so **no double-bill**. One genuinely-billed re-request:
`FinishReasonLength` + `supports_assistant_prefill` (`base_coder.py:1492-1505`)
re-sends full context plus partial assistant content to continue generation — a
correctness necessity, not waste.

**Output shape.** Diff/patch. Default `diff` mandates SEARCH/REPLACE blocks ("ONLY
EVER RETURN CODE IN A SEARCH/REPLACE BLOCK", `editblock_prompts.py:27-28`, blocks
48-53); `udiff`, `patch` also frugal; whole-file (`wholefile_coder.py`) reserved for
weak models, and aider tells the user to "Use a stronger model that can return
diffs" when output tokens are exhausted (`base_coder.py:1666-1667`).

### MESH lever map — Aider
| lever | verdict | arithmetic / reason |
|---|---|---|
| Tool-schema compaction | **N/A** | Default path sends 0 tool schema (`base_coder.py:96`; `models.py:1006`). |
| Exact duplicate-context dedup | **ALREADY-DONE — exclude** | File bodies sent once per turn in a dedicated chunk, not also in history (`chat_chunks.py:16-26`; `base_coder.py:789-793`); history weak-model-summarised at a bounded threshold. No duplicate blob to dedup. |
| Cache placement (mechanism) | **ALREADY-DONE — exclude** | Aider implements multi-breakpoint `cache_control` placement (`chat_chunks.py:28-55`). The only gap is default-off, fixed by aider's own `--cache-prompts` flag — billing MESH for flipping the agent's own switch violates the end-user rule. |
| Cache placement + volatility guard | **APPLIES, narrow, conditional** | Only once the customer has enabled `--cache-prompts`. Aider marks the volatile `repo` chunk cacheable under `refresh="auto"` (`repomap.py:597-602`); a guard that drops the repo breakpoint on mention-changing turns avoids a wasted write. A 1,024-tok repo-map re-written needlessly: avoidable ≈ `1,024 × ($2.50 − $2.00)/MTok = $0.00051/affected turn`. Tiny, mention-change-gated. |
| Fresh-tool-result cap | **N/A** | No tool-result messages in the default text-edit flow; shell/test output is user-gated plain text (`base_coder.py:2471-2484`). |
| Byte-identical retry metering | **N/A (not billed)** | Retries fire only on pre-output failures (`ex_info.retry`); providers don't bill failed completions. |
| Output re-emission metering | **ALREADY-DONE — exclude** | SEARCH/REPLACE diffs (`editblock_prompts.py:27-28`); only full-context re-request is the `FinishReasonLength` continuation, a correctness necessity. |

Dominant real cost (default caching OFF): a ~7,500-tok stable prefix resent at full
input = 7,500 × $2/MTok = **$0.015/turn**; enabling caching cuts it to 7,500 ×
$0.10/MTok = **$0.00075/turn**. But that saving is captured by aider's own
`--cache-prompts`, so MESH cannot bill for it.

---

## SWE-agent

Repo `SWE-agent/SWE-agent`, sha
`3ea751c087f32b16e039a2233dd6eefecef325d5` (`main`).

**Context assembly.** Full-history resend, no default truncation.
`AgentConfig.history_processors = [DefaultHistoryProcessor()]` (`agents.py` L155,
L174), which is a pass-through `return history` (`history_processors.py` L81-82).
`messages` filters to this agent then chains processors (`agents.py` L540-551);
`step()` sends it all (`forward_with_handling(self.messages)`, L1252); each step
appends action + observation (`add_step_to_history`, L714-739 → `_append_history`
L556-559). No summarisation. Per-observation truncation only, at creation
(`agents.py` L748-760 region). Optional `LastNObservations` elision exists
(`history_processors.py` L85-176) but is not in `config/default.yaml`. Shipped
default is `history_processors: [cache_control]` (`config/default.yaml` L67-68).

**Tool schemas.** With `use_function_calling` (default `parse_function:
function_calling`, `default.yaml` L65-66), `extra_args["tools"] =
self.tools.tools` attached to every `litellm.completion` (`models.py` L708-709, call
L722-730); schema builder `commands.py` L133-165. Default bundle (`default.yaml`
L41-44 + `enable_bash_tool: true` L64): `str_replace_editor`, `submit`, `bash`.
Reviewer-reconstructed serialized JSON:

| tool | bytes |
|---|---|
| bash | 261 |
| str_replace_editor | 2,579 |
| submit | 129 |
| **total** | **2,975 B ≈ ~750 tok (bytes/4 divisor ASSUMED, review D8)** |

`str_replace_editor`'s 15-line OpenHands-derived docstring
(`tools/edit_anthropic/config.yaml` L8-20) is 87% of the schema.

**Caching behaviour.** On by default with a volatility guard.
`CacheControlHistoryProcessor` (`history_processors.py` L261-302) writes an
ephemeral breakpoint on the last 2 user/tool messages (`last_n_messages=2`, L269)
and clears stale breakpoints (L293); enabled in `default.yaml` L67-68. System
message added once (`agents.py` L608-613), instance template once (L748-760);
per-turn cwd/open-file rides in the newest observation at the tail, after the
breakpoints — no per-turn churn in the cached prefix. The code documents the trap:
`LastNObservations` "will break prompt caching… every query will change every time"
and offers a `polling` guard (`history_processors.py` L106-122).

**Retries.** `LiteLLMModel.query` wraps `_single_query` in tenacity
`Retrying(stop=stop_after_attempt(retries=20), ...)` (`models.py` L794-831,
`RetryConfig.retries=20` L58); messages built once before the loop so a retry is
byte-identical, but `retry_if_not_exception_type(...)` (L813-829) fires only after a
failed call with no billable completion. Format/blocklist/bash-syntax requeries
(`forward_with_handling` L1062-1110 → `get_model_requery_history` L789-822) build a
*different* request (billed, not byte-identical).

**Output shape.** `str_replace_editor` with `old_str`/`new_str`
(`tools/edit_anthropic/config.yaml` L37-45); no whole-file reprint.

### MESH lever map — SWE-agent
| lever | verdict | arithmetic / reason |
|---|---|---|
| Tool-schema compaction | **APPLIES, trivial after cache** | 30-turn trajectory, tools ~750 tok. Uncached: 30 × 750 × $2/MTok = $0.045. With default cache: 1 write (750 × $2.50/MTok = $0.00188) + 29 reads (21,750 × $0.10/MTok = $0.00218) ≈ $0.00405. Compacting the docstring 750→450 tok (−40%): saves ~0.4 × $0.00405 ≈ **$0.0016/trajectory**. Real but negligible. |
| Exact duplicate-context dedup | **N/A** | Each observation/action once; no repeated identical blocks. |
| Cache placement + volatility guard | **ALREADY-DONE — exclude** | `CacheControlHistoryProcessor` in `default.yaml`, last-2 breakpoints, stale cleared, stable prefix. |
| Fresh-tool-result cap | **ALREADY-DONE (partial)** | Each oversized observation capped at `max_observation_length`. Whole-history `LastNObservations` is off by default and turning it on breaks the cache (its own docstring) — trades cache-read for elision, not additive. |
| Byte-identical retry metering | **N/A** | Retries follow unbilled exceptions; the one billed retry (format requery) is not byte-identical. |
| Output re-emission metering | **N/A** | `str_replace` diffs. |

Verdict: on the shipped default, MESH has almost nothing to add — correct
multi-turn cache placement with a volatility guard, capped observations, diff
output. Only residual is sub-cent-per-trajectory docstring compaction.

---

## gpt-researcher

Repo `assafelovic/gpt-researcher`, sha
`5cdad9cb434754188b78bd998df18dd8d502cf7e` (`master`). **Verify-before-ship
(review D14):** every gpt-researcher dollar figure below is **CONTINGENT** on the
"no prompt caching" claim (`utils/llm.py`, `base.py`), which was **not fetched in
review**. If the repo does cache, the dedup and cache-placement levers would be
billing the customer's own savings (cardinal sin). Confirm the absence of
`cache_control` on the request path directly before publishing any number here.

**Context assembly.** Stateless single-shot prompts, not a growing chat. Every LLM
call is a fresh `[system, user]` array per task
(`gpt_researcher/actions/report_generation.py` L38-56, L89-108, L139-153, L187-202,
L274-289). The research→context step is embedding-compressed, not an LLM re-send:
`ContextManager.get_similar_content_by_query` runs
`ContextCompressor.async_get_context(query, max_results=10, …)`
(`skills/context_manager.py` L37-63). What repeats: the compressed `context` is
front-loaded in the report prompt (`Information: "{context}"`, `prompts.py`
L293-295) and again in the introduction call (`report_generation.py` L42-46) —
uncached. **Detailed reports re-send the shared base context N times:**
`DetailedReport` seeds every subtopic with the main context
(`backend/report_type/detailed_report/detailed_report.py` L164), then each
subtopic's `write_report`/`get_draft_section_titles` embeds `global_context` into
its own uncached prompt (L138-186, loop L110-120). `list(set(...))` dedups within
one call, nothing dedups across the N calls.

**Tool schemas.** None — `self.llm.ainvoke(messages)` via LangChain
(`llm_provider/generic/base.py` L293-301), no `tools=`. N/A.

**Caching behaviour.** **None found** (contingent, D14). `create_chat_completion`
(`utils/llm.py` L41-131) passes plain string-content messages to `ainvoke`; no
`cache_control` on the request path or in `base.py`; `ChatAnthropic` built with bare
kwargs (`base.py` L118-122). If caching were added the layout is cache-friendly:
`context` front, and the only volatile token `Assume that the current date is
{date.today()}` (`prompts.py` L315) is daily-stable and trails the prefix.

**Retries.** `create_chat_completion` loops `max_attempts = 10` (`utils/llm.py`
L101-131), messages built once before the loop → byte-identical. Two resend
triggers: an exception (L108, generally unbilled) and, critically, a non-empty 200
that returned **empty content** (`if not response:` → sleep → resend, L118-126) —
an empty-but-billed completion followed by a re-bill of the identical prompt.
`generate_report` has a near-identical fallback resend on exception
(`report_generation.py` L290-305).

**Output shape.** Prose generation (`prompts.py` L293-315), not re-printed input.
But `write_conclusion` passes the entire generated report back as input context
(`report_generation.py` L89-98; `writer.py` L143-152) — paying input to re-read its
own output.

### MESH lever map — gpt-researcher (all figures estimate + CONTINGENT on D14)
| lever | verdict | arithmetic / reason |
|---|---|---|
| Tool-schema compaction | **N/A** | No tools. |
| Exact duplicate-context dedup | **APPLIES (detailed reports), identity UNVERIFIED** | `global_context` re-sent in each of N subtopic calls. Worked case (context ~8,000 tok, N=5): 5 × 8,000 × $2/MTok = $0.08; dedup to one send = 8,000 × $2/MTok = $0.016 → saving ≈ **$0.064/detailed-report** = `(N−1) × context × $2/MTok`. **Review D9:** this requires the emitted `global_context` block to be byte-identical across the N calls — subtopic prompts differ *around* it; only the within-call `list(set(...))` dedup (`detailed_report.py` L164) is established. Establish cross-call byte-identity before claiming the full (N−1)x figure. |
| Cache placement + volatility guard | **APPLIES (contingent)** | Same 5x resend, caching instead of deduping: 1 write (8,000 × $2.50/MTok = $0.020) + 4 reads (32,000 × $0.10/MTok = $0.0032) = $0.0232 vs $0.08 → saving ≈ **$0.057/detailed-report**. Guard is easy (front-loaded context, daily-stable date trailing). Contingent on D14. |
| Fresh-tool-result cap | **ALREADY-DONE (compression) — exclude** | Retrieval capped by `ContextCompressor(max_results=10)` / `VectorstoreCompressor(max_results=8)` (`context_manager.py` L61-62, L86) before generation. |
| Byte-identical retry metering | **APPLIES (conditional), frequency UNKNOWN** | Empty-but-billed 200 resends the identical prompt (`utils/llm.py` L118-126). Per occurrence on an 8,000-tok prompt: 8,000 × $2/MTok = **$0.016** billed for nothing. Frequency UNKNOWN — needs the provider empty-response rate. Metering, not guaranteed saving. |
| Output re-emission metering | **APPLIES (small, likely legitimate)** | `write_conclusion` re-sends the full report as input; a ~1,500-tok report = 1,500 × $2/MTok = **$0.003/report**. Arguably necessary for the conclusion task — flag as "measured, likely legitimate." |

Verdict: real derivable levers (contingent on D14) — cache/dedup the base context
across subtopic calls (biggest honest number ≈ (N−1) × context × $2/MTok, ~$0.057–0.064/report)
and meter the empty-response resend.

---

## CrewAI

Repo `crewAIInc/crewAI`, sha `bb4d892e684e9289422e816b8769e7976fdd451a`. For a
`claude-*`/`anthropic/*` model CrewAI routes to its **native Anthropic client by
default** (`lib/crewai/src/crewai/llm.py` L180-210, L306-307); LiteLLM is fallback
only (UNKNOWN — not read).

**Context assembly.** Full-history resend. Executor keeps a growing `state.messages`
and passes a copy every call (`agents/agent_executor.py` L1639-1641, L1729-1731,
`messages=list(self.state.messages)`); appended never rewritten across the ReAct
loop (L1883/L1912/L1964 assistant, L2034/L2065 tool results).
`handle_context_length` runs only on a provider context-length error (L3013-3016,
gated by `respect_context_window`) — remedial, not per-turn. Oversized tool results
deferred proactively: `base_llm.py` L405-423 defers any single result above 25% of
the usable context window to a file; `utilities/tool_result_artifacts.py` L11-13
keeps a 10-line/2,000-char preview.

**Tool schemas.** Converted once per call, sent every request
(`completion.py` L647-657, `params["tools"] = converted_tools`; conversion L681-737
→ `{name, description, input_schema}`). **Byte size UNKNOWN in the abstract** —
user's tools (estimate ~300–800 tok/tool).

**Caching behaviour.** Genuinely engineered. Provider-agnostic
`mark_cache_breakpoint` (`llms/cache.py`) applied to the system message and the
stable initial task prompt (`agent_executor._setup_messages` L519-538); the
Anthropic adapter stamps `cache_control: ephemeral` on the system block
(`completion.py` L1055-1065) and the matched stable user block by **content match,
not position** (L1029-1051, L1068-1085), surviving tool_result expansion. Volatility
guard present: `inject_date` defaults **False** (`agent/core.py` L310) and when on
is appended at the tail to keep the prefix stable (`utilities/prompts.py` L143-163,
`%Y-%m-%d`); skills are metadata-only with a runtime loader (L165-200). Nothing in
CrewAI's own prefix churns per turn. UNKNOWN: a user-supplied template could inject
volatile content.

**Retries.** `llms/retry.py` L124-163 retries only transient throttles (429/
rate-limit, L13-34, max 3); native SDK `max_retries=2` (`completion.py` L259, L452)
retries 408/409/429/5xx. None are billed completions → no byte-identical billed
resend.

**Output shape.** No imposed file-reprint/diff format; the only output-side
mechanism is the input-side `DeferredToolResultReader` (bounded line ranges).

### MESH lever map — CrewAI (native Claude path)
| lever | verdict | arithmetic / reason |
|---|---|---|
| Tool-schema compaction | **ALREADY-DONE (opt-in) / APPLIES (default-off portion)** | Native `tool_search` with `defer_loading` (`completion.py` L652-660, `_apply_tool_search` L727+, types `tool_search_tool_regex/bm25_20251119`) removes inactive schemas, as does skill lazy-loading — but `tool_search` defaults `None`, so by default all schemas are sent every turn. MESH compaction applies to the default-off case; exclude any account with `tool_search`/skills on. |
| Exact duplicate-context dedup | **Mostly N/A** | A single request carries a normal conversation. Cross-agent re-billing in a Crew is legitimate relay, not intra-request duplication. |
| Cache placement + volatility guard | **ALREADY-DONE — exclude** | Breakpoints on system + stable prompt, date/skills kept out of the prefix. |
| Fresh-tool-result cap | **ALREADY-DONE — exclude** | 25%-of-context deferral on by default (`use_better_compaction=True`, `agent_executor.py` L221). |
| Byte-identical retry metering | **N/A** | Throttle-only, unbilled. |
| Output re-emission metering | **N/A** at framework level. |

Net: MESH can honestly claim very little on CrewAI's native Claude path — the
residual is tool-schema compaction only when the customer has not enabled
`tool_search`. LiteLLM fallback path UNKNOWN.

---

## LangGraph (prebuilt `create_react_agent`)

Repo `langchain-ai/langgraph` sha `858891aaa164ebdacf33b8f5e7f88b38b9132211`
(+ `langchain-ai/langchain` sha `575db57ab3658e38ba1d8c40c2bf62110c8a0c27` for the
`ChatAnthropic` model it drives).

**Context assembly.** Full-history resend. The prompt runnable prepends the system
message to the entire `state["messages"]`
(`libs/prebuilt/langgraph/prebuilt/chat_agent_executor.py` L137-170), invoked at
L672-697 (`static_model.invoke(model_input)`), response appended L695. What grows:
every assistant message and every `ToolMessage`, forever. **No truncation/
summarisation by default** — only available via a user `pre_model_hook`
(`chat_agent_executor.py` L397-421 docstring). Out of the box the list is unbounded.

**Tool schemas.** Bound once via `.bind_tools()` (`chat_agent_executor.py`
L583-590), re-serialised into every request by `ChatAnthropic`
(`langchain_anthropic/chat_models.py` `bind_tools` L2661-2740 →
`convert_to_anthropic_tool` L2740; payload L1934+). Standard blocks; byte size =
user's tools (estimate ~300–800 tok/tool). No reduction, no per-request tool-block
caching.

**Caching behaviour.** **Not by default.** `langchain-anthropic` emits
`cache_control` only if the user puts it in message content, or passes a model-level
`cache_control` kwarg (`chat_models.py` L1912-1932,
`_apply_cache_control_to_last_eligible_block` L1176-1207). The prebuilt never sets
it → system + all tool schemas + entire history resent uncached at full input every
turn. LangGraph's own prefix (static `SystemMessage` + static bound tools) does not
churn, so a breakpoint would be safe — it is simply not placed.

**Retries.** No framework-level resend; `ChatAnthropic`/SDK retry 429/5xx only
(unbilled). No billed byte-identical resend.

**Output shape.** No imposed format; determined by the user's tools.

### MESH lever map — LangGraph default
| lever | verdict | arithmetic / reason (estimate; Sonnet 5.5, stated toy scenario) |
|---|---|---|
| Cache placement + volatility guard | **APPLIES, but subject to the end-user-capability test (review D5)** | Prefix S = 4,000 tok (system ~1,500 + 6 tools ~2,500), N = 8 turns. No cache: 8 × 4,000 × $2/MTok = $0.064/run. One ephemeral breakpoint: write 4,000 × $2.50/MTok = $0.010 + reads 7 × 4,000 × $0.10/MTok = $0.0028 = $0.0128. Saving ≈ **$0.051/run**. **Capability test:** `langchain-anthropic` exposes a latent `cache_control` kwarg, so the same test aider got applies. It is defensible that MESH integration ≠ the customer's own capability here — there is **no single user-facing toggle** (unlike aider's `--cache-prompts`); enabling it needs code changes to message construction / model kwargs that the prebuilt does not surface. The lever is claimable only on that argued basis, and only where the customer has not wired caching themselves. |
| Fresh-tool-result cap | **APPLIES; headline demoted (review D10)** | No cap; a large tool result is resent every later turn. **Invented worked input, not a measured distribution:** a 20,000-tok result emitted at turn 2 and resent in 6 later turns = 120,000 × $2/MTok = $0.24/run; capping to a ~200-tok reference saves ≈ 6 × 19,800 × $2/MTok ≈ $0.238/run. Tie to a measured tool-result distribution (cf. the 10-26 ground-truth file: p99 2.5k–6k tok, 10k admitted) before using any magnitude as a headline. |
| Tool-schema compaction | **APPLIES, but overlaps the cache lever — do not double-count** | Uncached: 6 tools ~2,400 tok × 8 × $2/MTok = $0.0384; removing inactive-tool schema ≈ $0.031/run **only under an ASSUMED ~80% inactive ratio (review D7, ungrounded — replace with a measured active/inactive ratio)**. Once the cache lever is applied, the tool block bills at cache-read $0.10/MTok and compaction's marginal saving shrinks ~20x. Price jointly, never additively. |
| Exact duplicate-context dedup | **Mostly N/A** intra-request; multi-agent relay re-billing is inherent, not strippable. |
| Byte-identical retry metering | **N/A** (throttle-only, unbilled). |
| Output re-emission metering | **N/A** at framework level. |

Net: MESH genuinely applies on the LangGraph default (ships none of cache
placement, tool compaction, or a tool-result cap), subject to the capability
argument above and to measuring the tool-result distribution and inactive-tool
ratio rather than assuming them.

---

## AutoGen (`autogen-agentchat` AssistantAgent + native Anthropic client)

Repo `microsoft/autogen` sha `004749e6b7102c8fd317b9b1499ce5807223c278`.

**Context assembly.** Full-history resend. Default context
`UnboundedChatCompletionContext()` (`autogen-agentchat/.../agents/_assistant_agent.py`
L837-840). Each call builds `system_messages + all_messages` where `all_messages =
await model_context.get_messages()` returns everything (L1088-1090), then
`model_client.create(llm_messages, tools=...)` (L1108-1115); incoming messages
appended (L1015-1025). Unbounded. Truncation/summarisation opt-in only
(`BufferedChatCompletionContext`, `HeadAndTail...`, `TokenLimited...` in
`autogen-core/.../model_context/`). **Multi-agent relay:** in a team each agent runs
in a `ChatAgentContainer` that buffers every other agent's response
(`teams/_group_chat/_chat_agent_container.py` L53, L64-66, L161-165), passed to its
agent on its turn (L92, L133) and appended to its own `model_context` — shared
content is re-billed once per agent that takes a turn, intrinsic to the design.

**Tool schemas.** `convert_tools(tools)` on every `create()`/`create_stream()`
(`autogen-ext/.../models/anthropic/_anthropic_client.py` L629, L849; converter
L319-357 → `{name, input_schema, description}`), placed at `request_args["tools"]`
L627-635; rebuilt each call (`_assistant_agent.py` L1088). Byte size = user's tools
(estimate ~300–800 tok/tool).

**Caching behaviour.** **None.** The native client never emits `cache_control`
(grep finds only `cached=False` result fields at L755, L1041, reporting no
client-side response-cache hit); `request_args` (L613-635) carries
`model, messages, max_tokens, temperature, system, tools` — no cache directive. So
system + tools + full history resent uncached every turn, for every agent. The
static system prefix does not churn, so caching would be safe — just not done.

**Retries.** No framework-level billed resend; SDK retries 429/5xx (unbilled). The
opt-in `ChatCompletionCache` wrapper
(`autogen-ext/.../models/cache/_chat_completion_cache.py`) returns a stored response
for an identical request (avoids a call, not a double-bill); default off.

**Output shape.** No imposed format.

### MESH lever map — AutoGen default
| lever | verdict | arithmetic / reason (estimate; Sonnet 5.5) |
|---|---|---|
| Cache placement + volatility guard | **APPLIES, subject to the same end-user-capability test (D5)** | Same structure as LangGraph: S=4,000, N=8 → ≈ **$0.051/run** saved per agent; in an M-agent team the uncached prefix is paid per agent so it scales ~×(agents that take turns). AutoGen has no user-facing caching toggle and no `cache_control` path at all, so the "MESH integration ≠ customer capability" argument is stronger here than for LangGraph. |
| Fresh-tool-result cap | **APPLIES by default (headline demoted, D10)** | `UnboundedChatCompletionContext` keeps full tool outputs. Same invented-input worked case as LangGraph: ~$0.24/run on a single 20k result over 6 turns; tie to a measured distribution. **Exclude** accounts that configured Buffered/TokenLimited contexts. |
| Tool-schema compaction | **APPLIES, overlaps cache lever — price jointly** | ~2,400-tok block × 8 × $2/MTok = $0.0384 uncached; removal ≈ $0.031/run **(ASSUMED ~80% inactive, D7)**; collapses ~20x once the cache lever is applied. |
| Exact duplicate-context dedup | **N/A intra-request / inherent across agents** (see new-lever candidate). |
| Byte-identical retry metering | **N/A** (throttle-only unbilled; opt-in response cache is a separate customer-side mechanism). |
| Output re-emission metering | **N/A** at framework level. |

Net: same three levers as LangGraph, with the multi-agent-relay surface scaling the
cache lever per agent.

---

## Cross-agent patterns (what most agents waste)

1. **Everyone resends full history every turn.** All eight rebuild the request from
   the whole transcript; none do sliding-window truncation by default. The brake is
   either summarisation at a high-water mark (Cline 90%, OpenHands 80-events/window,
   Aider weak-model summary, SWE-agent none) or nothing (LangGraph/AutoGen default,
   gpt-researcher is stateless so N/A).
2. **The resend is only waste when it is uncached.** The decisive split across the
   whole study is caching, not resend volume. Where the agent caches (Cline,
   OpenHands, SWE-agent default, CrewAI native, Aider-with-flag), the resent prefix
   bills at cache-read $0.10/MTok and MESH's resend-oriented levers are
   ALREADY-DONE or net-negative (editing a cached prefix forces a $2.50/MTok
   re-write downstream). Where the agent does not cache (LangGraph default, AutoGen
   default, gpt-researcher), the same bytes bill at $2/MTok and the cache lever is
   real. **The single biggest determinant of whether MESH can help an account is
   "does this agent already cache its prefix".**
3. **Tool schemas ship every turn almost everywhere**, but after turn 1 they sit in
   the cached prefix, so schema compaction is a cold/cache-miss-turn lever worth
   fractions of a cent, and it double-counts against the cache lever — never price
   the two additively.
4. **Diff-shaped output is the norm** (Cline, OpenHands, Aider, SWE-agent); no
   whole-file reprint loop to meter on the code agents. Output re-emission is a
   real lever per the 10-26 ground-truth file (~24% of output lines are
   context-duplicates) but is not visible from these agents' *tool shapes* — it
   lives in model behaviour, so it is a metering/advisory lever, not a structural
   one these agents expose.
5. **Framework-level retries are overwhelmingly throttle/5xx (unbilled).** The only
   byte-identical *billed* resends found are Cline's empty-response retry (which
   Cline already surfaces) and gpt-researcher's empty-200 resend (unknown
   frequency). Retry metering is a visibility feature, not a derivable saving, in 7
   of 8 agents.
6. **Three agents already implement the heavy levers in source** (Cline, OpenHands,
   SWE-agent): cache placement + volatility guard, fresh-tool-result cap, diff
   output. CrewAI's native path adds a 25%-context cap and opt-in tool_search.
   These are the honest "MESH cannot help much here" segment and should become a
   do-not-pay-us label on the site, exactly as the dispatch allows.

## New lever candidates

### Candidate 1 — idle-expiry cache-miss metering ("keep-warm economics", Cline and any 5-min-TTL agent)
**Mechanism.** Cline writes only the default 5-minute ephemeral cache
(`createEphemeralCacheControl`, `utils.ts:12-16`; no 1-hour option anywhere in the
routing code). In interactive coding, think/read/test gaps routinely exceed 5
minutes; when a gap exceeds the TTL the entire cached prefix
(system + tools + full history, often 50k–150k tok) expires and the next turn
re-bills it at cache-write or full input instead of cache-read. MESH meters it from
observed request timestamps + per-request `cache_read` vs `cache_write` usage (both
already in the usage stream Cline aggregates) and recommends the 1-hour tier or a
keep-warm ping when inter-turn gaps cluster above the TTL.
**Pricing basis.** Per idle-expired turn, delta = `prefix_tokens × ($2.50 −
$0.10)/MTok` (write vs read) or `× ($2.00 − $0.10)/MTok` (full input vs read). For a
100k-tok prefix: `100,000 × $2.40/MTok ≈ $0.24` avoidable on that turn (write vs
read) — **presented as mechanism, NOT a shipped quantified lever**, because the TTL
is unmeasured (review D11).
**Why this might be wrong.** (a) The TTL is inferred from `{type:"ephemeral"}` with
**no explicit TTL constant found** — if a provider's default differs the whole
12.5x jump and the dollar figure shift; this must be measured, not assumed. (b) The
1-hour tier costs more to write, so it only pays off above a break-even frequency of
idle-but-resumed turns — an empirical per-user claim. (c) A keep-warm ping is itself
a billed request; if idle gaps are rare the remedy costs more than the waste. (d)
Some of this is inherent to human-paced interactive use and is not removable without
switching tier/provider — honest framing is metering + tier-recommendation, not a
guaranteed saving. If a user's idle gaps turn out rare, the honest verdict for that
user is "MESH cannot help here."

### Candidate 2 — empty-response resend metering (gpt-researcher, generalises)
**Mechanism.** gpt-researcher's `create_chat_completion` treats a 200-OK-but-empty
completion as a failure and resends the byte-identical prompt up to 9 more times
(`utils/llm.py` L118-126). Providers bill the empty 200 (input processed). The
existing byte-identical-retry lever is scoped to retries-after-*error*; this is a
retry-after-*billed-success-with-empty-body*, which that lever's error predicate
misses. MESH detects `response_body_empty AND next_request_hash == prev_request_hash
AND prev_request_was_billed` and credits/surfaces the duplicate.
**Pricing basis.** Per duplicate: `prompt_tokens × input_price` (+ any cache-write
already paid). Worked case: 8,000 tok × $2/MTok = $0.016 per empty-retry event.
**Why this might be wrong.** (a) An empty 200 may be far rarer than an outright
error, so dollar impact could be ~zero — frequency is **UNKNOWN**, unmeasured. (b)
Some providers return empty bodies *without* billing input (safety stop, zero-output
stream); then there is no double-charge and the lever would over-credit. (c) When
`stream=True` with a websocket (the default UI path), `max_attempts` collapses to 1,
so this triggers only on non-streaming/no-websocket calls — narrow applicability.
Bankable only if MESH observes the provider's actual billing of empty responses;
otherwise UNKNOWN, not asserted.

### Candidate 3 — cross-agent relay cache-sharing (AutoGen/CrewAI/LangGraph teams) — REJECTED on current evidence
**Mechanism.** In a multi-agent team the same conversation content is re-billed once
per agent per turn because each agent sends it inside its own request. If all agents
share one account, a MESH proxy could position an ephemeral breakpoint on the shared
relayed-conversation span so agent B reads what agent A wrote.
**Pricing basis.** On a relayed span of R tokens shared by M agents: without
sharing, (M−1) agents re-pay R × $2/MTok; with a shared cache, one write R ×
$2.50/MTok then (M−1) reads R × $0.10/MTok. R=3,000, M=4: naive = 3 × 3,000 ×
$2/MTok = $0.018/turn; shared = $0.0075 + 9,000 × $0.10/MTok = $0.0084; saving ≈
$0.0096/turn.
**Why this might be wrong (and why it is rejected here).** Anthropic's cache key is
the exact prefix, which includes each agent's distinct system prompt and tool set —
and those sit *before* the shared conversation in the fixed tools→system→messages
ordering. Because agents differ in system/tools, their prefixes diverge *before* the
shared span, so agent B's request is not a prefix-extension of agent A's and gets
**no cache hit on the relayed span at all**. A hit would require identical
system+tools across agents (defeating distinct roles) or reordering the payload
(which the fixed ordering forbids). The 5-minute TTL and interleaved turns further
erode hits. Plausible only for homogeneous-prompt agent pools; for a typical
heterogeneous team it collapses to zero. Sell only against *measured* cache-hit
tokens, never modelled. Logged as an honest negative result.

## What we still don't know

- **OpenAI Agents SDK and Claude Agent SDK examples** — on the dispatch target list,
  **not read today**. Primary nightly-shift extension.
- **OpenHands line-cites (review D13).** The sha and directory layout are verified;
  the `agent.py` / `llm_summarizing_condenser.py` line numbers and the
  `effective_max_tokens = min(...)` condenser-trigger paraphrase are **not**
  line-verified and the paraphrase is likely imprecise. Needs a line-level pass.
- **gpt-researcher "no caching" (review D14).** The dedup and cache-placement levers
  are **CONTINGENT** on this; `utils/llm.py` / `base.py` were not fetched in review.
  Confirm no `cache_control` on the request path before publishing any gpt-researcher
  dollar figure.
- **gpt-researcher cross-call context byte-identity (D9).** The (N−1)x dedup figure
  needs the emitted `global_context` block shown byte-identical across subtopic
  calls; only within-call dedup is established.
- **Tool-schema byte counts are reviewer reconstructions with assumed bytes/token
  divisors (D8)**, not tokenizer-measured and not self-consistent across sections
  (3.7 vs 4.0 B/tok). Re-measure with a real tokenizer before any schema figure
  ships. User-defined tool schemas (CrewAI/LangGraph/AutoGen) are UNKNOWN in size.
- **The "~80% inactive-tool" ratio (D7)** behind LangGraph/AutoGen schema-compaction
  figures is assumed, not measured. Replace with a measured active/inactive ratio.
- **Cache 5-min TTL (D11)** — no explicit constant found in Cline; the keep-warm
  lever's magnitude is gated on measuring it and the per-user idle-gap distribution.
- **CrewAI LiteLLM fallback path** — only the native Anthropic path was read.
- **Whether user-supplied prompt templates / `pre_model_hook`s inject volatile
  content** that would break an otherwise-stable cached prefix (CrewAI, LangGraph).
- **Real billed-vs-estimate gap.** Every dollar here is a code-derived estimate;
  per the honesty rule, numbers that ship on the site must come from provider-reported
  usage on completed tasks, not these arithmetic estimates.
