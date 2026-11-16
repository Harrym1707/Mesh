# Coding-tool reachability for the MESH proxy

**Question:** For each AI coding tool, can a user (a) bring their own API key AND (b) point the
Anthropic (and/or OpenAI) traffic at a **custom base URL** — so MESH, a local transparent proxy
you point a base URL at, can sit in the request path and cut token usage?

**The distinction that matters:** "has BYOK" is not enough. MESH is only reachable when the tool
honours a **custom base URL on the path we optimise** (ideally the Anthropic Messages path). A tool
can let you paste an API key and still hard-route every request through the vendor's backend —
in which case MESH cannot see the traffic.

Verified 2026-10-29 against official docs / config references / vendor GitHub.

## Reachability matrix

| Tool | BYOK? | Custom base-URL on Anthropic path? | Reachable by MESH | Source | Caveat |
|---|---|---|---|---|---|
| **Claude Code** (Anthropic CLI) | Yes | **Yes** — `ANTHROPIC_BASE_URL` (+ `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`), shell or `settings.json` `env` block | **Yes** | [code.claude.com/docs/en/llm-gateway-connect](https://code.claude.com/docs/en/llm-gateway-connect) | Documented path authenticates with an **API key / auth token**, which takes precedence over a claude.ai login. The Max/Team **subscription (OAuth)** is not the documented credential for a custom base URL — see note below. |
| **Cursor** | Yes | **Partial** — "Override Anthropic Base URL" + Anthropic key applies only to Chat / Composer / Inline Edit prompt path | **Partial** | [forum.cursor.com/t/...146998](https://forum.cursor.com/t/override-anthropic-base-url-automatically-switches-on-when-using-anthropic-byok/146998) | Requests still pass through **Cursor's backend for final prompt building**; **Tab autocomplete** stays on Cursor's own models/backend and is never reachable. Override applies to both an OpenAI and an Anthropic base URL field (Settings → Models). |
| **GitHub Copilot** | CLI: Yes / IDE: No | **CLI only** — `providers.json` (`~/.copilot`) with `type: "anthropic"` + API URL; or `COPILOT_PROVIDER_BASE_URL`/`COPILOT_PROVIDER_TYPE=anthropic` via Copilot SDK | **Partial** (CLI/SDK only) | [docs.github.com/.../use-byok-models](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models); [github.com/github/copilot-sdk BYOK](https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md) | **IDE Copilot has no custom Anthropic base URL** — open request [microsoft/vscode#286734](https://github.com/microsoft/vscode/issues/286734). Only the CLI / SDK expose a provider base URL. |
| **Cline** (VS Code) | Yes | **Yes** — Anthropic provider → "Use custom base URL" + key; or OpenAI-Compatible provider with Base URL | **Yes** | [github.com/cline/cline](https://github.com/cline/cline) issue [#7128](https://github.com/cline/cline/issues/7128); provider settings | Native Anthropic provider keeps the Anthropic wire format (best for MESH). Fully client-side; no vendor backend in the path. |
| **Aider** | Yes | **Yes** — `ANTHROPIC_API_BASE` / `ANTHROPIC_BASE_URL`; OpenAI via `--openai-api-base` / `OPENAI_API_BASE` | **Yes** | [github.com/Aider-AI/aider#1182](https://github.com/Aider-AI/aider/issues/1182) | Open-source CLI, direct provider calls; no backend. Built on LiteLLM so both Anthropic and OpenAI base URLs are overridable. |
| **Continue.dev** | Yes | **Yes** — `apiBase` on the `anthropic` provider in `config.yaml`/`config.json` | **Yes** | [docs.continue.dev/reference](https://docs.continue.dev/reference); [continue#3441](https://github.com/continuedev/continue/issues/3441) | Anthropic-compatible `apiBase` needs the `/v1` suffix. Fully local config; no vendor backend. |
| **Windsurf** (Codeium / Devin Desktop) | No (limited) | **No** | **No** | [docs.xantly.com/.../use-with-windsurf](https://docs.xantly.com/docs/use-with-windsurf/); community reports | AI endpoint is **hard-coded and signed**. "BYOK" (where present) routes an Anthropic key through Codeium's hosted proxy to fixed models; no custom gateway. Workarounds (hosts spoofing, config edits) don't survive updates. |
| **Zed** | Yes | **Yes** — `language_models.anthropic.api_url` in `settings.json`, or an `anthropic_compatible` provider block | **Yes** | [github.com/zed-industries/zed discussion #35333](https://github.com/zed-industries/zed/discussions/35333); [#34130](https://github.com/zed-industries/zed/discussions/34130) | `api_url` must have **no trailing slash** (SDK appends `/v1/messages`). `openai_compatible` / `anthropic_compatible` blocks cover custom endpoints. |

Legend — Reachable by MESH: **Yes** = Anthropic (or OpenAI) traffic can be fully pointed at a local
proxy; **Partial** = only some surfaces route through the override (others are backend-locked);
**No** = endpoint is fixed, MESH cannot intercept.

### Claude Code subscription vs API key (the primary pain)

The official gateway doc is explicit: a custom base URL is set with `ANTHROPIC_BASE_URL`, and the
accompanying credential is an **API key** (`ANTHROPIC_API_KEY`, `x-api-key`) or a **bearer/auth
token** (`ANTHROPIC_AUTH_TOKEN`). That gateway credential **takes precedence over a saved claude.ai
login** ("Your claude.ai login stays saved and unused while the variable is set"). The documented,
supported way to route Claude Code through a custom base URL is therefore the **API-key / auth-token
path**, not the Max/Team/Pro **subscription OAuth** login.

Implication for MESH:
- **API-key / auth-token usage of Claude Code is fully reachable** — set `ANTHROPIC_BASE_URL` to the
  local MESH endpoint (plus credential) in shell env or `~/.claude/settings.json`, and every
  Messages request flows through MESH. This is a clean, officially documented integration.
- **Subscription (Max/Team) usage** is not a documented base-URL scenario; Anthropic positions the
  gateway/base-URL flow for org-issued API credentials. A transparent local proxy that simply
  forwards the same Authorization header to `api.anthropic.com` is technically in-path if the client
  still emits its token, but this is **undocumented / unsupported** and should be marked UNKNOWN for
  the OAuth-login case rather than promised. Note: Remote Control and voice dictation are explicitly
  disabled whenever `ANTHROPIC_BASE_URL` points at a non-Anthropic host or a credential var is set.

## Addressable surface — conclusion

**MESH can optimise today (full Anthropic-path interception via a documented custom base URL):**
- **Claude Code** — on the **API-key / auth-token** path. This is the headline target and the
  primary "running through Claude licenses" pain: `ANTHROPIC_BASE_URL` is first-class, documented,
  and routes 100% of model traffic through MESH.
- **Cline, Aider, Continue.dev, Zed** — all expose a native Anthropic `apiBase`/`api_url`/
  `ANTHROPIC_BASE_URL` with no vendor backend in the path. Clean, full interception.

**Partial surface (optimise some traffic, not all):**
- **Cursor** — the Anthropic/OpenAI base-URL override covers Chat/Composer/Inline Edit prompts, but
  requests still transit Cursor's backend for final prompt assembly and **Tab** is backend-locked.
  Reachable for the chat/agent path only; treat savings as partial.
- **GitHub Copilot** — reachable only via **Copilot CLI / SDK** (`providers.json` /
  `COPILOT_PROVIDER_BASE_URL`). The **IDE** extension has no custom Anthropic base URL (open feature
  request), so the large IDE install base is not addressable yet.

**Not reachable:**
- **Windsurf (Codeium / Devin Desktop)** — endpoint hard-coded and signed; no custom gateway. MESH
  cannot intercept.

**Bottom line:** The strongest, cleanest target is **Claude Code on API-key auth**, followed by the
open-source / local-config tools (Cline, Aider, Continue.dev, Zed) which are all fully in-path.
Cursor and Copilot-CLI are partial. Windsurf is closed. The Claude Code **subscription (OAuth)**
case is the one genuinely open question and should be validated empirically before being claimed.
