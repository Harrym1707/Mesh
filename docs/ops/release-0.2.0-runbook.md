# Release 0.2.0 runbook — the first public build with Theo

Staged 2026-11-12 on `theo/autonomous-agent`. It reaches `main` through
**PR #40** (opened 2026-11-15), in one merge. **Nothing has been merged
to `main`, deployed or published.** Every step below that changes what the
public gets is the founder's to take.

## Update 2026-11-16 (night): release 0.2.3, Theo keeps hand-added levers, hosted runtime `a2d2d87`

Written on branch `release/0.2.3`. **Not merged, not deployed, not published.**
The sections below describe 0.2.2 and earlier as they stood.

- **Where things stand.** Release 0.2.2 is out on both channels: the website
  serves build `d83ee89` and npm has both packages at 0.2.2 (tag `v0.2.2` at
  `e620dd4`). After that tag, `main` gained one change, PR #50; this branch
  starts from `main` at `0fc1bf5`.
- **The defect in 0.2.2.** Theo's policy lives in his own memory. `mesh start`,
  `mesh proxy` and the installed service run him with apply on, at startup and
  every 15 minutes, and once the ledger has any traffic each cycle writes that
  policy over `~/.mesh/theo-policy.json`. A lever a user added there by hand
  was dropped, with no message. So the opt-in `tool-result-json-compaction`
  lever, turned on through the policy file, stopped working after one cycle.
  The SDK option was never affected. Every earlier build with a background
  Theo behaves the same way for any hand-added lever.
- **What 0.2.3 changes.** When Theo's policy is written, every lever in the
  policy it replaces is kept unless Theo authors that lever himself. His own
  six follow his policy, so a lever he rolled back stays out. An operator's
  lever gives way to one of Theo's from the same either-or group. A new route
  starts with the default's hand-added levers. A kept lossy lever is still
  withheld without a proof inside the ceiling. `mesh theo --accept` and
  `--apply` print which levers they kept. Nothing else changed.
- **What changes for a user who added nothing by hand.** Nothing.
- **Not changed.** A default lever a user removed by hand comes back on
  Theo's next write. A lever from Theo's own six added by hand does not last.
- **Version.** Both packages are 0.2.3 (`a2d2d87`).
- **The hosted runtime** is rebuilt at `a2d2d87`, from a clean worktree.
  Manifest: build `a2d2d87`, sha256
  `ac00322344f99005f45055880d378b4c9813419cfeca8527da97c5f5086b397b`. Only
  `mesh-runtime` and `mesh-version.json` changed in `docs/site/dist`.
- **Checked on the built artifact** (2026-11-16, macOS arm64, Node 24):
  - `mesh proxy` from the built runtime with **Theo running** (2-second
    interval), in an empty home, against a stand-in provider, with
    `tool-result-json-compaction` added to the policy file by hand. First
    request: a 21,922-character JSON tool result forwarded at 15,694. Theo's
    cycle then rewrote the file, and the lever was still in it. Next request:
    forwarded at 15,694. The same run on the 0.2.2 runtime loses the lever at
    Theo's cycle and forwards the next request at 21,922.
  - With the default policy the same result is forwarded byte-identical (this
    run had Theo off).
  - A clean install from the rebuilt `docs/site/dist` into an empty home gives
    `mesh 0.2.3 (build a2d2d87)`; `mesh verify` passes.
  - A copy installed from the live site (`mesh 0.2.2 (build d83ee89)`) updates
    itself to `a2d2d87` with `mesh update`; `mesh verify` passes after it.
  - The release workflow's steps short of publishing: `pnpm build`, 1,050
    tests in 70 files at default timeouts, the SDK package and its smoke test,
    the CLI package and its two smoke tests. Both built packages say 0.2.3.
  - Not checked: any real provider; Theo at his default 15-minute interval
    (the 2-second interval runs the same code); Linux and Windows locally;
    `mesh update --rollback` on this build.
