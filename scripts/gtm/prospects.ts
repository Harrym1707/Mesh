/**
 * MESH GTM — GitHub-native ICP prospect finder.
 *
 *   GITHUB_TOKEN=ghp_... node --import tsx scripts/gtm/prospects.ts [flags]
 *
 * MESH's ideal customer is defined in code: anyone who imports the LLM SDKs
 * MESH reduces (`anthropic` / `@anthropic-ai/sdk` / `openai`) and runs
 * meaningful traffic through them. GitHub's own code search is therefore a
 * precise, free prospecting database. This tool queries it, enriches each hit
 * with signals of real production traffic (org ownership, recency, CI/deploy
 * configs, multiple contributors, agent/tool-use shape), scores ICP fit 0–100
 * with a transparent additive heuristic, and writes a ranked CSV + JSONL under
 * scripts/gtm/out/.
 *
 * Discovery + ranking ONLY. It never collects personal contact data and never
 * sends outreach. See scripts/gtm/README.md for method, rate-limit handling
 * and the ToS/privacy caveats.
 *
 * Flags:
 *   --max-repos N     Max unique repos to enrich + rank (default 120).
 *   --per-query N     Results fetched per search query, 1..100 (default 30).
 *   --min-score N     Drop prospects scoring below N from the output (default 0).
 *   --min-stars N     Skip repos below N stars before enrichment (default 0).
 *   --out-dir DIR     Output directory (default scripts/gtm/out).
 *   --queries-file F  JSON array of {provider,q} to use instead of the defaults.
 *   --no-enrich       Discovery only; skip per-repo enrichment (score from stubs).
 *   --dry-run         Print the query plan and exit (no network, no token needed).
 *   --self-test       Run scoring + output on a built-in fixture (no network).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Provider = "anthropic" | "openai";

interface SearchQuery {
  provider: Provider;
  q: string;
}

interface RepoStub {
  fullName: string; // owner/name
  providers: Set<Provider>;
  queries: Set<string>;
  snippets: string[]; // text-match fragments, used for tool-use / cache detection
  stars?: number; // sometimes present on the search repository stub
}

interface Signals {
  recencyDays: number | null;
  ownerType: "Organization" | "User" | "unknown";
  stars: number;
  agentShaped: "strong" | "weak" | "none";
  toolUse: boolean;
  ci: boolean;
  deploy: boolean;
  contributors: number | null;
  cacheGap: boolean; // Anthropic present, no cache_control seen → MESH's sweet spot
  likelyDemo: boolean;
  archived: boolean;
  fork: boolean;
  isTemplate: boolean;
}

interface Prospect {
  fullName: string;
  url: string;
  providers: Provider[];
  description: string;
  language: string | null;
  topics: string[];
  pushedAt: string | null;
  signals: Signals;
  score: number;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Config / arg parsing
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

interface Config {
  maxRepos: number;
  perQuery: number;
  minScore: number;
  minStars: number;
  outDir: string;
  queriesFile?: string;
  enrich: boolean;
  dryRun: boolean;
  selfTest: boolean;
}

function parseArgs(argv: string[]): Config {
  const cfg: Config = {
    maxRepos: 120,
    perQuery: 30,
    minScore: 0,
    minStars: 0,
    outDir: join(HERE, "out"),
    enrich: true,
    dryRun: false,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const takeValue = (): string => {
      const v = argv[i + 1];
      if (v === undefined) fail(`Missing value for ${flag}.`);
      i += 1;
      return v;
    };
    switch (flag) {
      case "--max-repos":
        cfg.maxRepos = clampInt(takeValue(), 1, 1000);
        break;
      case "--per-query":
        cfg.perQuery = clampInt(takeValue(), 1, 100);
        break;
      case "--min-score":
        cfg.minScore = clampInt(takeValue(), 0, 100);
        break;
      case "--min-stars":
        cfg.minStars = clampInt(takeValue(), 0, 10_000_000);
        break;
      case "--out-dir":
        cfg.outDir = takeValue();
        break;
      case "--queries-file":
        cfg.queriesFile = takeValue();
        break;
      case "--no-enrich":
        cfg.enrich = false;
        break;
      case "--dry-run":
        cfg.dryRun = true;
        break;
      case "--self-test":
        cfg.selfTest = true;
        break;
      case "--help":
      case "-h":
        printUsageAndExit();
        break;
      default:
        fail(`Unknown flag ${flag}. Use --help for usage.`);
    }
  }
  return cfg;
}

function clampInt(raw: string, lo: number, hi: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) fail(`Expected an integer, got ${raw}.`);
  return Math.max(lo, Math.min(hi, n));
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function printUsageAndExit(): never {
  console.log(
    `MESH GTM prospect finder\n\n` +
      `  GITHUB_TOKEN=... node --import tsx scripts/gtm/prospects.ts [flags]\n\n` +
      `  --max-repos N     Max unique repos to enrich + rank (default 120)\n` +
      `  --per-query N     Results per search query, 1..100 (default 30)\n` +
      `  --min-score N     Drop prospects below N (default 0)\n` +
      `  --min-stars N     Skip repos below N stars before enrichment (default 0)\n` +
      `  --out-dir DIR     Output directory (default scripts/gtm/out)\n` +
      `  --queries-file F  JSON array of {provider,q} to use instead of defaults\n` +
      `  --no-enrich       Discovery only\n` +
      `  --dry-run         Print the query plan and exit (no token needed)\n` +
      `  --self-test       Score + render a built-in fixture (no network)\n`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Default query set
// ---------------------------------------------------------------------------
//
// Legacy /search/code query syntax: exact phrase in quotes + language:/filename:
// qualifiers. Import-statement searches catch real usage; manifest searches
// catch declared dependencies. Broad queries (e.g. a bare "openai" in a
// manifest) are deliberately included — scoring and the demo filter do the
// ranking, not the query.

const DEFAULT_QUERIES: SearchQuery[] = [
  // Anthropic — imports
  { provider: "anthropic", q: `"import anthropic" language:python` },
  { provider: "anthropic", q: `"from anthropic import" language:python` },
  { provider: "anthropic", q: `"@anthropic-ai/sdk" language:typescript` },
  { provider: "anthropic", q: `"@anthropic-ai/sdk" language:javascript` },
  // Anthropic — manifests
  { provider: "anthropic", q: `"@anthropic-ai/sdk" filename:package.json` },
  { provider: "anthropic", q: `anthropic filename:requirements.txt` },
  { provider: "anthropic", q: `anthropic filename:pyproject.toml` },
  // OpenAI — imports
  { provider: "openai", q: `"from openai import OpenAI" language:python` },
  { provider: "openai", q: `"import openai" language:python` },
  { provider: "openai", q: `"from \\"openai\\"" language:typescript` },
  // OpenAI — manifests
  { provider: "openai", q: `"openai" filename:package.json` },
  { provider: "openai", q: `openai filename:requirements.txt` },
];

function loadQueries(cfg: Config): SearchQuery[] {
  if (cfg.queriesFile === undefined) return DEFAULT_QUERIES;
  const raw = JSON.parse(readFileSync(cfg.queriesFile, "utf8")) as unknown;
  if (!Array.isArray(raw)) fail("--queries-file must contain a JSON array.");
  return raw.map((entry, idx) => {
    const e = entry as Record<string, unknown>;
    if (e.provider !== "anthropic" && e.provider !== "openai") {
      fail(`Query ${idx}: provider must be "anthropic" or "openai".`);
    }
    if (typeof e.q !== "string" || e.q.trim() === "") {
      fail(`Query ${idx}: q must be a non-empty string.`);
    }
    return { provider: e.provider, q: e.q };
  });
}

// ---------------------------------------------------------------------------
// GitHub HTTP client with rate-limit handling
// ---------------------------------------------------------------------------

const API = "https://api.github.com";
const USER_AGENT = "mesh-gtm-prospect-finder";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GhResponse<T> {
  status: number;
  body: T;
  link: string | null;
}

type GhErrorKind = "auth" | "rate_limit" | "bad_query" | "forbidden" | "server" | "other";

/** A real HTTP failure from the GitHub API — never a zero-result search. */
class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: GhErrorKind,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

