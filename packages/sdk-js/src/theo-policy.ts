import type { MeshTokenReductionConfig, MeshOutputEffort } from "./reduce-request.js";

/**
 * Theo's per-user policy — the control mechanism between Theo and MESH.
 *
 * Theo never sits in the request path. His ONLY action is to publish a new version
 * of this document; the proxy reads it and enforces it synchronously. A policy is
 * self-documenting: every lossy lever carries the gate proof (measured saving + the
 * measured quality delta Y + the grader) that justifies it.
 *
 * The load-bearing safety property is in `policyToReductionConfig`: a lossy lever is
 * applied ONLY if it carries a passing gate proof within the route's quality ceiling.
 * A policy therefore CANNOT enable a saving Theo has not proven — the "never degrade
 * the product" rule is enforced here, in code, not by trust.
 *
 * Pure and dependency-free (no node:*), so it loads in any JavaScript runtime.
 */

export type TheoLeverClass = "lossless" | "lossy";

/** The gate proof for a lossy lever: measured on the user's OWN traffic. */
export type TheoGateProof = {
  /** Measured saving on the user's traffic, from provider-reported usage. */
  savingPercent: number;
  /** Measured quality delta Y (<= 0; e.g. -0.3 = a 0.3% drop). */
  qualityDeltaPercent: number;
  /** What graded quality: "task-completion" | "tests" | "behavioural" | a custom name. */
  grader: string;
  provenAt: string;
};

export type TheoLever = {
  /** The reducer lever id (e.g. "tool-schema-compaction", "cache-ttl-5m", "output-effort-low"). */
  lever: string;
  class: TheoLeverClass;
  /** Required for a lossy lever before it can be enforced; absent for lossless. */
  gate?: TheoGateProof;
  /** Lever-specific params (e.g. { maximumTokens: 600 }, { maximumDescriptionTokens: 40 }). */
  params?: Record<string, unknown>;
};

export type TheoPolicy = {
  schemaVersion: 1;
  user: string;
  /** Optional per-route policy; a default route when omitted. */
  route?: string;
  /** Monotonic — publishing a new version is Theo's only action. Rollback = publish a prior one. */
  version: number;
  /** Max quality drop (percent) this route tolerates. Default STRICT; loosened only by the user. */
  qualityCeilingPercent: number;
  levers: TheoLever[];
  updatedAt: string;
};

/** Why a lever in the policy is NOT currently enforced — for Theo's transparency to the user. */
export type WithheldLever = { lever: string; reason: string };

/**
 * Hard upper bound on any route's quality ceiling. Enforcement clamps to this, so
 * however loose a policy's `qualityCeilingPercent` is set (by config, a tier dial,
 * or a tampered file), a lossy lever whose measured quality drop exceeds this is
 * never enforced. A floor under "never degrade" that no misconfiguration crosses.
 */
export const MAX_QUALITY_CEILING_PERCENT = 5;

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The effective ceiling: the route's, clamped to the hard maximum (and ≥ 0). */
export function effectiveQualityCeiling(ceilingPercent: number): number {
  const c = Number.isFinite(ceilingPercent) ? ceilingPercent : 0;
  return Math.max(0, Math.min(c, MAX_QUALITY_CEILING_PERCENT));
}

/** Whether a lossy lever's proof clears the route's quality ceiling (hard-capped). */
function proofClearsCeiling(lever: TheoLever, ceilingPercent: number): boolean {
  if (lever.gate === undefined) return false;
  const y = lever.gate.qualityDeltaPercent;
  return Number.isFinite(y) && Math.abs(y) <= effectiveQualityCeiling(ceilingPercent);
}

