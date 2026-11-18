# Happy-path verification — VERIFIED / BROKEN

> **This is a dated record, and it predates MESH 0.2.1.** The checks under
> "Record of 2026-11-07" were run on that day against the runtime then
> published and are kept as written. Since release 0.2.1 (2026-11-16) the
> setup path is different: install from the website, then `mesh start` or
> `mesh proxy`, with the ledger in `~/.mesh/ledger/`
> ([onboarding.md](./onboarding.md)). Where the 0.2.1 checks are recorded:
>
> - the release's own checks on the installed 0.2.1 build:
>   [docs/ops/release-0.2.0-runbook.md](../ops/release-0.2.0-runbook.md),
>   section "Update 2026-11-16 (later)"; releases 0.2.2 and 0.2.3 followed
>   and have their own sections there ("evening" and "night"). 0.2.3 is what
>   the website and npm serve on 2026-11-18;
> - what the 0.2.1 path was and was not tested with: the tester guide's
>   ["Known limits"](./TESTER-GUIDE.md#known-limits-2026-11-16);
> - the smaller set of checks run for this document refresh:
>   [Checks run on 2026-11-16](#checks-run-on-2026-11-16) and, on the
>   installed 0.2.3 build,
>   [Checks run on 2026-11-18](#checks-run-on-2026-11-18), at the end of this
>   file.
>
> Statements in the 2026-11-07 record about which path is canonical, the
> published versions and the runtime lagging `main` describe that day, not
> today.

# Record of 2026-11-07

Every item below was **run end-to-end on `main` on 2026-11-07**, not read from
docs. Commands were run from a clean worktree with a throwaway `$HOME` so the
operator's real `~/.mesh` and `~/.claude/settings.json` were never touched. A
mock Anthropic upstream stood in for the provider so no real tokens were spent.

## TL;DR

**The pilot happy path works.** The one real risk the readiness review flagged —
"install depends on `www.mesh-technology.com`, unverified" — is resolved: the
site is live and serves a checksum-correct runtime, **and** there are two paths
(npm, build-from-source) that don't depend on it at all. Nothing here blocks
starting a pilot. The honest limits are commercial, not technical: zero real
customer traffic yet, published savings bands are synthetic/simulator plus one
30-request live export, and there is no ToS/DPA (see
[pilot-agreement.md](./pilot-agreement.md)).

## VERIFIED ✅

| Step | Result |
|---|---|
| **Website `curl \| sh` path** | `install.sh`, `/mesh` (3.4 KB launcher), `/mesh-version.json` (pins `c8378ea`), `/mesh-runtime` (202 KB) all serve 200. Downloaded runtime sha256 **matches the manifest exactly**. |
| **npm registry** | `@harrym1707/mesh` (bin `mesh`), `@harrym1707/sdk@0.1.1` (bins `mesh-proxy`, `mesh-quote`, …), `@harrym1707/verify@0.1.0` (bin `mesh-verify`) published 2026-11-05. Ran `mesh-quote --help` and `mesh-verify` from npx — both execute. |
| **Build from source** | `pnpm install` + `pnpm build` (`tsc -b`) clean. |
| **Proxy — key passthrough** | Request sent through the proxy; upstream received `x-api-key` **verbatim**, `authorization: null` (off-provider isolation). Response returned byte-identical. |
| **Proxy — ledger** | One hash-chained event written (seq 0, genesis prevHash, `status: succeeded`, priced), plus a content-free `.features.jsonl`. No prompt content anywhere. |
| **`mesh verify`** | 4/4 checks pass: provenance, reducer (−75 tokens, lossless), ledger chain, deterministic recompute. |
| **`mesh dashboard`** | Serves a live local page + `/data` JSON (`chainOk`, `proxyUp`, verdict, Theo's active levers). |
| **`mesh-bill` — live-key rail** | `sk_live_…` without `--live` → refuses, exit 1. |
| **`mesh-bill` — tamper rail** | Tampered spool → `CHAIN BROKEN … DO NOT BILL`, exit 1. |
| **`mesh-bill` — sub-cent floor** | Real live-export spools (net savings < 1¢ of fee) → honest `do_not_charge`. |
| **`mesh-bill` — draft branch** | Valid synthetic chain ($255 saved) → `Will create (draft=true): 255 usd cents`, reaches the Stripe POST. |
| **`mesh-verify` (independent)** | `npx @harrym1707/verify mesh-verify` recomputed the same $255 and confirmed "every hash links". |

## NEEDS AN OPERATOR CREDENTIAL (not broken, just can't be done by a bot) ⚠️

- **Creating the actual Stripe draft** needs a real `sk_test_…` key and a real
  `cus_…` customer id. Everything up to the Stripe call is verified; the final
  draft creation is the operator's step (see the operator playbook). It stays a
  draft in test mode — nothing is charged.

## GOTCHAS TO KNOW (documented, not blockers) 📌

- **`pnpm build` does not build the `mesh` CLI.** `packages/cli` is outside the
  root `tsc -b` graph. From source, run the CLI via `tsx`
  (`node --import tsx packages/cli/src/main.ts <cmd>`) or `pnpm build:cli`.
- **Three ledger locations exist.** `mesh start` → `~/.mesh/ledger`;
  `mesh-proxy` / `run-proxy.ts` → `./mesh-ledger/`. Pick one per partner
  ([onboarding.md](./onboarding.md) standardises on the proxy path).
- **`@harrym1707/cli` and `@harrym1707/core` are not on npm** (internal, 404) —
  this is expected; the public surface is `mesh`, `sdk`, `verify`.
- **Always-on (`mesh install`, launchd) is macOS-only.** Other OSes use
  `mesh start` per session or the proxy path.
- **The published runtime (`c8378ea` / `mesh@0.1.0`, 2026-11-05) can lag `main`,**
  and the always-on daemon auto-updates from the website every ~6h. For a
  reproducible pilot build, prefer the npm proxy path or build-from-source and
  pin it.

## How to reproduce

See the command transcript conventions in [onboarding.md](./onboarding.md) and
[runbook.md](./runbook.md). Run everything under a throwaway `HOME` if you want
to avoid touching your own `~/.mesh` / `~/.claude`.

---

# Checks run on 2026-11-16

Run for the refresh of this kit to the 0.2.1 path. This is a separate record;
nothing above was re-run or rewritten.

**Setup.** The repository at `main` (`0e16e2a`), `corepack pnpm install`, then
`corepack pnpm build`. The CLI was run **from source**
(`node --import tsx packages/cli/src/main.ts <command>`), so it reports
`build dev`: this is the 0.2.1-line code, not the runtime the website
installs. A throwaway `HOME`. A stand-in provider on `127.0.0.1` that records
what reaches it and returns a fixed answer. No real provider was called and no
real key was used. Dollar amounts below are artefacts of two test requests
against the stand-in; they are not savings figures.

## Ran

| Step | Result |
|---|---|
| `mesh proxy --port 18787 --anthropic-base <stand-in>` | Starts. Banner shows the proxy address, `ledger <HOME>/.mesh/ledger`, the two `connect` lines, `claude left alone`, and Theo at `autonomy: recommend`. No `~/.claude` folder was created. |
| `curl http://127.0.0.1:18787/mesh/health` | `{"status":"ok","service":"mesh-proxy"}` |
| Two `POST /v1/messages` with a made-up key | Both 200. The stand-in received `x-api-key` verbatim and no `authorization` header. `~/.mesh/ledger/` then held `proxy-anthropic.jsonl` (2 hash-chained records, no prompt text) and `proxy-anthropic.features.jsonl` (counts and keyed hashes). The window printed `2 requests seen`. |
| One `POST /v1/messages/count_tokens` | Forwarded to the stand-in with its body at the original size (1,202 bytes, against 1,098 for the reduced message requests); no ledger line written. |
| `mesh verify` | Four checks pass: `hash-chain verified across 1 spool(s), 2 record(s)`; `invoice recomputes identically … (do_not_charge)`; `All checks passed.` |
| `mesh status` | `2 requests seen · … verified saved (do_not_charge)`. It reported `proxy not responding` because it looks at port 8787 and the test proxy was on 18787. |
| `mesh doctor` | `ledger 2 records, chain verified`. |
| Ctrl+C on the proxy | `session done: 2 requests, … verified saved.` and exit. |
| Published `@harrym1707/verify@0.1.0`: `npx -y -p @harrym1707/verify mesh-verify <HOME>/.mesh/ledger/proxy-anthropic.jsonl` | `chain verified: 2 record(s), every hash links`, verdict `do_not_charge`, the same figure `mesh verify` gave. **The published 0.1.0 tool reads a ledger file written by the current code.** |
| The same with `<HOME>/.mesh/ledger/*.jsonl` | `CHAIN BROKEN at seq undefined`, exit 1. A false alarm: `mesh-verify` reads only its first argument, and the first match is the `.features.jsonl` file, which is not a ledger. Hence "name the file" in the documents. |
| `scripts/mesh-bill.ts` on `proxy-anthropic.jsonl`, with a placeholder string in place of a Stripe test key | `Mode: TEST`, `verdict: do_not_charge`, `DO NOT BILL`. On this verdict it returns before any request to Stripe; none was made. |
| The same with `*.jsonl` | `CHAIN BROKEN in …proxy-anthropic.features.jsonl`, then a crash, exit 1. Hence "pass each ledger file by name" in the operator playbook. |
| Published `@harrym1707/sdk@0.2.1`: `MESH_PROXY_PORT=18788 npx -y -p @harrym1707/sdk mesh-proxy` | Prints `MESH proxy listening on http://127.0.0.1:18788` and `Ledger spools: <cwd>/mesh-ledger`; creates `./mesh-ledger/`; `/mesh/health` answers. No request was sent through it: it has no setting to point it at a stand-in, so a request would have reached a real provider. |
| `npm view` (read-only) | `@harrym1707/verify` 0.1.0 (published 2026-11-05); `@harrym1707/sdk` 0.2.1 with bins `mesh-demo`, `mesh-proxy`, `mesh-quote`, `mesh-report`; `@harrym1707/mesh` 0.2.1 with bin `mesh`. |

## Read in the code, not run

- `mesh start` wiring and restoring `~/.claude/settings.json`
  (`packages/cli/src/start.ts`); the command tables in
  `packages/cli/src/main.ts` and `mesh-runtime.ts`.
- `mesh verify` reads `~/.mesh/ledger/` only and skips `.features.jsonl`
  files (`packages/cli/src/verify.ts`).
- `mesh-bill` flags, the live-key refusal and the do-not-bill reasons
  (`scripts/mesh-bill.ts`, `packages/core/src/stripe-billing.ts`).
- The installer and the launcher's update check (`docs/site/install.sh`,
  `packages/cli/src/update.ts`).

## Not checked here

- The runtime the website installs: build `5738486` (0.2.1) when these checks
  were run, build `d83ee89` (0.2.2) by the end of the same day. The release
  runbook records the checks on both. The source these checks ran on predates
  the 0.2.2 version bump; it already contained 0.2.2's one new lever, which
  is off by default.
- `mesh start` with Claude Code, the OpenAI-style path, `mesh dashboard`,
  `mesh install`, Windows.
- Any real provider, any real traffic, and creating a Stripe draft (that needs
  the operator's own test key).

---

# Checks run on 2026-11-18

Run on **MESH 0.2.3 as installed from the live website**, for the tester
guide. A separate record; nothing above was re-run or rewritten.

**Setup.** A throwaway `HOME`. A stand-in provider on `127.0.0.1` that records
what reaches it and returns a fixed answer. No real provider was called, no
real key was used, and Claude Code itself was not run. Dollar amounts are
artefacts of one test request; they are not savings figures.

| Step | Result |
|---|---|
| `curl -fsSL https://www.mesh-technology.com/install.sh \| sh` | Installs `~/.mesh/bin/mesh` and adds it to the shell profile. |
| `mesh version` | `mesh 0.2.3 (build 65dcbec)`. The live `mesh-version.json` names the same build; npm has `@harrym1707/mesh` and `@harrym1707/sdk` at 0.2.3 and `@harrym1707/verify` at 0.1.0. |
| `mesh doctor` | Node, runtime `cached 65dcbec`, Claude Code wiring, service and ledger all reported; `Looks healthy.` |
| `mesh proxy --port 18787 --anthropic-base <stand-in>` | Starts; prints the two `connect` lines, `claude left alone`, Theo at `autonomy: recommend`. |
| `curl http://127.0.0.1:18787/mesh/health` | `{"status":"ok","service":"mesh-proxy"}` |
| One `POST /v1/messages` with a made-up key | 200. The stand-in received `x-api-key` verbatim. The window printed `1 request seen` with `nothing to bill yet — do not pay us`. |
| A second `mesh proxy` on the same port | `MESH is already running on port 18787 …`, and it names a free port. |
| `mesh verify` | Four checks pass, including `cached runtime matches its download checksum`; `All checks passed.` |
| `mesh status` | `1 requests seen · … (do_not_charge)`. It still reports `proxy not responding` for a proxy on a port other than 8787. |
| Published `@harrym1707/verify@0.1.0` on `~/.mesh/ledger/proxy-anthropic.jsonl` | `chain verified: 1 record(s), every hash links`, the same verdict and figure as `mesh verify`. |
| Ctrl+C on the proxy | `session done: 1 request …` and exit. |
| `mesh start` in the same throwaway home | Writes `ANTHROPIC_BASE_URL` into `~/.claude/settings.json`; Ctrl+C prints `Claude Code restored.` and the file is gone again (there was none before). |
| `mesh restore` afterwards | `Nothing to repair`. |

**Read, not run:** both command tables in `packages/cli/src/main.ts` and
`mesh-runtime.ts` on `main` at `51bee22` list every command the tester guide
names, and every message the guide quotes is in the code. Since the guide was
written, the only change under `packages/cli/src` and in the proxy is to
`theo.ts` (0.2.3: Theo keeps a lever added by hand).

**Not checked:** a real provider, real traffic, Claude Code driving the
proxy, the OpenAI-style path, `mesh dashboard`, `mesh install`, Linux, and
Windows under WSL.