class GitHub {
  private readonly token: string;
  // Legacy code search is the tight bottleneck (~10 authenticated req/min).
  // We pace search calls at one per 6.5s and still honour the live headers.
  private lastSearchAt = 0;
  private readonly searchSpacingMs = 6500;

  constructor(token: string) {
    this.token = token;
  }

  private headers(textMatch = false): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: textMatch
        ? "application/vnd.github.text-match+json"
        : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    };
  }

  /** Read GitHub's JSON error `message` (drains the body); "" if unreadable. */
  private async readError(res: Response): Promise<string> {
    try {
      const data = (await res.json()) as { message?: unknown };
      return typeof data?.message === "string" ? data.message : "";
    } catch {
      return "";
    }
  }

  /**
   * Core request with primary + secondary rate-limit handling and retries.
   *
   * A 2xx returns the body; a 404 returns status 404 with a null body (callers
   * treat it as "signal absent"). Every other non-2xx is a real failure and
   * throws a GitHubApiError — it is NEVER silently turned into an empty result.
   * 401 (auth) and 422 (bad query) throw at once; 403/429 rate limits back off
   * and retry, then throw with the reset time if still exhausted.
   */
  private async request<T>(
    url: string,
    opts: { textMatch?: boolean; isSearch?: boolean } = {},
  ): Promise<GhResponse<T>> {
    let lastRateErr: GitHubApiError | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (opts.isSearch) await this.paceSearch();
      const res = await fetch(url, { headers: this.headers(opts.textMatch) });

      if (res.ok) {
        const link = res.headers.get("link");
        const body = (res.status === 204 ? null : await res.json()) as T;
        return { status: res.status, body, link };
      }

      const message = await this.readError(res);

      // A missing resource is a normal answer for enrichment lookups.
      if (res.status === 404) return { status: 404, body: null as T, link: null };

      if (res.status === 401) {
        throw new GitHubApiError(
          `GitHub API 401 ${message || "Unauthorized"} — check GITHUB_TOKEN ` +
            `(is it set, valid, and unexpired?).`,
          401,
          "auth",
        );
      }

      if (res.status === 422) {
        throw new GitHubApiError(
          `GitHub API 422 ${message || "Unprocessable"} — bad search query: ${url}`,
          422,
          "bad_query",
        );
      }

      if (res.status === 403 || res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = res.headers.get("x-ratelimit-reset");
        const isRateLimited =
          retryAfter !== null || remaining === "0" || /rate limit/i.test(message);

        // A 403 with no rate-limit markers is a genuine permission problem
        // (e.g. the token lacks scope), not something retrying will fix.
        if (!isRateLimited) {
          throw new GitHubApiError(
            `GitHub API 403 ${message || "Forbidden"} — token may lack access for ${url}.`,
            403,
            "forbidden",
          );
        }

        let waitMs = 60_000;
        let resetAt = "";
        if (retryAfter) {
          waitMs = (Number(retryAfter) || 60) * 1000;
        } else if (remaining === "0" && reset) {
          waitMs = Math.max(1000, Number(reset) * 1000 - Date.now() + 1000);
          resetAt = new Date(Number(reset) * 1000).toISOString();
        }
        lastRateErr = new GitHubApiError(
          `GitHub API ${res.status} rate limit${resetAt ? ` (resets ${resetAt})` : ""}` +
            ` — ${message || "too many requests"}.`,
          res.status,
          "rate_limit",
        );
        if (attempt < 5) {
          console.error(
            `  rate-limited (${res.status}); waiting ${Math.round(waitMs / 1000)}s` +
              `${resetAt ? ` (resets ${resetAt})` : ""}...`,
          );
          await sleep(Math.min(waitMs, 15 * 60_000));
          continue;
        }
        throw lastRateErr;
      }

      if (res.status >= 500) {
        lastRateErr = new GitHubApiError(
          `GitHub API ${res.status} ${message || "server error"}`,
          res.status,
          "server",
        );
        await sleep(2000 * (attempt + 1));
        continue;
      }

      throw new GitHubApiError(
        `GitHub API ${res.status} ${message || "error"} — ${url}`,
        res.status,
        "other",
      );
    }
    throw lastRateErr ?? new GitHubApiError(`GitHub request failed after retries: ${url}`, 0, "other");
  }

  private async paceSearch(): Promise<void> {
    const wait = this.lastSearchAt + this.searchSpacingMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastSearchAt = Date.now();
  }

  async searchCode(
    q: string,
    perPage: number,
  ): Promise<Array<{ fullName: string; snippet: string; stars?: number }>> {
    const url = `${API}/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}`;
    const { status, body } = await this.request<{
      items?: Array<{
        repository?: { full_name?: string; stargazers_count?: number };
        text_matches?: Array<{ fragment?: string }>;
      }>;
    }>(url, { textMatch: true, isSearch: true });
    if (status !== 200 || !body.items) return [];
    return body.items
      .filter((it) => it.repository?.full_name)
      .map((it) => ({
        fullName: it.repository!.full_name!,
        snippet: (it.text_matches ?? [])
          .map((m) => m.fragment ?? "")
          .join("\n"),
        stars: it.repository!.stargazers_count,
      }));
  }

  async getRepo(fullName: string): Promise<Record<string, unknown> | null> {
    const { status, body } = await this.request<Record<string, unknown>>(
      `${API}/repos/${fullName}`,
    );
    return status === 200 ? body : null;
  }

  /** Root-dir filenames (for CI / deploy-config detection) — one call. */
  async listRootFiles(fullName: string): Promise<string[]> {
    const { status, body } = await this.request<
      Array<{ name?: string; type?: string }>
    >(`${API}/repos/${fullName}/contents`);
    if (status !== 200 || !Array.isArray(body)) return [];
    return body.map((e) => e.name ?? "").filter(Boolean);
  }

  async hasWorkflows(fullName: string): Promise<boolean> {
    const { status, body } = await this.request<unknown>(
      `${API}/repos/${fullName}/contents/.github/workflows`,
    );
    return status === 200 && Array.isArray(body) && body.length > 0;
  }

  /** Approximate contributor count via the Link header's last page. */
  async contributorCount(fullName: string): Promise<number | null> {
    const { status, body, link } = await this.request<unknown[]>(
      `${API}/repos/${fullName}/contributors?per_page=1&anon=true`,
    );
    if (status !== 200) return null;
    if (link) {
      const m = link.match(/[?&]page=(\d+)>; rel="last"/);
      if (m) return Number(m[1]);
    }
    return Array.isArray(body) ? body.length : null;
  }
}