- **To release 0.2.3** (each step is the founder's):
  1. Merge this branch's pull request into `main` with **"Create a merge
     commit"** (the runtime is stamped with `a2d2d87`, which a squash or
     rebase would remove from `main`). `pages.yml` then deploys the site, and
     installed copies update within 24 hours.
  2. Push the tag `v0.2.3` from `main`. That publishes both npm packages.
  3. In the checks below expect `"version": "a2d2d87"` and the sha256 above.
- **A user on 0.2.2 who already lost the lever** has to add it to the policy
  file once more after updating. The update cannot know it was there.

## Update 2026-11-16 (evening): release 0.2.2, the opt-in JSON tool-result lever, hosted runtime `d83ee89`

Written on branch `release/0.2.2`. **Not merged, not deployed, not published.**
The sections below describe 0.2.1 and 0.2.0 as they stood.

- **Where things stand.** Release 0.2.1 is out on both channels: the website
  serves build `5738486` and npm has both packages at 0.2.1 (tag `v0.2.1` at
  `150558c`). After that tag, `main` gained PR #48 (with PR #47) and PR #46;
  this branch starts from `main` at `0e16e2a`.
- **What 0.2.2 adds.**
  - A new lever, `tool-result-json-compaction` (SDK option `toolResultJson`).
    It removes the whitespace between JSON tokens in tool results that are, as
    a whole, one JSON object or array. Every key, string and number is kept as
    written. **It is off by default** and Theo does not adopt it: a user adds
    it to `~/.mesh/theo-policy.json` or passes the SDK option. See
    `docs/guide/configure.md` for how, and for when not to.
  - `minifyJsonBlocks` in `packages/core` no longer rewrites numbers. No
    product path calls it.
  - Lab-only files under `lab/` (PR #46). They are not in the runtime or the
    npm packages.
- **What changes for a user who turns nothing on.** The coverage line that
  `mesh status` prints counts 13 levers instead of 12, so a default policy
  reads "3/13 enforceable levers (23%)" where it read 3/12 (25%). Theo's
  report and the dashboard use the same count. Nothing else.
- **Known limit, shipped as it is.** `mesh theo --apply` writes Theo's policy
  over the default one in `~/.mesh/theo-policy.json`
  (`mergePolicyIntoBundle`). A lever a user added by hand, this one included,
  is not carried over, and nothing tells them. A tester who turns the lever on
  and later applies a Theo proposal has to add it again.
  `docs/guide/configure.md` says so. Read from the code; not changed in 0.2.2.
  **Correction, 2026-11-16 (after release):** this understated it. The same
  write happens on every background Theo cycle, which `mesh start`,
  `mesh proxy` and the installed service run by default (at startup and
  every 15 minutes, once the ledger has any traffic). Reproduced on the
  shipped runtime `d83ee89` with a 2-second interval: the lever was in the
  file, the first request was compacted, Theo's next cycle rewrote the file
  without it, and the next request was forwarded uncompacted. So on 0.2.2
  the policy-file way of turning the lever on does not last unless the
  proxy runs with `--no-theo`. The SDK option is not affected. Fixed on the
  branch `fix/theo-apply-keeps-levers`; it needs a later build to reach
  users.
- **Version.** Both packages are 0.2.2 (`d83ee89`), because `v0.2.1` points at
  a commit without the lever and npm will not publish a version twice.
- **The hosted runtime** is rebuilt at `d83ee89`, from a clean worktree.
  Manifest: build `d83ee89`, sha256
  `7ef1c723a3467acff6aa76f894697eebcbd6f43564c17b249076968395481957`. Only
  `mesh-runtime` and `mesh-version.json` changed in `docs/site/dist`.
- **Checked on the built artifact** (2026-11-16, macOS arm64, Node 24):
  - A clean install from the rebuilt `docs/site/dist` into an empty home gives
    `mesh 0.2.2 (build d83ee89)`; `mesh verify` passes.
  - A copy installed from the live site (`mesh 0.2.1 (build 5738486)`) updates
    itself to `d83ee89` with `mesh update`; `mesh verify` passes after it.
  - `mesh proxy` from the built runtime, in an empty home, against a stand-in
    provider: with the default policy a 21,922-character JSON tool result is
    forwarded byte-identical. After the lever is added to the policy file,
    with the proxy still running, the same result is forwarded at 15,694
    characters, parses to the same document, and the rest of the request is
    unchanged.
  - The release workflow's steps short of publishing: `pnpm build`, 1,035
    tests in 69 files at default timeouts, the SDK package and its smoke test,
    the CLI package and its two smoke tests. Both built packages say 0.2.2.
  - Not checked: any real provider; any model's answers with the lever on;
    Linux and Windows locally; `mesh update --rollback` on this build.
- **To release 0.2.2** (each step is the founder's):
  1. Merge this branch's pull request into `main` with **"Create a merge
     commit"** (the runtime is stamped with `d83ee89`, which a squash or
     rebase would remove from `main`). `pages.yml` then deploys the site, and
     installed copies update within 24 hours.
  2. Push the tag `v0.2.2` from `main`. That publishes both npm packages. The
     trusted publisher was validated by the 0.2.1 publish; nothing needs
     setting up again.
  3. In the checks below expect `"version": "d83ee89"` and the sha256 above.
     `npx -y @harrym1707/mesh version` prints the tagged commit as its build,
     not `d83ee89`; that is the same source.

## Update 2026-11-16 (later): release 0.2.1, the integration pathway, hosted runtime `5738486`

Written on branch `integration/tester-pathway`. **Not merged, not deployed, not
published.** The sections below still describe 0.2.0.

- **Where things stand.** `main` is `ca73b64` (PR #44) and the website serves
  build `73dcdfe`. The tag `v0.2.0` was pushed at `ca73b64` on the founder's
  word. Its release run failed twice and **published nothing**:
  1. First attempt: `pnpm test` failed on a timing race in
     `packages/cli/src/start-theo.test.ts` (fixed on this branch, `47a3474`).
  2. Re-run: tests passed; `npm publish` was refused with
     `403 ... OIDC permission denied for this action`.
- **Why npm refused.** A trusted publisher created on npmjs.com after
  2026-09-03 allows only `npm stage publish` unless "npm publish" is ticked
  under **Allowed actions** (npm docs, "Trusted publishing", read 2026-11-16).
  The repository, workflow and user fields matched, or the error would have
  been an authentication failure. A connection cannot be edited: delete it and
  create it again with **npm publish** ticked, for both `@harrym1707/sdk` and
  `@harrym1707/mesh`. A new connection must complete its first publish within
  2 days or it expires.
- **What this branch fixes.** Found by driving the proxy with the real
  Anthropic and OpenAI client libraries (TypeScript and Python) and the Claude
  Code command-line tool, against a stand-in provider:
  - Any POST other than the three generation endpoints got MESH's own 404:
    token counting, embeddings, batches, file uploads, deletes. They are now
    forwarded unchanged (`1c91349`).
  - Passthrough requests picked the provider from `x-api-key` alone. Current
    Anthropic SDKs and a Claude subscription login send a bearer token, so
    their `GET /v1/models` went to the OpenAI upstream carrying an Anthropic
    credential. Build `73dcdfe` and every earlier build have this.
  - The query string (`?beta=true`) was dropped; an untouched request was
    re-serialised (`1.0` became `1`); an unreadable body got MESH's 400.
  - New: `mesh proxy` (MESH in front of any app, Claude Code left alone),
    `GET /mesh/health`, and a taken port now says what to do.
- **Version.** Both packages are 0.2.1, because `v0.2.0` points at a commit
  without these fixes and npm will not publish a version twice.
- **An independent review** of the passthrough (a separate agent, against
  stub upstreams) found eight more defects, all fixed in `5738486` with a test
  each: `Expect: 100-continue` uploads got a 502 (curl sends it for every body
  over 1 MB); a request naming no provider was forwarded on a guess; redirects
  were followed inside the proxy, carrying `x-api-key` to the target; a
  response that broke off upstream looked complete; `HEAD /mesh/health`
  reached the provider; localhost cookies were forwarded; a streamed upload
  lost its `Content-Length`; three wrong cases in the taken-port message.
- **The hosted runtime** is rebuilt at `5738486`. Manifest: build `5738486`,
  sha256 `fe15e886695cfc27f4ff2e589c8877fb98de9f604bc0120b5d6d426f9c39f8ae`.
- **Checked on the built artifact** (2026-11-16, macOS arm64, Node 24): a
  clean install from the rebuilt `docs/site/dist` into an empty home gives
  `mesh 0.2.1 (build 5738486)`; `mesh verify` passes; `mesh proxy` answers its
  health check; the official Python SDKs (anthropic 2.8.0, openai 3.51.0),
  configured only through `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, pass 9 of
  9 calls; a second copy on the same port prints the "already running"
  sentence; `mesh status` and `mesh verify` read the resulting ledger.
  A copy installed from the live site (`73dcdfe`) updates itself to
  `5738486`; the real Claude Code tool completes a turn through `mesh start`
  and its settings are restored on exit; a 2.2 MB `curl` POST returns 200.
  `corepack pnpm test`: 1002 passed. No real provider was called.
- **To release 0.2.1** (each step is the founder's):
  1. Merge this branch's pull request into `main` with a merge commit. The
     website then serves build `5738486` and installed copies update within
     24 hours.
  2. On npmjs.com, recreate the trusted publisher for both packages with
     **npm publish** allowed.
  3. Push the tag `v0.2.1` from `main`. Do not re-run the `v0.2.0` release:
     it would publish the build without these fixes.
  4. The public one-line command `npx -y -p @harrym1707/sdk mesh-proxy`
     installs sdk 0.1.1 (2026-11-05) until step 3 succeeds.
- **For testers:** `docs/pilot/TESTER-GUIDE.md` (draft, not sent).

## Update 2026-11-16: tool-schema fix, hosted runtime `73dcdfe`

Written after the release was merged; the sections below are as they stood
before the merge and still name build `df70f3f`.

- **Where things stand.** PR #40 was merged on 2026-11-15 (`main` `0f64c08`)
  and the website serves build `df70f3f`. npm is not published. The Token
  Engineering Lab (PR #33) and a test time limit (PR #41) are on `main` too;
  neither changed the website.
- **The bug.** The default-on `tool-schema-compaction` lever removed `$defs`
  from tool schemas, leaving every `$ref` into it pointing at nothing. It also
  removed parameters that were named `$id`, `$schema` or `$comment`, and
  stripped those keys from `default`, `const`, `enum` and `examples` data.
  Build `df70f3f` has it, and so does the code on `main` up to `b52a3cf`.
- **The fix.** Commit `73dcdfe`. `$defs` is never removed; the keys of
  `properties` and the other name-to-schema maps are treated as names; data
  values are copied through untouched; `$id` is kept on any tool that uses a
  reference. Nothing else about the lever changed.
- **The hosted runtime** is rebuilt at `73dcdfe` (commit `1a70246`). Manifest:
  build `73dcdfe`, sha256
  `0c75411453dcff5f1c9851a89c99eab9234029e8ae95ee2bde17b0e00c79090e`. It is
  also the first hosted build made from a tree that contains everything on
  `main`, including the Lab's unused `minifyJsonBlocks`.
- **Checked on 2026-11-16 (macOS arm64, Node 24).** 971 tests in 67 files at
  default timeouts; `tsc -b` and `typecheck:lab`; the CLI package and its two
  smoke tests. One request with a nested-model tool sent through each built
  runtime to a stand-in provider: build `df70f3f` forwards it without `$defs`,
  build `73dcdfe` forwards the schema exactly as the client sent it. Not
  checked: any real provider, so what a provider does with the dangling
  reference is still unknown; the upgrade and rollback on this build.
- **To ship it.** Merge the pull request that carries these commits with
  **"Create a merge commit"** (the runtime is stamped with `73dcdfe`, which a
  squash or rebase would remove from `main`). `pages.yml` then deploys by
  itself. In step 2 below expect `"version": "73dcdfe"`, the sha256 above and
  `mesh 0.2.0 (build 73dcdfe)`. Cut the `v0.2.0` tag (step 3) only after that.

## What is staged

| Item | State |
|---|---|
| Version | `@harrym1707/mesh` 0.1.0 → **0.2.0**, `@harrym1707/sdk` 0.1.1 → **0.2.0** (commit `9a71697`). npm already holds 0.1.0 and 0.1.1, so neither could be published again without a bump. |
| Website runtime | `docs/site/dist` rebuilt at `df70f3f` (commit `f1ed77a`, 2026-11-15). Manifest: build `df70f3f`, sha256 `764b0bc3…890b08b7`. It replaces builds `d92a92c` and `b5dff02`; the code changes since `d92a92c` are the two fixes below. |
| Shutdown fix | `df70f3f`. `mesh start` registered its Ctrl+C, terminate and closed-terminal handlers only after it had written Claude Code's settings, so a signal in the first moments killed it with Claude Code still pointed at the proxy. The handlers are now registered first. Found by CI on PR #40, where one settings test failed on a slow runner. Signalled the instant the settings file appears, build `b5dff02` leaves the file behind 10 times in 10 and build `df70f3f` 0 in 10. |
| Cache guard fix | `b5dff02`, brought over from PR #33 on 2026-11-15 at the founder's request. When a workload has the cache flag set, Mesh now decides the cache marker on tools + system and the one on the newest message separately, so a stable system prompt keeps its marker when the client rewrites its history. It only changes where cache markers go; a test checks the request is otherwise identical. Workloads without the cache flag are unaffected. |
| Website pages | Two new pages, `terms.html` and `privacy.html`, which carry the registered office address since 2026-11-15 (a pages-only rebuild that left the runtime as it was). Every other page changes in its footer only: the company line is gone and links to Terms and Privacy are added. No other copy changed. |
| Merge into `main` | Dry-run clean (`git merge-tree`) at `main` `938cfbb`, repeated on 2026-11-15 at `2060fbd`. The merged tree differs from this branch only by traffic-snapshot files, so the staged runtime is the build `main` would produce. |

Live today, for comparison: the website serves build `c8378ea` (2026-11-04);
npm `latest` is `mesh` 0.1.0 and `sdk` 0.1.1, both founder-published on
2026-11-05 without provenance.

## What was checked on the staged build (2026-11-12, macOS arm64, Node 24)

- `pnpm build`, `pnpm test` (866 tests, 65 files, at the first staging), SDK package build and its
  cold-install smoke test, CLI package build with both smoke tests: the same
  steps `release.yml` runs, in the same order. 881 tests at `d92a92c`.
- **Repeated at `b5dff02` on 2026-11-15:** `pnpm build`, `pnpm test` (886 tests,
  66 files), the SDK package and its cold-install smoke test, the CLI package
  with both smoke tests, and the install below. The Claude Code wiring and
  upgrade checks were not repeated; the fix touches two SDK source files and
  none of that code.
- **Repeated at `df70f3f` on 2026-11-15:** `pnpm build`, `pnpm test` (888 tests,
  66 files), the CLI package with both smoke tests, the install below, and
  the signal check described under "Shutdown fix" for Ctrl+C, terminate and a
  closed terminal. The upgrade and rollback check was not repeated.
- `curl … | sh` from a local copy of the staged site into a clean home
  directory, then `mesh version` (0.2.0, build `d92a92c`; `b5dff02` and then
  `df70f3f` on 2026-11-15) and `mesh verify`.
- **Claude Code wiring**, on the installed build: a new user who closes the
  terminal running `mesh start` is left with no settings file; after
  `kill -9`, `mesh doctor` fails and names the fix, and `mesh restore` repairs
  it.
- On the first staged build `9a71697` (before the statement text and the
  Claude Code wiring fix changed): `mesh theo --help`, the npm tarball
  through `npx`, and a full `mesh start` session against a stand-in
  provider: three requests proxied, ledger written and verified, Theo ran four
  cycles in `recommend` mode and left the lossless default policy in place.
- **Upgrade**: installed today's live build (`c8378ea`), switched the site to
  the staged one, `mesh update` moved to `d92a92c`.
  `mesh update --rollback` returned to `c8378ea`.

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

- [ ] **CI is green on PR #40** at the branch head (`ci`, `install-smoke`).
      At `1f6f233` the 9 checks on PR #31 passed, and on PR #40 one `test`
      run failed on the shutdown race fixed in `df70f3f`. Read them again at
      the current head.
- [ ] **npm trusted publishing is set up for both packages.** On npmjs.com, for
      `@harrym1707/sdk` and `@harrym1707/mesh`: Settings → Trusted Publisher →
      GitHub Actions, repository `Harrym1707/Mesh`, workflow `release.yml`.
      Earlier versions were published by hand, so this may never have been
      done. Without it the tag workflow fails at the publish step and nothing
      is published.
- [ ] **Read the Terms and the Privacy policy** (`docs/site/terms.md`,
      `docs/site/privacy.md`). They are a first draft written without a lawyer.
      Three things in them are decisions, not wording:
      1. The Terms grant anyone who accepts them the right to run Mesh in
         production for their own use.
      2. Liability is capped at the greater of fees paid in 12 months and £100.
      3. No fee is due unless billing was agreed in writing.
- [ ] **The IP assignment — deferred by the founder on 2026-11-15, not a
      merge condition.** `LICENSE` and the Terms name Flux AI Technologies
      Limited as licensor and copyright holder (the founder's decision on
      2026-11-12). That becomes true only when the founder signs the deed
      assigning the work to the company; until then he owns it personally. He
      chose to release first and sign later, since there are no users yet. A
      draft is in his private project folder, not in this repository. Sign it
      before any investment, sale, paid contract or attempt to enforce the
      licence.
- [x] **Registered office address is on both pages** (added 2026-11-15, as
      supplied by the founder and matching the Companies House register read
      the same day). A UK company's website must show its registered name,
      number, place of registration and registered office address; all four
      are now on the legal pages, and the site build fails if any is missing.
- [ ] **Add a contact email to both pages.** The pages give the postal
      address only. A business selling online is expected to publish an email
      address, so add one before taking paying customers.
- [ ] **You accept going public without a DPA.** The architecture keeps
      prompts off our systems, which answers most of what a DPA covers, but a
      business customer may still ask for one.
- [ ] **No commits since staging that change product code.** If there are, redo
      "Rebuild the site" below before merging.

## Steps

### 1. Merge the code

Merge **PR #40** (`theo/autonomous-agent` → `main`) with **"Create a merge
commit"**. Do not squash or rebase: the hosted runtime is stamped with commit
`df70f3f`, and either would remove that commit from `main`'s history.

PR #40 carries everything in one merge: `integration/trunk` is an ancestor of
the release branch, so the 73 commits are the same ones the older two-step
route (PR #31 into trunk, then PR #27 into `main`) would have delivered. Use
this route only. Afterwards PR #27 should show as merged on its own, because
its commits are then on `main`; close PR #31 by hand.

Merging changes `docs/site/dist` on `main`, so `pages.yml` starts the website
deploy by itself.

### 2. Confirm the website

Wait for the "Deploy site to GitHub Pages" run to finish, then:

```bash
curl -fsS https://www.mesh-technology.com/mesh-version.json
```

It should show `"version": "df70f3f"` and the sha256 above. Then install into a
throwaway home directory and check it:

```bash
export T=$(mktemp -d) && curl -fsSL https://www.mesh-technology.com/install.sh | HOME=$T sh && HOME=$T $T/.mesh/bin/mesh version && HOME=$T $T/.mesh/bin/mesh verify
```

Expect `mesh 0.2.0 (build df70f3f)` and "All checks passed".

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
`df70f3f`. That difference between the two channels is expected.

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
| The website runtime | On `main`, put back the three runtime files from before the merge and push: `git checkout 938cfbb -- docs/site/dist/mesh docs/site/dist/mesh-runtime docs/site/dist/mesh-version.json`, then commit. `pages.yml` redeploys build `c8378ea` and the new pages stay. Installed copies move back on their next check (the updater switches on any *different* version, not only a newer one). That automatic move back follows from the code and was not tested; the per-machine rollback below was. |
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
