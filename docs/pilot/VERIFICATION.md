# Happy-path verification — VERIFIED / BROKEN

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