// ---------------------------------------------------------------------------
// Signal extraction + scoring (pure, unit-testable)
// ---------------------------------------------------------------------------

const AGENT_STRONG = [
  "agent",
  "autonomous",
  "copilot",
  "orchestrat",
  "multi-agent",
  "multiagent",
  "rag",
  "assistant",
];
const AGENT_WEAK = [
  "chatbot",
  "chat-bot",
  "bot",
  "workflow",
  "pipeline",
  "llm",
  "ai-",
  "gpt",
  "claude",
];
const TOOL_HINTS = [
  "tool_use",
  "tool_calls",
  "tool_call",
  "function_call",
  "tools=",
  '"tools"',
  "tool_choice",
  "toolchoice",
  "function calling",
  "function-calling",
];
const DEMO_HINTS = [
  "example",
  "demo",
  "tutorial",
  "starter",
  "boilerplate",
  "playground",
  "sample",
  "hello-world",
  "hello_world",
  "template",
  "course",
  "workshop",
  "learning",
  "my-first",
  "test-",
  "poc",
  "proof-of-concept",
];

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((Date.now() - then) / 86_400_000));
}

function matchAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

function classifyAgent(text: string, topics: string[]): "strong" | "weak" | "none" {
  const hay = `${text} ${topics.join(" ")}`.toLowerCase();
  if (matchAny(hay, AGENT_STRONG)) return "strong";
  if (matchAny(hay, AGENT_WEAK)) return "weak";
  return "none";
}