/** Map one lever id (+ params) onto the reducer config. Unknown ids are ignored. */
function applyLever(config: MeshTokenReductionConfig, lever: TheoLever): void {
  const p = lever.params ?? {};
  switch (lever.lever) {
    case "tool-schema-compaction":
      // Lossless tier only (keep descriptions).
      if (config.toolSchemas === undefined) config.toolSchemas = true;
      return;
    case "tool-schema-description-trim":
      config.toolSchemas = {
        descriptions: "truncate",
        ...(typeof p.maximumDescriptionTokens === "number" ? { maximumDescriptionTokens: p.maximumDescriptionTokens } : {}),
      };
      return;
    case "unused-tool-removal": {
      // Operator-named tools the workload never calls. Lossy: enforced only with
      // a gate proof (handled by policyToReductionConfig), never guessed.
      const names = Array.isArray(p.tools) ? p.tools.filter((name): name is string => typeof name === "string") : [];
      if (names.length > 0) config.dropTools = names;
      return;
    }
    case "duplicate-context-removal":
      config.duplicateContext = true;
      return;
    case "cache-prefix-repair":
      config.repairCachePrefix = true;
      return;
    case "stale-history-compaction":
      config.historyCompaction = true;
      return;
    case "cross-turn-memory-dedup":
      config.crossTurnMemoryDedup = true;
      return;
    case "fresh-tool-result-cap":
      config.freshToolResultCap = typeof p.maximumTokens === "number" ? { maximumTokens: p.maximumTokens } : true;
      return;
    case "output-cap":
      if (typeof p.maxOutputTokens === "number") config.maxOutputTokens = p.maxOutputTokens;
      return;
    case "execution-tier-flex":
      config.executionTier = "flex";
      return;
    case "cache-ttl-5m":
      config.cacheTtl = "5m";
      return;
    case "cache-ttl-1h":
      config.cacheTtl = "1h";
      return;
    case "output-effort-low":
    case "output-effort-medium":
    case "output-effort-high":
    case "output-effort-xhigh":
    case "output-effort-max":
      config.outputEffort = lever.lever.replace("output-effort-", "") as MeshOutputEffort;
      return;
    default:
      return; // unknown lever id: ignore, never guess.
  }
}

/**
 * Turn a policy into the reduction config the proxy enforces.
 *
 * Lossless levers apply unconditionally (they cannot change the answer). A lossy
 * lever applies ONLY if it carries a gate proof whose measured quality delta is
 * within the route's ceiling; otherwise it is silently withheld. This is the
 * enforcement point of "never enable a saving we have not proven within budget."
 */
export function policyToReductionConfig(policy: TheoPolicy): MeshTokenReductionConfig {
  const config: MeshTokenReductionConfig = {};
  for (const lever of policy.levers) {
    if (lever.class === "lossy" && !proofClearsCeiling(lever, policy.qualityCeilingPercent)) continue;
    applyLever(config, lever);
  }
  return config;
}

/** A ledger gate verdict, structurally the ledger's `LedgerGateVerdict` (kept
 * local so this module stays dependency-free). */
export type PolicyGateVerdict = { ref: string; verdict: "approved" };

/**
 * The replay-gate verdicts behind the lossy levers this policy ENFORCES, keyed by
 * lever id, for the savings ledger. Exactly the levers `policyToReductionConfig`
 * applies: a lossy lever with a proof inside the (hard-capped) ceiling. A lever
 * that is withheld gets no verdict, so its savings can never bill. The ref names
 * the proof — grader and the time it was measured — so an invoice line can be
 * traced back to the gate run that justified it.
 */
export function policyGateVerdicts(policy: TheoPolicy): Record<string, PolicyGateVerdict> {
  const verdicts: Record<string, PolicyGateVerdict> = {};
  for (const lever of policy.levers) {
    if (lever.class !== "lossy" || lever.gate === undefined) continue;
    if (!proofClearsCeiling(lever, policy.qualityCeilingPercent)) continue;
    verdicts[lever.lever] = {
      ref: `theo-gate:${lever.lever}:${lever.gate.grader}@${lever.gate.provenAt}`,
      verdict: "approved",
    };
  }
  return verdicts;
}

/**
 * Build the reducer config for a SINGLE lever, bypassing the policy's proof gate.
 *
 * This exists to CONSTRUCT a candidate for the replay gate to measure — it is not
 * an enforcement path. Production enforcement still goes only through
 * `policyToReductionConfig`, which withholds any lossy lever that lacks a passing
 * proof within the route's ceiling. Reuses `applyLever` so the gate measures the
 * exact transform the proxy would later enforce.
 */
export function leverToReductionConfig(lever: TheoLever): MeshTokenReductionConfig {
  const config: MeshTokenReductionConfig = {};
  applyLever(config, lever);
  return config;
}

