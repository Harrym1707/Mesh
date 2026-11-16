#!/usr/bin/env bash
# Records REAL tool outputs for the agent-task harness (lab/agent-tasks.ts).
#
# Everything here comes from this repository, its own built website, or its own
# public GitHub metadata. No customer content, no prompts, no provider calls.
# Absolute paths are normalised so the corpus does not carry a home directory.
#
# Run from anywhere inside the repository:  bash lab/agent-tasks/capture.sh
# It needs dependencies installed (corepack pnpm install) and network access for
# the three GitHub API responses. Re-running overwrites the corpus; the figures
# in lab:tasks then change with it, because they are measured on these files.
#
# `bash lab/agent-tasks/capture.sh api` records only the three API responses
# (GitHub allows 60 unauthenticated requests an hour from one address).
set -u
MODE=${1:-all}
ROOT=$(git rev-parse --show-toplevel)
OUT="$ROOT/lab/agent-tasks/corpus"
SOURCE=packages/core/src/tool-schema.ts
mkdir -p "$OUT"
cd "$ROOT" || exit 1

norm() { sed -e "s#$ROOT#/workspace/mesh#g" -e "s#$HOME#/home/dev#g"; }

capture_api() {
  API=https://api.github.com/repos/Harrym1707/Mesh
  curl -fsS "$API/pulls?state=all&per_page=3" > "$OUT/gh-pulls.json"
  curl -fsS "$API/commits/ca73b64/check-runs?per_page=30" > "$OUT/gh-check-runs.json"
  curl -fsS "$API/branches?per_page=40" > "$OUT/gh-branches.json"
}
if [ "$MODE" = api ]; then capture_api; wc -c "$OUT"/gh-*.json; exit 0; fi

# ---- repo exploration: what Grep / Glob / Read / git return ------------------
git log -12 --stat --date=short --format='commit %h %ad%n    %s%n' > "$OUT/git-log-stat.txt"
find lab packages/core/src packages/sdk-js/src -type f -name '*.ts' | sort > "$OUT/find-ts.txt"
grep -rn "cacheTtl" packages/sdk-js/src packages/cli/src --include='*.ts' > "$OUT/grep-cachettl.txt"
grep -rn "approximateTokenCount" packages/core/src packages/sdk-js/src lab --include='*.ts' > "$OUT/grep-tokencount.txt"
cat -n "$SOURCE" > "$OUT/read-tool-schema.txt"
# The same file as it was before the $defs fix: what the agent read first.
git show b52a3cf:"$SOURCE" | cat -n > "$OUT/read-tool-schema-before.txt"
cat -n packages/sdk-js/src/cache-volatility-guard.ts > "$OUT/read-guard.txt"
cat -n packages/core/src/tool-schema.test.ts | head -230 > "$OUT/read-tool-schema-test.txt"
git diff b52a3cf 73dcdfe -- "$SOURCE" > "$OUT/git-diff-fix.txt"

# ---- test and build logs, as a non-interactive shell tool captures them ------
npx vitest run packages/core/src/tool-schema.test.ts --reporter=verbose 2>&1 | norm > "$OUT/vitest-pass-verbose.txt"
npx vitest run packages/core 2>&1 | norm > "$OUT/vitest-core-default.txt"
# The same tests against the source as it was before the $defs fix: a real
# failing run. The file is restored from git straight afterwards.
git show b52a3cf:"$SOURCE" > "$SOURCE"
npx vitest run packages/core/src/tool-schema.test.ts 2>&1 | norm > "$OUT/vitest-fail.txt"
git checkout -- "$SOURCE"
npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck \
  lab/agent-tasks/broken-example.ts 2>&1 | norm > "$OUT/tsc-errors.txt"
corepack pnpm install --frozen-lockfile 2>&1 | norm > "$OUT/pnpm-install.txt"
corepack pnpm build:cli 2>&1 | norm > "$OUT/build-cli.txt"
git checkout -- docs/site/dist 2>/dev/null
# The same verbose run inside a pseudo-terminal, which is what a tool that runs
# commands in a pty captures: colour codes, cursor movement, redrawn lines.
python3 -c 'import pty; pty.spawn(["npx", "vitest", "run", "packages/core/src/tool-schema.test.ts", "--reporter=verbose"])' \
  < /dev/null 2>/dev/null | norm > "$OUT/vitest-pass-verbose-pty.txt"

# ---- API responses: what a GitHub tool returns --------------------------------
capture_api

# ---- web pages: what a fetch tool returns for the project's own site ----------
cp docs/site/dist/faq.html "$OUT/web-faq.html"
cp docs/site/dist/start.html "$OUT/web-start.html"
cp docs/site/dist/methodology.html "$OUT/web-methodology.html"

wc -c "$OUT"/* | sort -n
