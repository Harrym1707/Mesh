# MESH pilot onboarding — the one canonical path

There is more than one way to run MESH (proxy via npm, the `mesh` launcher, the
SDK wrapper, build-from-source). **For a pilot, use exactly one of them so every
partner is set up the same way and every ledger lands in the same place.** This
is that path. Everything here was run end-to-end on `main` on 2026-11-07; see
[VERIFICATION.md](./VERIFICATION.md) for the exact commands and output.

---

## The canonical path: proxy mode via npm

One command starts a local proxy; one line of config points the partner's app at
it. Any language, any OpenAI- or Anthropic-compatible client. The partner's API
key passes through verbatim — MESH never holds it.

### 1. Start the proxy

```bash
npx -y -p @harrym1707/sdk mesh-proxy
```

It prints:

```
MESH proxy listening on http://127.0.0.1:8787
Ledger spools: <cwd>/mesh-ledger
```

- **Ledger location (canonical): `./mesh-ledger/` in the directory you ran it
  from.** One hash-chained `.jsonl` spool per application+provider. This is the
  file the operator collects at billing time — agree on the directory up front.
- Port and ledger dir are overridable: `MESH_PROXY_PORT` (default `8787`),
  `MESH_PROXY_LEDGER_DIR` (default `./mesh-ledger`).
- Lossless levers only by default. The Anthropic prompt-cache stamp is opt-in:
  set `MESH_PROXY_CACHE_TTL=5m` (or `1h`) to enable it.

### 2. Point the client at it (one line, no SDK adoption)

```js
// Anthropic SDK
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });
// OpenAI SDK (and any OpenAI-compatible provider)
const openai = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1" });
```

**Non-SDK / other-language clients set the base URL manually** — point whatever
HTTP client the app uses at `http://127.0.0.1:8787` (Anthropic) or
`http://127.0.0.1:8787/v1` (OpenAI-style) and keep sending your own key in the
usual header. MESH forwards `x-api-key` / `Authorization` untouched.

### 3. Let it run, then recompute

Run normal traffic for the pilot window. At any time the partner can verify the
ledger themselves — no MESH involvement, MIT-licensed, zero dependencies:

```bash
npx -y -p @harrym1707/verify mesh-verify ./mesh-ledger/*.jsonl
```

This re-checks the hash chain and recomputes the invoice figure. If the
partner's recomputation disagrees with ours, theirs wins.

---

## Claude Code users: the zero-config alternative

If the design partner uses Claude Code, they can skip the manual base-URL step
and use the `mesh` launcher, which wires Claude Code automatically and ships a
live dashboard and self-check:

```bash
npx -y @harrym1707/mesh start      # or: curl -fsSL https://www.mesh-technology.com/install.sh | sh
```

`mesh start`:

- writes `ANTHROPIC_BASE_URL` into `~/.claude/settings.json` and **reverts it on
  exit** (Ctrl+C), so Claude Code is never left pointing at a stopped proxy;
- writes its ledger to **`~/.mesh/ledger`** (note: a *different* location from
  the proxy path above — pick one convention per partner);
- gives you `mesh dashboard` (a live local savings view) and `mesh verify` (a
  four-check self-proof: provenance, reducer, ledger chain, deterministic
  recompute).

**Always-on mode (`mesh install`, a launchd background service) is macOS-only.**
On Linux/Windows use `mesh start` per session, or the proxy path above.

> The launcher fetches a checksum-verified runtime from
> `https://www.mesh-technology.com` on first run. That endpoint is live and the
> runtime's sha256 matches its manifest (verified 2026-11-07), but it pins a
> runtime build (`c8378ea`, published 2026-11-05) that can lag `main`. For a
> pilot where you want a known build, prefer the npm proxy path or
> build-from-source.

---

## Fallback: build from source (no website, no npm)

For a partner who would rather run audited source than an npm package:

```bash
git clone https://github.com/Harrym1707/Mesh && cd Mesh
corepack enable && pnpm install && pnpm build
node --import tsx evals/run-proxy.ts          # the same proxy, from source → ./mesh-ledger/
```

Then point the client at `http://127.0.0.1:8787` exactly as above.

> **Build gotcha:** `pnpm build` compiles the libraries but **not** the `mesh`
> CLI (it is bundled separately). To run `mesh start` / `dashboard` / `verify`
> from source, use tsx directly, e.g.
> `node --import tsx packages/cli/src/main.ts verify`, or run `pnpm build:cli`.

---

## Which locations hold what (so nothing gets lost)

| Path | Proxy command | Ledger location | Claude Code wiring |
|---|---|---|---|
| **Canonical (pilot)** | `npx -p @harrym1707/sdk mesh-proxy` | `./mesh-ledger/` | manual base URL |
| Claude Code launcher | `npx @harrym1707/mesh start` | `~/.mesh/ledger` | automatic, reverted on exit |
| From source | `node --import tsx evals/run-proxy.ts` | `./mesh-ledger/` | manual base URL |

Agree on **one** row per design partner at kickoff and record it in the
[engagement-list](./engagement-list.md). The operator's billing step
([runbook.md → Operator playbook](./runbook.md#operator-playbook--manual-billing))
reads from whichever location you chose.

## What MESH never does (holds on every path)

- Never holds your API key — it passes through verbatim to your provider.
- Never stores prompt or completion content — the ledger records usage numbers,
  lever names and hashes only.
- Never bills from estimates — only provider-reported usage.
- Never charges without your own recomputable ledger agreeing. No savings →
  `do_not_charge` → $0.
