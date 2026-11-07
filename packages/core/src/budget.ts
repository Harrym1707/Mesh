import type { InferenceEvent, ModelTarget } from "./types.js";

/**
 * Agent budget control (Stage 9).
 *
 * An agent run is a sequence of steps and tool-calls, each of which spends
 * money, tokens, and turns. Left alone a loop can run away — retrying, re-reading
 * context, fanning out tool-calls — and the bill is only visible once it has
 * already happened. The budget controller is the governor on that loop: it
 * accumulates usage across the run and, at each step, decides deterministically
 * what the configured policy says to do when a cap is approached or exceeded.
 *
 * Four caps are enforced (any subset may be set; an unset cap is not enforced):
 *
 *   - `maxCostUsd`   — total realized spend for the run
 *   - `maxTokens`    — total tokens (input + output) across the run
 *   - `maxSteps`     — agent/planner iterations
 *   - `maxToolCalls` — tool invocations
 *
 * When a cap is reached the policy maps the severity to one of five actions:
 *
 *   - `continue`         — carry on (the default while under budget)
 *   - `switch_model`     — fall back to a cheaper target
 *   - `compress_context` — shrink the prompt/history before the next step
 *   - `stop`             — halt the run now
 *   - `escalate`         — hand off to a human / higher authority
 *
 * Two of those — `switch_model` and `compress_context` — are NOT implemented
 * here. Routing lives in the Stage 6 Router and context transforms in the
 * Stage 7 context-optimisation work; reimplementing either here would fork that
 * logic. Instead the controller emits them as INTENTS (`BudgetIntent`): a typed
 * request carrying what is left of each cap, for the Router or the context
 * optimiser to fulfil. The controller's job is the decision, not the remedy.
 *
 * The decision function is pure and total: the same usage and policy always
 * yield the same `BudgetDecision`, independent of how the usage accumulated.
 * `BudgetTracker` is the thin stateful wrapper that accumulates deltas across a
 * run and records each actionable decision through a telemetry sink, projecting
 * onto the shared `InferenceEvent` so budget decisions ride the same pipe as
 * routing decisions and provider calls.
 */

export type BudgetDimension = "cost" | "tokens" | "steps" | "toolCalls";

/** Canonical dimension order; every list and record of dimensions uses it. */
export const BUDGET_DIMENSIONS: readonly BudgetDimension[] = ["cost", "tokens", "steps", "toolCalls"];

export type BudgetAction =
  | "continue"
  | "switch_model"
  | "compress_context"
  | "stop"
  | "escalate";

/** Severity of the run's usage against its caps. */
export type BudgetStatus = "ok" | "approaching" | "exceeded";

export type BudgetLimits = {
  maxCostUsd?: number;
  maxTokens?: number;
  maxSteps?: number;
  maxToolCalls?: number;
};

export type BudgetPolicy = {
  limits: BudgetLimits;
  /**
   * Fraction of a cap (0 < t <= 1) at which usage counts as "approaching" that
   * cap but has not yet exceeded it. Defaults to 0.8.
   */
  warnThreshold?: number;
  /** Action when usage crosses the warn threshold but is still under the cap. Defaults to "continue". */
  onApproaching?: BudgetAction;
  /** Action when usage reaches or passes a cap. Defaults to "stop". */
  onExceeded?: BudgetAction;
};

/** Accumulated usage of an agent run. */
export type BudgetUsage = {
  costUsd: number;
  tokens: number;
  steps: number;
  toolCalls: number;
};

/** A single step/tool-call's contribution to the run's usage. All fields optional. */
export type BudgetDelta = Partial<BudgetUsage>;

/** How much of each capped dimension is left (never negative); unset dimensions are omitted. */
export type BudgetRemaining = {
  costUsd?: number;
  tokens?: number;
  steps?: number;
  toolCalls?: number;
};

/**
 * A request emitted for the Router (Stage 6) or context optimiser (Stage 7) to
 * fulfil. The controller never performs the remedy itself; it describes what is
 * left of the budget and which caps forced the decision.
 */
export type BudgetIntent =
  | {
      kind: "switch_model";
      triggeredBy: BudgetDimension[];
      remaining: BudgetRemaining;
      /** The target currently in use, when the run supplied one. */
      currentTarget?: ModelTarget;
      reason: string;
    }
  | {
      kind: "compress_context";
      triggeredBy: BudgetDimension[];
      remaining: BudgetRemaining;
      reason: string;
    };