/**
 * A bundle of policies for one user: a DEFAULT policy plus zero or more
 * route-specific overrides. A "route" is matched against the request's model id,
 * so a user can run a strict ceiling on their agent's planning model and a looser
 * one on a cheap summariser — each route carries its OWN ceiling, levers and
 * proofs, and the hard cap (`MAX_QUALITY_CEILING_PERCENT`) still binds every one.
 *
 * Back-compatible: a stored single `TheoPolicy` is read as a bundle whose default
 * is that policy and whose route list is empty (`asBundle`), so existing policy
 * files and the single-policy enforcement path keep working unchanged.
 */
export type TheoPolicyBundle = {
  schemaVersion: 1;
  user: string;
  /** Applied to any request whose model id matches no route. */
  default: TheoPolicy;
  /** Route-specific policies; each MUST carry a `route` matcher. First match wins. */
  routes?: TheoPolicy[];
  updatedAt: string;
};

/**
 * Whether a route matcher applies to a model id. Three forms, deliberately small:
 * - `"*"` or `""` — matches every model (a catch-all route).
 * - a trailing `*` — prefix match (`"claude-*"` matches `"claude-sonnet-5-5"`).
 * - anything else — an exact model-id match.
 * No regex: a policy file is config a user hand-edits, so matching stays obvious.
 */
export function routeMatches(pattern: string, modelId: string): boolean {
  if (pattern === "*" || pattern === "") return true;
  if (pattern.endsWith("*")) return modelId.startsWith(pattern.slice(0, -1));
  return pattern === modelId;
}

/** Is this stored value a bundle (has a `default` policy) rather than a single policy? */
export function isPolicyBundle(value: unknown): value is TheoPolicyBundle {
  return typeof value === "object" && value !== null && "default" in value &&
    typeof (value as { default?: unknown }).default === "object";
}

/**
 * Normalise a stored document to a bundle. A single `TheoPolicy` becomes a bundle
 * with that policy as its default and no routes; a bundle passes through. One read
 * path for both the legacy single-policy file and the new per-route bundle.
 */
export function asBundle(stored: TheoPolicy | TheoPolicyBundle): TheoPolicyBundle {
  if (isPolicyBundle(stored)) return stored;
  const policy = stored as TheoPolicy;
  return { schemaVersion: 1, user: policy.user, default: policy, updatedAt: policy.updatedAt };
}

/**
 * The policy governing a given model id: the FIRST route whose matcher applies,
 * else the bundle's default. Order in `routes` is the precedence, so put specific
 * matchers before catch-alls.
 */
export function policyForRoute(bundle: TheoPolicyBundle, modelId: string): TheoPolicy {
  for (const route of bundle.routes ?? []) {
    if (route.route !== undefined && routeMatches(route.route, modelId)) return route;
  }
  return bundle.default;
}

/**
 * The reduction config the proxy enforces for a given model id under a bundle.
 * Routes through `policyForRoute` then the single-policy enforcement gate, so the
 * per-route ceiling and every safety guarantee (proof required, hard cap) apply to
 * the SELECTED route exactly as they do to a single policy.
 */
export function bundleToReductionConfig(bundle: TheoPolicyBundle, modelId: string): MeshTokenReductionConfig {
  return policyToReductionConfig(policyForRoute(bundle, modelId));
}

/** The gate verdicts for the route governing a model id (see `policyGateVerdicts`). */
export function bundleGateVerdicts(bundle: TheoPolicyBundle, modelId: string): Record<string, PolicyGateVerdict> {
  return policyGateVerdicts(policyForRoute(bundle, modelId));
}

/**
 * Insert or replace a route policy in a bundle, returning a NEW bundle (never
 * mutating the input). The policy must carry a `route`; a policy for an existing
 * route replaces it, matched by the exact matcher string.
 */
export function upsertRoutePolicy(bundle: TheoPolicyBundle, policy: TheoPolicy, at: string): TheoPolicyBundle {
  if (policy.route === undefined || policy.route === "") {
    throw new Error("Refusing to add a route policy without a `route` matcher.");
  }
  const routes = (bundle.routes ?? []).filter((existing) => existing.route !== policy.route);
  routes.push(policy);
  return { ...bundle, routes, updatedAt: at };
}

