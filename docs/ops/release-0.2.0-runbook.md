# Release 0.2.0 runbook — the first public build with Theo

Staged 2026-11-12 on `theo/autonomous-agent` (PR #31). **Nothing has been merged
to `main`, deployed or published.** Every step below that changes what the
public gets is the founder's to take.

## What is staged

| Item | State |
|---|---|
| Version | `@harrym1707/mesh` 0.1.0 → **0.2.0**, `@harrym1707/sdk` 0.1.1 → **0.2.0** (commit `9a71697`). npm already holds 0.1.0 and 0.1.1, so neither could be published again without a bump. |
| Website runtime | `docs/site/dist` rebuilt at `9a71697` (commit `4b97f1e`). Manifest: build `9a71697`, sha256 `1bf868dc…288c5394`. |
| Website pages | Unchanged. Every HTML page in `docs/site/dist` is byte-identical to `main`'s; only `mesh-runtime`, `mesh-version.json` and the sitemap dates differ. |
| Merge into `main` | Dry-run clean (`git merge-tree`) at `main` `938cfbb`. The merged tree differs from this branch only by two traffic-snapshot files, so the staged runtime is the build `main` would produce. |

Live today, for comparison: the website serves build `c8378ea` (2026-11-04);
npm `latest` is `mesh` 0.1.0 and `sdk` 0.1.1, both founder-published on
2026-11-05 without provenance.

## What was checked on the staged build (2026-11-12, macOS arm64, Node 24)

- `pnpm build`, `pnpm test` (866 tests, 65 files), SDK package build and its
  cold-install smoke test, CLI package build with both smoke tests: the same
  steps `release.yml` runs, in the same order.
- `curl … | sh` from a local copy of the staged site into a clean home
  directory, then `mesh version` (0.2.0, build `9a71697`), `mesh verify`,
  `mesh theo --help`.
- A full `mesh start` session with the installed build against a stand-in
  provider: three requests proxied, ledger written and verified, Theo ran four
  cycles in `recommend` mode and left the lossless default policy in place.
- **Upgrade**: installed today's live build (`c8378ea`), switched the site to
  the staged one, `mesh update` moved to `9a71697` and `mesh verify` passed.
  `mesh update --rollback` returned to `c8378ea`.
- **npm route**: `npm pack` of the CLI package, run through `npx` (`version`,
  `verify`).

Not checked: Linux and Windows (CI's `install-smoke.yml` covers them on the
PR), the launchd service (`mesh install`) on the staged build, and anything
against a real provider.

## What publishing does

1. **Website.** Once `docs/site/dist` reaches `main`, `pages.yml` deploys it.
   From then on every new install gets 0.2.0, and **every existing install
   moves to it on its own**: the launcher checks once every 24 hours and the
   background service every 6 hours.
2. **Theo becomes public.** 0.2.0 runs Theo beside `mesh start` and inside the
   background service, in `recommend` mode: lossless levers only, lossy levers
   only as proposals the user must accept. Theo has never run on real traffic.
3. **npm.** Pushing the tag `v0.2.0` runs `release.yml`, which rebuilds, tests
   and publishes both packages with provenance. An npm version cannot be
   reused or cleanly withdrawn.

## Before you start

- [ ] **CI is green on PR #31** at `4b97f1e` or later (`ci`, `install-smoke`).
- [ ] **npm trusted publishing is set up for both packages.** On npmjs.com, for
      `@harrym1707/sdk` and `@harrym1707/mesh`: Settings → Trusted Publisher →
      GitHub Actions, repository `Harrym1707/Mesh`, workflow `release.yml`.
      Earlier versions were published by hand, so this may never have been
      done. Without it the tag workflow fails at the publish step and nothing
      is published.
- [ ] **Company name in the site footer.** Every page says "Mesh AI
      Technologies Limited · company no. 17543982". This release does not
      change it, but confirm it is the registered name before drawing testers
      to the site.
- [ ] **You accept going public without Terms of Service or a DPA.** Opt-in
      capture writes prompt content to the user's own disk. A controlled pilot
      could cover that by agreement; a public installer cannot.
- [ ] **No commits since staging that change product code.** If there are, redo
      "Rebuild the site" below before merging.

## Steps

### 1. Merge the code

Use **"Create a merge commit"** for both. Do not squash: the hosted runtime is
stamped with commit `9a71697`, and squashing would remove that commit from
`main`'s history.

1. Merge **PR #31** (`theo/autonomous-agent` → `integration/trunk`).
2. Merge **PR #27** (`integration/trunk` → `main`). It now carries Theo too.

Merging #27 changes `docs/site/dist` on `main`, so `pages.yml` starts the
website deploy by itself.

### 2. Confirm the website

Wait for the "Deploy site to GitHub Pages" run to finish, then:

```bash
curl -fsS https://www.mesh-technology.com/mesh-version.json
```

It should show `"version": "9a71697"` and the sha256 above. Then install into a
throwaway home directory and check it:

```bash
export T=$(mktemp -d) && curl -fsSL https://www.mesh-technology.com/install.sh | HOME=$T sh && HOME=$T $T/.mesh/bin/mesh version && HOME=$T $T/.mesh/bin/mesh verify
```

Expect `mesh 0.2.0 (build 9a71697)` and "All checks passed".

### 3. Publish to npm

```bash
git fetch origin && git tag v0.2.0 origin/main && git push origin v0.2.0
```

Watch the `release` workflow. Then:

```bash
npm view @harrym1707/mesh version && npm view @harrym1707/sdk version
```

Both should print `0.2.0`. The npm runtime is rebuilt at the tag, so
`npx @harrym1707/mesh version` reports the tag's commit as its build, not
`9a71697`. That difference between the two channels is expected.

If trusted publishing is not set up and you would rather not set it up now,
the packages can be published by hand from a checkout of the tag, as 0.1.x
were: build as in "Rebuild the site" plus
`node --import tsx scripts/build-sdk-package.ts`, then `npm publish --access
public` in `packages/sdk-js/pkg` and in `packages/cli/pkg`. That gives up the
provenance attestation `SECURITY.md` promises from this release onward.

The workflow publishes the SDK first, then the CLI. If the SDK publishes and
the CLI step then fails, do not re-push the tag: 0.2.0 of the SDK is now taken.
Fix the cause, bump both packages to 0.2.1 and tag `v0.2.1`.

### 4. Tell testers

```bash
curl -fsSL https://www.mesh-technology.com/install.sh | sh
```

Then `mesh start` (or `mesh install` on macOS for always-on). Proposals are
listed with `mesh theo --proposals` and answered with
`mesh theo --accept <lever>` or `--reject <lever>`. Keep `--autonomy optimise`
off: the gate's quality graders have not been validated on real output.

## Rolling back

| What | How |
|---|---|
| The website runtime | On `main`: `git revert 4b97f1e` and push. `pages.yml` redeploys build `c8378ea`. Installed copies move back on their next check (the updater switches on any *different* version, not only a newer one). That automatic move back follows from the code and was not tested; the per-machine rollback below was. |
| One machine | `mesh update --rollback` |
| npm | A version cannot be reused. Point `latest` back and warn: `npm dist-tag add @harrym1707/mesh@0.1.0 latest` and `npm deprecate @harrym1707/mesh@0.2.0 "<reason>"` (same for the SDK with 0.1.1). |

Reverting the site does not undo the merge; the code stays on `main`.

## Rebuild the site (only if code changed after staging)

From the branch, with a clean working tree:

```bash
corepack pnpm install && corepack pnpm build && corepack pnpm test && corepack pnpm build:cli && node --import tsx scripts/build-site.ts
```

Commit `docs/site/dist`. The runtime is stamped with the commit it was built
at, so build first and commit the folder second; update the commit and sha256
quoted in this runbook.

## Not part of this release

- PR #34 (billing verification). It merges cleanly on top of this branch and
  touches no runtime code.
- `@harrym1707/verify`: `release.yml` does not publish it; it stays at 0.1.0.
- Release signing. The website channel still proves integrity (checksum from
  the same origin), not authenticity. See `docs/distribution/RELEASE-SIGNING.md`.
- `docs/site/start.md` still says "once `@harrym1707/mesh` is published"; the
  package has been on npm since 2026-11-05. Already live, not changed here.

## Known limits that ship in 0.2.0

- Theo has never run on real traffic; the drift window (200 requests) and
  threshold (5 points) are untuned.
- Theo keeps one policy per environment. Per-route work needs its own
  `--customer`; see `docs/rnd/theo-operating.md`.
- The background cycle rewrites the default route's policy from Theo's memory,
  so hand edits to `~/.mesh/theo-policy.json` on that route do not survive.
- The product does not phone home. Nothing tells you who installed or what
  they saved unless a tester shares their ledger.
