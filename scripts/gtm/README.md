# MESH GTM — GitHub-native ICP prospect finder

MESH's ideal customer is defined in code. Anyone who imports the LLM SDKs MESH
reduces — `anthropic` / `@anthropic-ai/sdk` / `openai` — and runs meaningful
traffic through them is a candidate. That makes GitHub's own code search a
precise, free prospecting database: no list to buy, no guesswork about who uses
LLMs.

This tool queries that database, enriches each hit with signals of real
production traffic, scores ICP fit 0–100 with a transparent heuristic, and
writes a ranked `CSV` + `JSONL` under `scripts/gtm/out/`.

**It is discovery + ranking only. It never collects personal contact data and
never sends outreach.** See [ToS & privacy](#tos--privacy) below.

## Run it

```bash
# 1. A GitHub token (classic PAT with public_repo, or a fine-grained token with
#    public read). Code search requires authentication.
export GITHUB_TOKEN=ghp_xxx

# 2. Run with the defaults (12 queries, enrich up to 120 unique repos).
npm run gtm:prospects

# Useful variants:
npm run gtm:prospects -- --dry-run            # print the query plan, no token needed
npm run gtm:prospects -- --self-test          # score a built-in fixture, no network
npm run gtm:prospects -- --min-score 50       # only keep stronger prospects
npm run gtm:prospects -- --max-repos 300 --min-stars 25
npm run gtm:prospects -- --queries-file my-queries.json
```

Outputs land in `scripts/gtm/out/`:

- `prospects-<timestamp>.csv` / `.jsonl` — the ranked list (one record per row/line).
- `prospects-latest.csv` / `.jsonl` — stable copies of the most recent run.

The `out/` directory is git-ignored (the lists are regenerable and should not
be committed); only `.gitkeep` is tracked.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--max-repos N` | 120 | Max unique repos to enrich + rank. |
| `--per-query N` | 30 | Hits fetched per search query (1–100). |
| `--min-score N` | 0 | Drop prospects scoring below N. |
| `--min-stars N` | 0 | Skip repos below N stars before enrichment (saves budget). |
| `--out-dir DIR` | `scripts/gtm/out` | Where to write. |
| `--queries-file F` | — | JSON array of `{provider, q}` to replace the defaults. |
| `--no-enrich` | off | Discovery only; score from the search stub (fast, coarse). |
| `--dry-run` | off | Print the query plan and exit (no token, no network). |
| `--self-test` | off | Score + render a built-in fixture (no network). |

## Method

### 1. Discovery

The tool runs a set of GitHub **code-search** queries (`GET /search/code`),
mixing two kinds of match:

- **Import statements** — real usage, e.g. `"from anthropic import"`,
  `"@anthropic-ai/sdk"`, `"from openai import OpenAI"`.
- **Manifest dependencies** — declared intent, e.g. `@anthropic-ai/sdk` in
  `package.json`, `anthropic` in `requirements.txt` / `pyproject.toml`.

Each result carries its repository and a `text_matches` snippet. Repos are
de-duplicated into a single candidate per `owner/name`, accumulating every
provider and query that matched it, plus the snippet fragments (used later for
tool-use and prompt-cache detection).

The default query set lives in `DEFAULT_QUERIES` in
[`prospects.ts`](./prospects.ts). Override it with `--queries-file`: a JSON
array of `{ "provider": "anthropic"|"openai", "q": "<code-search query>" }`.
Broad queries (a bare `openai` in a manifest) are kept on purpose — the scoring
and the demo filter do the ranking, not the query.

### 2. Enrichment

For each candidate (highest search-stub star count first, up to `--max-repos`):

- `GET /repos/{owner}/{name}` — owner type (User vs **Organization**), stars,
  `pushed_at` recency, `archived` / `fork` / `is_template`, description, topics,
  primary language, size.
- `GET /repos/{owner}/{name}/contents` (root) — detects **deploy configs**
  (`Dockerfile`, `fly.toml`, `vercel.json`, `render.yaml`, `Procfile`,
  `serverless.yml`, k8s/helm dirs, …) and the presence of `.github`.
- `GET /repos/{owner}/{name}/contents/.github/workflows` — **CI** presence.
- `GET /repos/{owner}/{name}/contributors?per_page=1&anon=true` — approximate
  **contributor count** from the `Link` header's last page.

Every enrichment call is best-effort: a 404 or error means "signal absent",
never a crash. Use `--no-enrich` to skip this entirely and rank from the search
stub alone (much faster, much coarser).

### 3. Scoring (0–100, additive and transparent)

MESH's own README says the sweet spot is **multi-turn, tool-using agents that
never opt into prompt caching** — an unstamped Claude agent re-pays full rate
for its whole history every turn. The heuristic encodes that:

| Signal | Points |
|---|---|
| Pushed ≤7d / ≤30d / ≤90d / ≤180d | +20 / +16 / +10 / +5 |
| Org-owned / user-owned | +15 / +6 |
| Agent-shaped (strong / weak keywords in name·desc·topics) | +18 / +9 |
| Tool-use / function-calling signal in code snippet | +14 |
| CI workflows present | +8 |
| Deploy config present | +7 |
| Contributors ≥5 / 3–4 / 2 | +10 / +7 / +3 |
| Stars ≥1000 / ≥200 / ≥50 / ≥10 | +8 / +6 / +4 / +2 |
| **Bonus:** Anthropic + no `cache_control` seen (prompt-cache gap) | +4 |
| **Penalty:** looks like a demo/tutorial | −20 |
| **Penalty:** archived | −30 |
| **Penalty:** fork with <10 stars | −8 |

The score is clamped to 0–100. Every record carries a `reasons` array listing
exactly which signals fired and by how many points, so a ranking is always
auditable — nothing is a black box. Adjust the weights in the `score()` function
in [`prospects.ts`](./prospects.ts) if your definition of fit changes.

**Caveats on the signals.** Stars measure attention, not traffic — they are
weighted mildly on purpose. The prompt-cache "gap" is inferred from a partial
code snippet, so it is a soft bonus and a note, not proof. The demo filter is
keyword-based and will occasionally misjudge a real app with "demo" in its name
(or miss a toy project without it). Treat the list as a prioritised starting
point for human review, not a verdict.

## Rate-limit handling

GitHub's limits for authenticated requests:

- **Code search:** a low per-minute cap (historically ~10/min). This is the
  binding constraint. The client paces search calls at one every **6.5s** and,
  on top of that, honours the live response headers.
- **Core REST** (repo/contents/contributors): 5,000 requests/hour. Enrichment
  uses ~3–4 calls per repo, so 120 repos is well inside budget.

The HTTP client (`GitHub` class in `prospects.ts`) handles both limit types:

- On `403`/`429` it reads `Retry-After` (secondary limits) or
  `X-RateLimit-Remaining` + `X-RateLimit-Reset` (primary limits) and sleeps the
  indicated time (capped at 15 min) before retrying.
- On `5xx` it retries with linear backoff.
- Failed individual queries or enrichment calls are logged and skipped rather
  than aborting the whole run.

A default run makes ~12 search calls (≈90s of pacing) plus a few hundred core
calls, finishing in a couple of minutes.

### Errors fail loudly (never masked as "0 hits")

An HTTP failure is never silently reported as a zero-result search. The client
classifies non-2xx responses and throws a clear, actionable message:

- **401** → `GitHub API 401 Bad credentials — check GITHUB_TOKEN`. Aborts the
  whole run immediately (a bad token dooms every query).
- **403 / 429** → distinguished: a rate/secondary limit surfaces the reset time
  and backs off/retries, then aborts if still exhausted; a 403 with no
  rate-limit markers is reported as a permission/scope problem (no pointless
  retries).
- **422** → `bad search query` (the offending query is printed). Logged per
  query; the run continues with the others.
- **5xx** → retried with backoff.
- **404** during enrichment is normal ("signal absent") and never an error.

A query that *genuinely* returns zero results still prints `0 hits` and is not
an error. But if **every** query fails with an HTTP error, the tool prints the
failures and **exits non-zero** with `0` prospects written — so a bad token or
a rate-limit wall can never look like "there were no prospects".

## ToS & privacy

This tool is built to stay on the right side of GitHub's terms and of basic
anti-spam norms:

- **No personal contact data.** It reads only public repository metadata
  (owner login, stars, files, topics). It does **not** fetch user profile
  emails, commit-author emails, or any other PII, and it must not be modified to
  do so. GitHub's Acceptable Use Policies prohibit scraping for the purpose of
  spamming or selling personal information, and using listed email addresses for
  unsolicited bulk mail.
- **No outreach.** This is discovery + ranking. Sending cold email/DMs from this
  list — especially to emails harvested from commits or profiles — is out of
  scope and against GitHub's terms. Any outreach belongs in a separate,
  consent-aware channel (e.g. a repo issue/PR only where genuinely relevant, or
  opt-in product-led signup), decided by a human.
- **Respect the API.** Use an authenticated token, honour rate limits (the
  client does this for you), and don't hammer the search endpoint. The token is
  read from `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment and is never
  written to disk or into the output.
- **Public data only.** A fine-grained token with public read, or a classic PAT
  with `public_repo`, is sufficient. Don't point this at private code.

The output is a prioritised list of public projects to review — a map of who in
the open-source world is building the kind of LLM app MESH helps. What happens
next with that map is a human decision, made within these limits.