/**
 * Land a policy Theo has evolved into a bundle WITHOUT clobbering the rest of it,
 * returning a NEW bundle. With a `route`, the policy becomes that route's override
 * (every other route and the default preserved); without one, it replaces the
 * bundle's default (every route preserved). This is what `mesh theo --apply`
 * writes: Theo optimises one model at a time, so he can publish to that model's
 * route and leave the others exactly as they were.
 */
export function mergePolicyIntoBundle(
  existing: TheoPolicyBundle | undefined,
  policy: TheoPolicy,
  route: string | undefined,
  at: string,
): TheoPolicyBundle {
  if (route !== undefined && route !== "") {
    const base = existing ?? asBundle(defaultPolicy(policy.user, at));
    return upsertRoutePolicy(base, { ...policy, route }, at);
  }
  const base = existing ?? asBundle(policy);
  // The default policy carries no route matcher of its own.
  const def = { ...policy };
  delete def.route;
  return { ...base, default: def, updatedAt: at };
}

/** The lossy levers present in the policy but NOT enforced, with the reason — for Theo's UX. */
export function withheldLevers(policy: TheoPolicy): WithheldLever[] {
  const out: WithheldLever[] = [];
  for (const lever of policy.levers) {
    if (lever.class !== "lossy") continue;
    if (lever.gate === undefined) {
      out.push({ lever: lever.lever, reason: "no gate proof yet — queued for the live gate" });
    } else if (!proofClearsCeiling(lever, policy.qualityCeilingPercent)) {
      out.push({
        lever: lever.lever,
        reason: `measured quality drop ${Math.abs(lever.gate.qualityDeltaPercent).toFixed(2)}% exceeds the ` +
          `${policy.qualityCeilingPercent}% ceiling for this route`,
      });
    }
  }
  return out;
}

/**
 * Publish a lever into a policy, returning a NEW version (never mutating the input).
 * A lossless lever is added as-is; a lossy lever must carry a gate proof. The version
 * bumps and updatedAt is set by the caller's clock (passed in, so this stays pure).
 */
export function publishLever(policy: TheoPolicy, lever: TheoLever, at: string): TheoPolicy {
  if (lever.class === "lossy" && lever.gate === undefined) {
    throw new Error(`Refusing to publish lossy lever '${lever.lever}' without a gate proof.`);
  }
  const levers = policy.levers.filter((existing) => existing.lever !== lever.lever);
  levers.push(lever);
  return { ...policy, levers, version: policy.version + 1, updatedAt: at };
}

/** A fresh, STRICT default policy for a new user — lossless-only until Theo proves more. */
export function defaultPolicy(user: string, at: string): TheoPolicy {
  return {
    schemaVersion: 1,
    user,
    version: 1,
    qualityCeilingPercent: 2, // strict by default; loosened only by the user's revealed preference
    levers: [
      { lever: "tool-schema-compaction", class: "lossless" },
      { lever: "duplicate-context-removal", class: "lossless" },
      { lever: "cache-prefix-repair", class: "lossless" },
    ],
    updatedAt: at,
  };
}

/** The reducer-lever ids Theo can enforce. */
export function knownLeverIds(): string[] {
  return [
    "tool-schema-compaction", "tool-schema-description-trim", "unused-tool-removal", "duplicate-context-removal",
    "cache-prefix-repair", "stale-history-compaction", "cross-turn-memory-dedup",
    "fresh-tool-result-cap", "output-cap", "execution-tier-flex",
    "cache-ttl-5m", "cache-ttl-1h",
    "output-effort-low", "output-effort-medium", "output-effort-high", "output-effort-xhigh", "output-effort-max",
  ];
}

export type EnforceableLever = { id: string; label: string; members: readonly string[] };

/**
 * The levers the proxy can enforce, grouped so mutually-exclusive variants count
 * once: a policy cannot run output-effort-low AND output-effort-high, nor both
 * cache TTLs, so counting each id separately would understate coverage. Every id
 * in knownLeverIds() belongs to exactly one group here, and vice versa — the test
 * `ENFORCEABLE_LEVERS stays in sync with knownLeverIds` holds the two together.
 */