export type BudgetDecision = {
  status: BudgetStatus;
  action: BudgetAction;
  /** Dimensions at the decisive severity level, in canonical order. */
  triggeredBy: BudgetDimension[];
  /** Snapshot of accumulated usage the decision was made against. */
  usage: BudgetUsage;
  /** used/limit per dimension; null for a dimension with no cap. */
  fractions: Record<BudgetDimension, number | null>;
  remaining: BudgetRemaining;
  reason: string;
  /**
   * The remedy to attempt, set whenever a remedy (`switch_model` /
   * `compress_context`) was configured for this status. It stays present even
   * when the action has fallen back to `stop` because the cap was already
   * exceeded (see `remedyExhausted`): it names the remedy an orchestrator may
   * apply before starting a fresh run.
   */
  intent?: BudgetIntent;
  /**
   * True when the configured remedy (`switch_model` / `compress_context`) was
   * chosen for an ALREADY-EXCEEDED cap and so cannot recover the overrun: the
   * action falls back to `stop` and the run must halt. This is the explicit
   * "remedy cannot help past the cap" terminal path.
   */
  remedyExhausted?: boolean;
  /** True for `stop` / `escalate`: the run must not continue automatically. */
  terminal: boolean;
};

const DIMENSION_LABELS: Record<BudgetDimension, string> = {
  cost: "cost",
  tokens: "tokens",
  steps: "steps",
  toolCalls: "tool-calls",
};

/** `stop` and `escalate` halt the run; the other three let it proceed. */
export function isTerminalAction(action: BudgetAction): boolean {
  return action === "stop" || action === "escalate";
}

export const ZERO_BUDGET_USAGE: BudgetUsage = { costUsd: 0, tokens: 0, steps: 0, toolCalls: 0 };

function limitFor(limits: BudgetLimits, dimension: BudgetDimension): number | undefined {
  switch (dimension) {
    case "cost":
      return limits.maxCostUsd;
    case "tokens":
      return limits.maxTokens;
    case "steps":
      return limits.maxSteps;
    case "toolCalls":
      return limits.maxToolCalls;
  }
}

function usedFor(usage: BudgetUsage, dimension: BudgetDimension): number {
  switch (dimension) {
    case "cost":
      return usage.costUsd;
    case "tokens":
      return usage.tokens;
    case "steps":
      return usage.steps;
    case "toolCalls":
      return usage.toolCalls;
  }
}