/** Score a fully-enriched prospect. Additive, transparent, clamped to 0..100. */
function score(signals: Signals, providers: Provider[]): { score: number; reasons: string[] } {
  let total = 0;
  const reasons: string[] = [];
  const add = (points: number, why: string) => {
    if (points === 0) return;
    total += points;
    reasons.push(`${points > 0 ? "+" : ""}${points} ${why}`);
  };

  // Active — a dead repo sends no traffic, so recency dominates.
  const d = signals.recencyDays;
  if (d === null) add(0, "push date unknown");
  else if (d <= 7) add(20, "pushed this week");
  else if (d <= 30) add(16, "pushed this month");
  else if (d <= 90) add(10, "pushed this quarter");
  else if (d <= 180) add(5, "pushed within 6 months");
  else add(0, `last push ${d}d ago (stale)`);

  // Org-owned → likelier to have budget and commercial traffic.
  if (signals.ownerType === "Organization") add(15, "org-owned");
  else if (signals.ownerType === "User") add(6, "user-owned");

  // Agent / tool-use shape — MESH's sweet spot is multi-turn, tool-using agents.
  if (signals.agentShaped === "strong") add(18, "agent-shaped (name/desc/topics)");
  else if (signals.agentShaped === "weak") add(9, "LLM-app-shaped");
  if (signals.toolUse) add(14, "tool-use / function-calling signal");

  // Real-traffic / production signals.
  if (signals.ci) add(8, "CI workflows present");
  if (signals.deploy) add(7, "deploy config present");
  const c = signals.contributors;
  if (c !== null) {
    if (c >= 5) add(10, `${c}+ contributors`);
    else if (c >= 3) add(7, `${c} contributors`);
    else if (c >= 2) add(3, "2 contributors");
  }

  // Traction (mild — stars ≠ traffic).
  const s = signals.stars;
  if (s >= 1000) add(8, `${s} stars`);
  else if (s >= 200) add(6, `${s} stars`);
  else if (s >= 50) add(4, `${s} stars`);
  else if (s >= 10) add(2, `${s} stars`);

  // Bonus: Anthropic agent with no cache_control seen = the highest-leverage
  // case MESH's README calls out (unstamped Claude agents re-pay full rate).
  if (signals.cacheGap) add(4, "Anthropic + no cache_control seen (prompt-cache gap)");

  // Penalties.
  if (signals.likelyDemo) add(-20, "looks like a demo/tutorial");
  if (signals.archived) add(-30, "archived");
  if (signals.fork && signals.stars < 10) add(-8, "fork with little traction");

  const clamped = Math.max(0, Math.min(100, total));
  if (providers.includes("anthropic")) reasons.push("provider: anthropic (biggest cache win)");
  return { score: clamped, reasons };
}

