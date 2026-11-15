# Reconcile Theo coverage with the Mesh→Mesh rebrand

**Status:** coordination note for the `rename/mesh-to-mesh` branch. Delete once reconciled.
**Date:** 2026-11-04

`main` advanced past where `rename/mesh-to-mesh` was cut. On 2026-11-04, Theo
lever-coverage work landed on `main` and was deployed. The rebrand branch has
**none** of it, and both branches touched the same files — so reconcile before
merging. This is name-only on the rebrand side; the coverage code is logic that
just needs to come along renamed. Nothing about the product or Theo changes.

## What landed on main (feature work, unrelated to the name)

- `6ff7ec0` — feat: Theo coverage oracle + dashboard/status coverage
- `e450f64` — build: dist rebuild shipping it (deployed to the old domain)

## New files (not on the branch — the codemod never saw them)

- `packages/core/src/theo-coverage.ts`
- `packages/core/src/theo-coverage.test.ts`
- `scripts/theo-coverage-demo.ts`

## Files with coverage additions (will conflict — keep BOTH the rename and the additions)

- `packages/sdk-js/src/theo-policy.ts` — adds `policyCoverage`, `ENFORCEABLE_LEVERS`
- `packages/sdk-js/src/theo-policy.test.ts`
- `packages/cli/src/start.ts` — adds exported `readPolicy()`
- `packages/cli/src/dashboard.ts` — coverage headline + meter + "not yet adopted"
- `packages/cli/src/daemon.ts` — coverage line in `mesh status`
- `packages/core/src/index.ts` — exports `theo-coverage`
- `package.json` — adds the `demo:theo-coverage` script

## Steps

1. Merge (or rebase) `main` into `rename/mesh-to-mesh`.
2. Resolve conflicts keeping **both** sides — the Mesh naming **and** the coverage
   logic. Conflicts are naming-level only; no logic changed.
3. Re-run the Mesh→Mesh codemod over the arrived coverage files. The only **new**
   Mesh string they introduced is a comment `` `mesh analyse` `` in
   `theo-coverage-demo.ts`; everything else (`MESH_HOME`→`MESH_HOME`,
   `~/.mesh`→`~/.mesh`) is the existing rename rules applied to new usages.
   - Names that are **not** Mesh refs and must stay: `policyCoverage`,
     `coverageForProfile`, `ENFORCEABLE_LEVERS`, `readPolicy`, the
     `demo:theo-coverage` script, and `Theo`.
4. Regenerate `docs/site/dist/**`.
5. Run the tests (`sdk-js` + `cli` + `core`) — all green before landing.

Doing it in this order means the rebrand absorbs coverage cleanly. Landing the
rebrand without this would either clobber the coverage work or ship half-renamed
code (which breaks the "clean break, no `MESH_` aliases" decision).
