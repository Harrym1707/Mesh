# Configuring providers and clients

MESH is just a local base URL. Point any client that honours a custom base URL at
the proxy and keep your own API key — MESH passes it through verbatim to the
provider and never stores it.

The proxy listens on `http://127.0.0.1:8787` by default (change it with
`mesh start --port <n>` or `mesh install --port <n>`).

## Providers

### Anthropic (Messages API)

Base URL: `http://127.0.0.1:8787`

```js
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });
```

### OpenAI and OpenAI-compatible endpoints

Base URL: `http://127.0.0.1:8787/v1`

```js
const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" });
```

Any OpenAI-compatible endpoint works the same way — it is only a base URL, so
Python, Go, curl, or any HTTP client is fine. MESH forwards to the upstream you
configure (`https://api.anthropic.com` / `https://api.openai.com` by default).

## Claude Code

`mesh start` and `mesh install` wire this up for you automatically by writing
`ANTHROPIC_BASE_URL` into `~/.claude/settings.json`. You don't need to configure
anything by hand. See [Getting started](getting-started.md).

If you ran `mesh start --no-install`, set it yourself:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

## Other clients

Any client with an Anthropic (or OpenAI) base-URL setting can route through MESH.
Point its Anthropic base URL at the proxy and leave your key where it is:

| Client | How to point it at MESH |
|---|---|
| **Cline** | Set the Anthropic base URL to `http://127.0.0.1:8787`. |
| **Aider** | Set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` in the environment. |
| **Continue** | Set the Anthropic provider's `apiBase` to `http://127.0.0.1:8787`. |
| **Zed** | Set the Anthropic assistant's base URL to `http://127.0.0.1:8787`. |

For OpenAI-style configuration in any of these, use `http://127.0.0.1:8787/v1`.

## Optional: compact JSON tool results

Off by default. When an agent's tools or MCP servers return indented JSON, this
removes the whitespace between the JSON tokens before the result is sent. The
result parses to exactly the same document: every key, string and number is kept
as written. A tool result that is not one whole JSON object or array (a log, a
file read with line numbers, JSON with other text around it) is left untouched,
and so is everything that is not tool output.

Turn it on per workload.

With the proxy (`mesh start` / `mesh install`), add the lever to the `levers`
list in `~/.mesh/theo-policy.json`. A running proxy applies the change to
conversations that start after it; one already in flight keeps the policy it
started with:

```json
{ "lever": "tool-result-json-compaction", "class": "lossless" }
```

With the SDK:

```js
const client = withMesh(new Anthropic(), {
  applicationId: "my-app",
  tokenReduction: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, toolResultJson: true },
});
```

Two things to know before you turn it on:

- **The indentation is not kept.** If your agent reads a JSON file's raw bytes
  through a tool (for example `cat config.json`) and then edits that file by
  matching text exactly, it no longer sees the file's own layout. Leave the
  lever off for that workload.
- **A change takes effect between conversations, not during one.** Switching
  it on or off mid-conversation would change tool results already in the
  history, and a client that uses prompt caching (Claude Code does) would
  re-write its cached prefix. The proxy prevents that by itself: a changed
  policy applies to conversations that start after it, and one already in
  flight keeps the policy it started with. With the SDK the option is fixed
  for the life of the client you wrapped.

Theo keeps a lever you add by hand. He writes his own policy to the same file,
in the background of `mesh start` and whenever you accept one of his
proposals, and leaves your additions in place. Two exceptions: the six levers
Theo manages himself follow his policy, so adding one of those by hand does
not last; and if he proves a lever from the same either-or group as yours
(another output effort level, the other cache lifetime), his replaces yours.

**MESH 0.2.2 does not do this; 0.2.3 and later do.** On 0.2.2 Theo's first
background cycle after any traffic removes a hand-added lever from the file.
`mesh version` says which you have, and `mesh update` moves you to the
latest. If you stay on 0.2.2, start the proxy with `--no-theo`, or use the
SDK option.

## Your key never leaves

Whatever the client, MESH only rewrites the base URL. Your API key stays in the
client, is passed straight through to the provider, and is never stored, logged,
or written to the ledger. See [Data and privacy](data-and-privacy.md).