// ---------------------------------------------------------------------------
// Discovery + enrichment
// ---------------------------------------------------------------------------

async function discover(
  gh: GitHub,
  queries: SearchQuery[],
  perQuery: number,
): Promise<Map<string, RepoStub>> {
  const repos = new Map<string, RepoStub>();
  let succeeded = 0;
  let errored = 0;
  for (const [idx, query] of queries.entries()) {
    console.error(`[${idx + 1}/${queries.length}] search: ${query.q}`);
    let hits: Array<{ fullName: string; snippet: string; stars?: number }> = [];
    try {
      hits = await gh.searchCode(query.q, perQuery);
    } catch (err) {
      // Auth and exhausted-rate-limit failures doom every remaining query, so
      // abort the whole run loudly instead of grinding through 12 failures.
      if (err instanceof GitHubApiError && (err.kind === "auth" || err.kind === "rate_limit")) {
        throw err;
      }
      console.error(`  query failed: ${(err as Error).message}`);
      errored += 1;
      continue;
    }
    succeeded += 1;
    console.error(`  ${hits.length} hits`);
    for (const hit of hits) {
      const existing = repos.get(hit.fullName);
      if (existing) {
        existing.providers.add(query.provider);
        existing.queries.add(query.q);
        if (hit.snippet) existing.snippets.push(hit.snippet);
        if (hit.stars !== undefined) existing.stars = hit.stars;
      } else {
        repos.set(hit.fullName, {
          fullName: hit.fullName,
          providers: new Set([query.provider]),
          queries: new Set([query.q]),
          snippets: hit.snippet ? [hit.snippet] : [],
          stars: hit.stars,
        });
      }
    }
  }
  if (succeeded === 0 && queries.length > 0) {
    throw new Error(
      `All ${queries.length} search queries failed (${errored} HTTP errors) — see the ` +
        `messages above. No prospects written. This is an API/query failure, not an empty result.`,
    );
  }
  if (errored > 0) {
    console.error(`\nNote: ${errored}/${queries.length} queries errored; ranking the ${succeeded} that succeeded.`);
  }
  return repos;
}

function signalsFromStub(stub: RepoStub, repo: Record<string, unknown> | null): Signals {
  const providers = [...stub.providers];
  const snippetBlob = stub.snippets.join("\n").toLowerCase();
  const toolUse = matchAny(snippetBlob, TOOL_HINTS);
  const cacheSeen = snippetBlob.includes("cache_control") || snippetBlob.includes("cachecontrol");
  const cacheGap = providers.includes("anthropic") && !cacheSeen;

  if (!repo) {
    // --no-enrich path: score from the search stub alone.
    return {
      recencyDays: null,
      ownerType: "unknown",
      stars: stub.stars ?? 0,
      agentShaped: classifyAgent(stub.fullName, []),
      toolUse,
      ci: false,
      deploy: false,
      contributors: null,
      cacheGap,
      likelyDemo: matchAny(stub.fullName.toLowerCase(), DEMO_HINTS),
      archived: false,
      fork: false,
      isTemplate: false,
    };
  }

  const owner = repo.owner as Record<string, unknown> | undefined;
  const ownerType =
    owner?.type === "Organization" || owner?.type === "User"
      ? (owner.type as "Organization" | "User")
      : "unknown";
  const topics = Array.isArray(repo.topics) ? (repo.topics as string[]) : [];
  const description = typeof repo.description === "string" ? repo.description : "";
  const text = `${stub.fullName} ${description}`;
  const stars = typeof repo.stargazers_count === "number" ? repo.stargazers_count : stub.stars ?? 0;
  const size = typeof repo.size === "number" ? repo.size : 0; // KB
  const archived = repo.archived === true;
  const fork = repo.fork === true;
  const isTemplate = repo.is_template === true;

  const demoByName = matchAny(text.toLowerCase(), DEMO_HINTS) || topics.some((t) => matchAny(t.toLowerCase(), DEMO_HINTS));

  return {
    recencyDays: daysSince(typeof repo.pushed_at === "string" ? repo.pushed_at : null),
    ownerType,
    stars,
    agentShaped: classifyAgent(text, topics),
    toolUse,
    ci: false, // filled by enrichFiles
    deploy: false, // filled by enrichFiles
    contributors: null, // filled by enrichFiles
    cacheGap,
    likelyDemo: demoByName || isTemplate,
    archived,
    fork,
    isTemplate,
  };
}