function assertNonNegative(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite number >= 0.`);
  }
}

/** Validate a policy up front so every later decision is total and NaN-free. */
export function assertValidBudgetPolicy(policy: BudgetPolicy): void {
  const { limits } = policy;
  for (const dimension of BUDGET_DIMENSIONS) {
    const limit = limitFor(limits, dimension);
    if (limit === undefined) continue;
    // Zero is a legitimate "allow nothing" cap; only a negative or non-finite
    // limit is rejected. A zero cap produces an immediate exceeded decision.
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
      throw new Error(`Budget limit for ${DIMENSION_LABELS[dimension]} must be a finite number >= 0.`);
    }
  }
  const threshold = policy.warnThreshold;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1)) {
    throw new Error("warnThreshold must be in the interval (0, 1].");
  }
}

function formatAmount(dimension: BudgetDimension, value: number): string {
  return dimension === "cost" ? value.toFixed(4) : String(value);
}

/**
 * Decide the budget action for an accumulated usage against a policy. Pure and
 * deterministic: a dimension is "exceeded" when used >= its cap and
 * "approaching" when used/cap >= the warn threshold but below the cap. The run's
 * status is the most severe dimension; the action is the policy's mapping of
 * that status. `switch_model`/`compress_context` carry a fulfilment intent.
 */
export function evaluateBudget(usage: BudgetUsage, policy: BudgetPolicy): BudgetDecision {
  assertValidBudgetPolicy(policy);
  for (const dimension of BUDGET_DIMENSIONS) {
    assertNonNegative(usedFor(usage, dimension), `usage.${dimension}`);
  }

  const warnThreshold = policy.warnThreshold ?? 0.8;
  const fractions = {} as Record<BudgetDimension, number | null>;
  const remaining: BudgetRemaining = {};
  const exceeded: BudgetDimension[] = [];
  const approaching: BudgetDimension[] = [];

  for (const dimension of BUDGET_DIMENSIONS) {
    const limit = limitFor(policy.limits, dimension);
    if (limit === undefined) {
      fractions[dimension] = null;
      continue;
    }
    const used = usedFor(usage, dimension);
    // A zero cap ("allow nothing") is legitimate: any usage exceeds it and zero
    // usage sits exactly at it. Guard the division so the fraction stays finite
    // and meaningful (1 at the cap, Infinity past it) instead of NaN.
    const fraction = limit === 0 ? (used > 0 ? Infinity : 1) : used / limit;
    fractions[dimension] = fraction;
    const left = Math.max(0, limit - used);
    if (dimension === "cost") remaining.costUsd = left;
    else if (dimension === "tokens") remaining.tokens = left;
    else if (dimension === "steps") remaining.steps = left;
    else remaining.toolCalls = left;

    if (used >= limit) exceeded.push(dimension);
    else if (fraction >= warnThreshold) approaching.push(dimension);
  }

  const status: BudgetStatus = exceeded.length > 0 ? "exceeded" : approaching.length > 0 ? "approaching" : "ok";
  const triggeredBy = status === "exceeded" ? exceeded : status === "approaching" ? approaching : [];
  const configuredAction: BudgetAction =
    status === "exceeded"
      ? policy.onExceeded ?? "stop"
      : status === "approaching"
        ? policy.onApproaching ?? "continue"
        : "continue";

  // Safety net against runaway loops: a remedy (switch_model / compress_context)
  // can lower the cost of FUTURE steps, but it cannot undo spend that has
  // already passed a cap. So once a cap is EXCEEDED a remedy is not, on its own,
  // a sufficient stop condition — if the Router / optimiser cannot act, the run
  // would overrun forever. When a cap is exceeded and the configured action is a
  // remedy, the controller halts (falls back to `stop`) but still surfaces the
  // remedy as an intent, so an orchestrator can apply it and start a fresh,
  // cheaper run rather than silently blowing the budget. A deliberate
  // "monitor only" policy can still overrun on purpose via onExceeded:"continue".
  const isRemedy = configuredAction === "switch_model" || configuredAction === "compress_context";
  const remedyExhausted = status === "exceeded" && isRemedy;
  const action: BudgetAction = remedyExhausted ? "stop" : configuredAction;

  const usageSnapshot: BudgetUsage = { ...usage };
  const reason = buildReason(status, configuredAction, action, triggeredBy, usageSnapshot, policy.limits);

  const decision: BudgetDecision = {
    status,
    action,
    triggeredBy,
    usage: usageSnapshot,
    fractions,
    remaining,
    reason,
    ...(remedyExhausted ? { remedyExhausted: true } : {}),
    terminal: isTerminalAction(action),
  };

  // Attach the remedy intent whenever a remedy was configured for this status,
  // even if the action fell back to stop — the intent names the remedy to try.
  if (configuredAction === "switch_model") {
    decision.intent = { kind: "switch_model", triggeredBy, remaining, reason };
  } else if (configuredAction === "compress_context") {
    decision.intent = { kind: "compress_context", triggeredBy, remaining, reason };
  }

  return decision;
}

function buildReason(
  status: BudgetStatus,
  configuredAction: BudgetAction,
  action: BudgetAction,
  triggeredBy: BudgetDimension[],
  usage: BudgetUsage,
  limits: BudgetLimits,
): string {
  if (status === "ok") return "within budget";
  const parts = triggeredBy.map((dimension) => {
    const limit = limitFor(limits, dimension)!;
    const used = usedFor(usage, dimension);
    return `${DIMENSION_LABELS[dimension]} ${formatAmount(dimension, used)}/${formatAmount(dimension, limit)}`;
  });
  const verb = status === "exceeded" ? "exceeded" : "approaching";
  if (action !== configuredAction) {
    return `${verb} ${parts.join(", ")} -> ${configuredAction} cannot recover past cap, stopping`;
  }
  return `${verb} ${parts.join(", ")} -> ${action}`;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** Who/what an agent run is, so its budget decisions can be correlated. */
export type BudgetRunContext = {
  requestId: string;
  applicationId: string;
  taskId?: string;
  taskClass?: string;
  /** The model the run is using, carried into `switch_model` intents and telemetry. */
  currentTarget?: ModelTarget;
};

/** A recorded budget decision: the native telemetry record for the budget path. */
export type BudgetDecisionEvent = {
  requestId: string;
  applicationId: string;
  taskId?: string;
  taskClass?: string;
  status: BudgetStatus;
  action: BudgetAction;
  triggeredBy: BudgetDimension[];
  usage: BudgetUsage;
  reason: string;
  intentKind?: BudgetIntent["kind"];
  timestamp: string;
};

export interface BudgetEventSink {
  record(event: BudgetDecisionEvent): void;
}

/** Collects budget decision events in memory; stands in for the real telemetry sink in tests. */
export class InMemoryBudgetSink implements BudgetEventSink {
  readonly events: BudgetDecisionEvent[] = [];
  record(event: BudgetDecisionEvent): void {
    this.events.push(event);
  }
}

/** Map a decision + run context to its telemetry record. */
export function budgetDecisionEvent(
  decision: BudgetDecision,
  context: BudgetRunContext,
  timestamp: string,
): BudgetDecisionEvent {
  return {
    requestId: context.requestId,
    applicationId: context.applicationId,
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.taskClass === undefined ? {} : { taskClass: context.taskClass }),
    status: decision.status,
    action: decision.action,
    triggeredBy: decision.triggeredBy,
    usage: decision.usage,
    reason: decision.reason,
    ...(decision.intent === undefined ? {} : { intentKind: decision.intent.kind }),
    timestamp,
  };
}

const BUDGET_TELEMETRY_PROVIDER = "mesh";
const BUDGET_TELEMETRY_MODEL = "budget-controller";

/**
 * Project a budget decision event onto the shared `InferenceEvent`, so budget
 * decisions flow through the same telemetry/ledger pipe as routing decisions
 * and provider calls. `routeReason` carries the budget verdict; the provider /
 * model name the run's current target, or the budget controller itself.
 */
export function budgetInferenceEvent(event: BudgetDecisionEvent, currentTarget?: ModelTarget): InferenceEvent {
  const triggered = event.triggeredBy.length > 0 ? event.triggeredBy.join("+") : "none";
  return {
    requestId: event.requestId,
    applicationId: event.applicationId,
    ...(event.taskClass === undefined ? {} : { taskClass: event.taskClass }),
    provider: currentTarget?.provider ?? BUDGET_TELEMETRY_PROVIDER,
    model: currentTarget?.model ?? BUDGET_TELEMETRY_MODEL,
    // A budget decision is a MARKER on the shared pipe, not a provider call: the
    // run's spend is already recorded on its own inference events. Putting the
    // cumulative cost here (which grows every step) would double-count for any
    // consumer that sums InferenceEvent.costUsd, so this marker carries zero
    // spend. The cumulative total stays available on BudgetDecisionEvent.usage.
    costUsd: 0,
    routeReason: `budget:${event.status}:${event.action}:${triggered}`,
    timestamp: event.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export type BudgetTrackerOptions = {
  context?: BudgetRunContext;
  /** Where actionable decisions are recorded. Needs `context` to carry correlation ids. */
  sink?: BudgetEventSink;
  /** Timestamp source for recorded events; defaults to the wall clock. */
  clock?: () => string;
};

/**
 * Accumulates usage across the steps and tool-calls of one agent run and decides
 * the budget action after each. Thin and stateful: the decision itself is the
 * pure `evaluateBudget`; the tracker only adds accumulation and telemetry.
 *
 * Every decision whose action is not `continue` is recorded through the sink (a
 * budget decision worth keeping is one that changed what the run does), both as
 * the native `BudgetDecisionEvent` and — when the run has a target — projectable
 * onto the shared `InferenceEvent`.
 */
export class BudgetTracker {
  private readonly policy: BudgetPolicy;
  private readonly context?: BudgetRunContext;
  private readonly sink?: BudgetEventSink;
  private readonly clock: () => string;
  private current: BudgetUsage = { ...ZERO_BUDGET_USAGE };

  constructor(policy: BudgetPolicy, options: BudgetTrackerOptions = {}) {
    assertValidBudgetPolicy(policy);
    this.policy = policy;
    this.context = options.context;
    this.sink = options.sink;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /** A copy of the accumulated usage; the internal total is never handed out. */
  get usage(): BudgetUsage {
    return { ...this.current };
  }

  /** Decide against the current usage without accumulating anything or recording. */
  peek(): BudgetDecision {
    return evaluateBudget(this.current, this.policy);
  }

  /** Accumulate a usage delta, then decide and (if actionable) record. */
  record(delta: BudgetDelta): BudgetDecision {
    assertNonNegative(delta.costUsd, "delta.costUsd");
    assertNonNegative(delta.tokens, "delta.tokens");
    assertNonNegative(delta.steps, "delta.steps");
    assertNonNegative(delta.toolCalls, "delta.toolCalls");
    this.current = {
      costUsd: this.current.costUsd + (delta.costUsd ?? 0),
      tokens: this.current.tokens + (delta.tokens ?? 0),
      steps: this.current.steps + (delta.steps ?? 0),
      toolCalls: this.current.toolCalls + (delta.toolCalls ?? 0),
    };
    const decision = evaluateBudget(this.current, this.policy);
    if (decision.action !== "continue") this.emit(decision);
    return decision;
  }

  /** Record one agent step (steps += 1) plus any spend/tokens/tool-calls it incurred. */
  recordStep(delta: Omit<BudgetDelta, "steps"> = {}): BudgetDecision {
    return this.record({ ...delta, steps: 1 });
  }

  /** Record one tool call (toolCalls += 1) plus any spend/tokens it incurred. */
  recordToolCall(delta: Omit<BudgetDelta, "toolCalls"> = {}): BudgetDecision {
    return this.record({ ...delta, toolCalls: 1 });
  }

  private emit(decision: BudgetDecision): void {
    if (this.sink === undefined || this.context === undefined) return;
    this.sink.record(budgetDecisionEvent(decision, this.context, this.clock()));
  }
}
