# Scout: frictionless-local-deploy

_Area: zero-config local onboarding for `mesh run` / `mesh init` — single-command
installers, sidecar proxies, `x run`-style wrappers, auto-detecting a project's
stack and wiring itself in. Scouted 2026-10-29. MESH license is BUSL-1.1, so MIT/
Apache deps are fine; GPL is a problem._

## Context: where MESH is today
- `evals/mesh-run.ts` already implements the Doppler/Infisical `run -- <cmd>`
  pattern: boot proxy on a free port, set `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`,
  spawn the child, print recomputed savings on exit. The onboarding *shape* is
  right; the gaps are (a) no `mesh init` that detects a stack and writes config,
  (b) distribution is only `npx -p @harrym1707/sdk mesh-proxy`, (c) no config file.

## Ranked findings

### 1. package-manager-detector (antfu-collective) — **adopt-as-dep**
- https://github.com/antfu-collective/package-manager-detector
- MIT. ~172★ direct, but it is the detection engine inside `@antfu/ni` (~22k★)
  and is actively maintained — safe, battle-tested.
- Pure-TS, zero-dep. `detect()` walks up from cwd checking lockfiles →
  `packageManager` field → `devEngines.packageManager`; `resolveCommand(agent,
  'run', ['dev'])` returns `{command, args}` for npm/yarn/pnpm/bun/deno.
- **Borrow:** depend on it directly. `mesh init` calls `detect()` to learn the
  project's PM; `mesh run` with no explicit command calls `resolveCommand(pm,
  'run', ['dev'])` so `mesh run` alone Just Works instead of forcing
  `mesh run -- npm run dev`. Tiny, exact fit, license clean.

### 2. Infisical CLI (Infisical/infisical) — **copy-pattern**
- https://github.com/Infisical/infisical
- MIT (core; `ee/` dirs are separately licensed — avoid those). ~30k★, very active.
- `infisical init` writes a project config file linking the dir to a workspace;
  `infisical run -- npm start` injects secrets as env vars into the subprocess at
  launch. This is precisely MESH's `mesh run` model, proven at scale.
- **Borrow:** the two-command UX split — `init` (persist a per-project
  `.mesh/config` so later runs need no flags: ledger dir, cache-ttl, provider)
  and `run` (stateless, reads that config). Also their pre-commit-hook install
  flow is a model for "wire itself into the project" without manual edits.

### 3. supabase/cli (supabase) — **copy-pattern**
- https://github.com/supabase/cli
- MIT. ~2.4k★, extremely active.
- `supabase init` scaffolds a `config.toml` + project dir; `supabase start` brings
  up the whole local stack from that config. Distributed via npm/brew/scoop/
  `curl … | bash` + DEB/RPM/APK from GitHub Releases — the full "install and it
  just works" matrix on every OS.
- **Borrow:** (a) the `config.toml` convention — a single declarative file
  `mesh init` writes and `mesh run` reads, versionable in the repo; (b) the
  multi-channel install story. MESH ships only `npx` today; copying the brew
  formula + `curl | bash` + Releases-binary pattern is the cheapest way to make
  the hosted-gateway Phase-2 install "change one base URL" land on any machine.

### 4. ngrok-go (ngrok) — **study-only**
- https://github.com/ngrok/ngrok-go
- Permissive (MIT/Apache family — verify before vendoring). Maintained by ngrok.
- Embeds secure ingress as a single `net.Listener`: one line turns a local process
  into a publicly reachable endpoint, no ports/certs/LB. Go, not TS.
- **Borrow (architecture idea, not code):** the model for Phase-2 — a MESH agent
  that dials out to `gw.mesh-technology.com` and exposes the blind gateway without the
  user opening ports or provisioning TLS. The "one line / one listener" ergonomics
  is the north star for how invisible the hosted hop should feel. Language
  mismatch (Go) means pattern, not dependency.

### 5. Tilt (tilt-dev) — **study-only**
- https://github.com/tilt-dev/tilt
- Apache-2.0. ~10.1k★.
- "Dev environment as code": a `Tiltfile` (Starlark) declares services; the engine
  does smart rebuilds + `live_update` into running containers in seconds.
- **Borrow:** the dev-env-as-code framing and the live-reload loop — if MESH grows
  a long-running `mesh run` dashboard, Tilt's "edit → rebuild only what changed →
  reflect instantly" UX is the reference. K8s/microservice focus makes it
  study-only for us, not a dependency.

## Rejected / not pursued
- **Dagger** (Apache-2.0, ~16.5k★, https://github.com/dagger/dagger) — strong
  local-first containerized pipeline engine, but it is CI/CD orchestration, not
  onboarding. No clean fit for `mesh init`/`mesh run`; revisit only if MESH needs
  reproducible eval pipelines.

## Net recommendation for MESH
Depend on **package-manager-detector** now (smallest, exact). Adopt the
**Infisical `init`+`run`** two-command split and a **supabase-style `config.toml`**
so `mesh run` needs no flags after `mesh init`. Treat **ngrok-go** as the
Phase-2 ingress blueprint. All proposed deps are MIT/permissive — clean against
BUSL-1.1.