const DEPLOY_FILES = [
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yaml",
  "fly.toml",
  "vercel.json",
  "render.yaml",
  "railway.json",
  "railway.toml",
  "procfile",
  "netlify.toml",
  "app.yaml",
  "serverless.yml",
  "serverless.yaml",
  "k8s",
  "kubernetes",
  "helm",
  ".platform.app.yaml",
];

async function enrichFiles(gh: GitHub, fullName: string, signals: Signals, hasGithubDir: boolean): Promise<void> {
  const rootFiles = await gh.listRootFiles(fullName).catch(() => [] as string[]);
  const lower = rootFiles.map((f) => f.toLowerCase());
  signals.deploy = lower.some((f) => DEPLOY_FILES.includes(f));
  const ghDir = hasGithubDir || lower.includes(".github");
  signals.ci = ghDir ? await gh.hasWorkflows(fullName).catch(() => false) : false;
  signals.contributors = await gh.contributorCount(fullName).catch(() => null);
}

async function enrich(
  gh: GitHub,
  stubs: RepoStub[],
  cfg: Config,
): Promise<Prospect[]> {
  const prospects: Prospect[] = [];
  for (const [idx, stub] of stubs.entries()) {
    console.error(`[enrich ${idx + 1}/${stubs.length}] ${stub.fullName}`);
    const repo = cfg.enrich ? await gh.getRepo(stub.fullName).catch(() => null) : null;
    if (cfg.enrich && !repo) {
      console.error("  (repo unavailable — skipped)");
      continue;
    }
    if (cfg.minStars > 0) {
      const stars = (repo?.stargazers_count as number | undefined) ?? stub.stars ?? 0;
      if (stars < cfg.minStars) continue;
    }
    const signals = signalsFromStub(stub, repo);
    if (cfg.enrich && repo) {
      const hasGithubDir = false; // listRootFiles will detect it
      await enrichFiles(gh, stub.fullName, signals, hasGithubDir);
    }
    const providers = [...stub.providers];
    const { score: s, reasons } = score(signals, providers);
    const description = typeof repo?.description === "string" ? repo.description : "";
    const topics = Array.isArray(repo?.topics) ? (repo!.topics as string[]) : [];
    prospects.push({
      fullName: stub.fullName,
      url: `https://github.com/${stub.fullName}`,
      providers,
      description,
      language: (repo?.language as string | null) ?? null,
      topics,
      pushedAt: (repo?.pushed_at as string | null) ?? null,
      signals,
      score: s,
      reasons,
    });
  }
  prospects.sort((a, b) => b.score - a.score || b.signals.stars - a.signals.stars);
  return prospects;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(prospects: Prospect[]): string {
  const header = [
    "rank",
    "score",
    "repo",
    "url",
    "providers",
    "owner_type",
    "stars",
    "pushed_days_ago",
    "agent_shaped",
    "tool_use",
    "ci",
    "deploy",
    "contributors",
    "cache_gap",
    "likely_demo",
    "language",
    "description",
    "reasons",
  ];
  const rows = prospects.map((p, i) =>
    [
      i + 1,
      p.score,
      p.fullName,
      p.url,
      p.providers.join("+"),
      p.signals.ownerType,
      p.signals.stars,
      p.signals.recencyDays ?? "",
      p.signals.agentShaped,
      p.signals.toolUse,
      p.signals.ci,
      p.signals.deploy,
      p.signals.contributors ?? "",
      p.signals.cacheGap,
      p.signals.likelyDemo,
      p.language ?? "",
      p.description,
      p.reasons.join("; "),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

function toJsonl(prospects: Prospect[]): string {
  return prospects.map((p) => JSON.stringify(p)).join("\n") + "\n";
}

function writeOutputs(cfg: Config, prospects: Prospect[]): { csv: string; jsonl: string } {
  mkdirSync(cfg.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csvPath = join(cfg.outDir, `prospects-${stamp}.csv`);
  const jsonlPath = join(cfg.outDir, `prospects-${stamp}.jsonl`);
  writeFileSync(csvPath, toCsv(prospects), "utf8");
  writeFileSync(jsonlPath, toJsonl(prospects), "utf8");
  // Stable "latest" copies for scripting.
  writeFileSync(join(cfg.outDir, "prospects-latest.csv"), toCsv(prospects), "utf8");
  writeFileSync(join(cfg.outDir, "prospects-latest.jsonl"), toJsonl(prospects), "utf8");
  return { csv: csvPath, jsonl: jsonlPath };
}

function printSummary(prospects: Prospect[], limit = 20): void {
  console.log(`\nTop ${Math.min(limit, prospects.length)} prospects:\n`);
  console.log("RANK  SCORE  REPO".padEnd(52) + "SIGNALS");
  for (const [i, p] of prospects.slice(0, limit).entries()) {
    const flags = [
      p.signals.ownerType === "Organization" ? "org" : "",
      p.signals.agentShaped !== "none" ? p.signals.agentShaped[0]!.toUpperCase() + "agent" : "",
      p.signals.toolUse ? "tools" : "",
      p.signals.ci ? "ci" : "",
      p.signals.deploy ? "deploy" : "",
      p.signals.cacheGap ? "cache-gap" : "",
    ]
      .filter(Boolean)
      .join(",");
    const head = `${String(i + 1).padStart(4)}  ${String(p.score).padStart(5)}  ${p.fullName}`;
    console.log(head.padEnd(52) + flags);
  }
}

// ---------------------------------------------------------------------------
// Self-test fixture (no network)
// ---------------------------------------------------------------------------

function selfTestStubs(): { stub: RepoStub; repo: Record<string, unknown>; signals: Partial<Signals> }[] {
  // Hand-built records exercising each scoring branch.
  const mk = (full: string, providers: Provider[], snippet: string): RepoStub => ({
    fullName: full,
    providers: new Set(providers),
    queries: new Set(["self-test"]),
    snippets: [snippet],
    stars: undefined,
  });
  return [
    {
      stub: mk("acme/support-agent", ["anthropic"], 'tools=[...] messages.create'),
      repo: {
        owner: { type: "Organization" },
        description: "Autonomous customer-support agent with tool use",
        topics: ["agent", "llm", "anthropic"],
        stargazers_count: 420,
        pushed_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        language: "Python",
        size: 5000,
      },
      signals: { ci: true, deploy: true, contributors: 7 },
    },
    {
      stub: mk("jdoe/openai-tutorial", ["openai"], "import openai"),
      repo: {
        owner: { type: "User" },
        description: "A hello-world demo following the OpenAI tutorial",
        topics: ["tutorial", "example"],
        stargazers_count: 3,
        pushed_at: new Date(Date.now() - 400 * 86_400_000).toISOString(),
        language: "Python",
        size: 40,
      },
      signals: { ci: false, deploy: false, contributors: 1 },
    },
    {
      stub: mk("bigco/rag-pipeline", ["anthropic", "openai"], 'tool_choice function_call'),
      repo: {
        owner: { type: "Organization" },
        description: "Production RAG pipeline orchestrating multi-agent workflows",
        topics: ["rag", "multi-agent", "pipeline"],
        stargazers_count: 2100,
        pushed_at: new Date(Date.now() - 1 * 86_400_000).toISOString(),
        language: "TypeScript",
        size: 12000,
      },
      signals: { ci: true, deploy: true, contributors: 15 },
    },
    {
      stub: mk("archived/old-bot", ["openai"], "import openai"),
      repo: {
        owner: { type: "User" },
        description: "An old chatbot experiment",
        topics: ["chatbot"],
        stargazers_count: 12,
        pushed_at: new Date(Date.now() - 500 * 86_400_000).toISOString(),
        language: "JavaScript",
        size: 300,
        archived: true,
      },
      signals: { ci: false, deploy: false, contributors: 2 },
    },
  ];
}

function runSelfTest(cfg: Config): void {
  console.error("Self-test: scoring + rendering a built-in fixture (no network).\n");
  const prospects: Prospect[] = selfTestStubs().map(({ stub, repo, signals: overrides }) => {
    const signals = signalsFromStub(stub, repo);
    Object.assign(signals, overrides);
    const providers = [...stub.providers];
    const { score: s, reasons } = score(signals, providers);
    return {
      fullName: stub.fullName,
      url: `https://github.com/${stub.fullName}`,
      providers,
      description: (repo.description as string) ?? "",
      language: (repo.language as string | null) ?? null,
      topics: (repo.topics as string[]) ?? [],
      pushedAt: (repo.pushed_at as string) ?? null,
      signals,
      score: s,
      reasons,
    };
  });
  prospects.sort((a, b) => b.score - a.score || b.signals.stars - a.signals.stars);

  // Assertions on what the heuristic must get right: the two production agents
  // are the top two, the demo and the archived repo are penalised to 0, the
  // production agent outranks the demo, and the Anthropic cache-gap flag fires.
  const byName = new Map(prospects.map((p) => [p.fullName, p]));
  const order = prospects.map((p) => p.fullName);
  const topTwo = new Set(order.slice(0, 2));
  const ok =
    topTwo.has("bigco/rag-pipeline") &&
    topTwo.has("acme/support-agent") &&
    order.indexOf("bigco/rag-pipeline") < order.indexOf("jdoe/openai-tutorial") &&
    byName.get("jdoe/openai-tutorial")!.score === 0 &&
    byName.get("archived/old-bot")!.score === 0 &&
    byName.get("acme/support-agent")!.signals.cacheGap === true;

  const { csv, jsonl } = writeOutputs(cfg, prospects);
  printSummary(prospects);
  console.log(`\nWrote ${prospects.length} fixture rows to:\n  ${csv}\n  ${jsonl}`);
  if (!ok) {
    console.error("\nSELF-TEST FAILED: ranking invariants not met.");
    process.exit(1);
  }
  console.error("\nSelf-test passed: ranking invariants hold.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));

  if (cfg.selfTest) {
    runSelfTest(cfg);
    return;
  }

  const queries = loadQueries(cfg);

  if (cfg.dryRun) {
    console.log("Query plan (no requests sent):\n");
    for (const [i, q] of queries.entries()) {
      console.log(`  ${String(i + 1).padStart(2)}. [${q.provider}] ${q.q}`);
    }
    console.log(
      `\n${queries.length} queries × up to ${cfg.perQuery} hits, ` +
        `enriching up to ${cfg.maxRepos} unique repos.\n` +
        `Set GITHUB_TOKEN and drop --dry-run to run for real.`,
    );
    return;
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    fail(
      "GITHUB_TOKEN is required. Create a classic PAT (public_repo scope is enough) " +
        "or a fine-grained token with public read, then:\n" +
        "  GITHUB_TOKEN=ghp_... npm run gtm:prospects\n" +
        "Or try the no-token paths: --dry-run (query plan) or --self-test (scoring demo).",
    );
  }

  const gh = new GitHub(token);
  console.error(`MESH GTM prospect finder — ${queries.length} queries\n`);

  const repoMap = await discover(gh, queries, cfg.perQuery);
  console.error(`\nDiscovered ${repoMap.size} unique repos.`);

  // Rank enrichment candidates by the search-stub star count so the budget
  // goes to the likeliest prospects first.
  const stubs = [...repoMap.values()]
    .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
    .slice(0, cfg.maxRepos);
  console.error(`Enriching top ${stubs.length}...\n`);

  const prospects = (await enrich(gh, stubs, cfg)).filter((p) => p.score >= cfg.minScore);

  const { csv, jsonl } = writeOutputs(cfg, prospects);
  printSummary(prospects);
  console.log(
    `\nWrote ${prospects.length} prospects (score ≥ ${cfg.minScore}) to:\n  ${csv}\n  ${jsonl}`,
  );
  console.log(
    "\nDiscovery + ranking only. Do NOT scrape personal emails or send cold outreach " +
      "from this list — see scripts/gtm/README.md for the ToS/privacy caveats.",
  );
}

main().catch((err) => {
  // Clean one-line message for expected API failures; full detail otherwise.
  if (err instanceof GitHubApiError) console.error(`\nError: ${err.message}`);
  else console.error(err instanceof Error ? `\nError: ${err.message}` : err);
  process.exit(1);
});