export const ENFORCEABLE_LEVERS: readonly EnforceableLever[] = [
  { id: "tool-schema-compaction", label: "Tool-schema compaction", members: ["tool-schema-compaction"] },
  { id: "tool-schema-description-trim", label: "Tool-schema description trim", members: ["tool-schema-description-trim"] },
  { id: "unused-tool-removal", label: "Unused-tool removal", members: ["unused-tool-removal"] },
  { id: "duplicate-context-removal", label: "Duplicate-context removal", members: ["duplicate-context-removal"] },
  { id: "cache-prefix-repair", label: "Cache-prefix repair", members: ["cache-prefix-repair"] },
  { id: "stale-history-compaction", label: "Stale-history compaction", members: ["stale-history-compaction"] },
  { id: "cross-turn-memory-dedup", label: "Cross-turn memory dedup", members: ["cross-turn-memory-dedup"] },
  { id: "fresh-tool-result-cap", label: "Fresh tool-result cap", members: ["fresh-tool-result-cap"] },
  { id: "output-cap", label: "Output cap", members: ["output-cap"] },
  { id: "execution-tier-flex", label: "Execution-tier flex", members: ["execution-tier-flex"] },
  { id: "cache-ttl", label: "Cache TTL", members: ["cache-ttl-5m", "cache-ttl-1h"] },
  {
    id: "output-effort",
    label: "Output effort",
    members: ["output-effort-low", "output-effort-medium", "output-effort-high", "output-effort-xhigh", "output-effort-max"],
  },
];

/**
 * Where an enforceable lever stands for this user right now:
 * - `active`:    Theo is enforcing it (lossless, or lossy with a proof within the ceiling).
 * - `held`:      it is in the policy but a lossy proof does not yet clear the ceiling.
 * - `available`: Theo can enforce it but has not adopted it yet — a candidate for the live gate.
 */
export type LeverStandState = "active" | "held" | "available";

export type LeverStand = {
  lever: string;
  label: string;
  state: LeverStandState;
  class?: TheoLeverClass;
  reason?: string;
};

export type PolicyCoverage = {
  /** Enforceable levers in the repertoire (grouped). */
  enforceableCount: number;
  activeCount: number;
  heldCount: number;
  availableCount: number;
  /** activeCount / enforceableCount * 100 — the share of the repertoire live right now. */
  activeCoveragePercent: number;
  stands: LeverStand[];
};

/**
 * How much of the proxy's enforceable repertoire Theo is actually using for this
 * user. The honest denominator for the live dashboard: it shows not just the
 * levers Theo applies and holds, but every lever he COULD apply and has not
 * adopted yet — so a user can see how complete the coverage is, not only what is
 * on. Pure: the same policy always yields the same coverage.
 */
export function policyCoverage(policy: TheoPolicy): PolicyCoverage {
  const byId = new Map(policy.levers.map((lever) => [lever.lever, lever]));
  const heldById = new Map(withheldLevers(policy).map((withheld) => [withheld.lever, withheld.reason]));

  const stands: LeverStand[] = ENFORCEABLE_LEVERS.map((group) => {
    let state: LeverStandState = "available";
    let reason: string | undefined;
    let leverClass: TheoLeverClass | undefined;
    for (const member of group.members) {
      const lever = byId.get(member);
      if (lever === undefined) continue;
      leverClass = lever.class;
      const enforced = lever.class === "lossless" || proofClearsCeiling(lever, policy.qualityCeilingPercent);
      if (enforced) { state = "active"; reason = undefined; break; }
      state = "held";
      reason = heldById.get(member);
    }
    return {
      lever: group.id,
      label: group.label,
      state,
      ...(leverClass ? { class: leverClass } : {}),
      ...(reason ? { reason } : {}),
    };
  });

  const activeCount = stands.filter((stand) => stand.state === "active").length;
  const heldCount = stands.filter((stand) => stand.state === "held").length;
  const availableCount = stands.filter((stand) => stand.state === "available").length;
  const enforceableCount = ENFORCEABLE_LEVERS.length;
  return {
    enforceableCount,
    activeCount,
    heldCount,
    availableCount,
    activeCoveragePercent: enforceableCount === 0 ? 0 : (activeCount / enforceableCount) * 100,
    stands,
  };
}
