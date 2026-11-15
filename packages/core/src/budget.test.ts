import { describe, expect, it } from "vitest";
import {
  BudgetTracker,
  InMemoryBudgetSink,
  assertValidBudgetPolicy,
  budgetDecisionEvent,
  budgetInferenceEvent,
  evaluateBudget,
  isTerminalAction,
  ZERO_BUDGET_USAGE,
  type BudgetAction,
  type BudgetLimits,
  type BudgetPolicy,
  type BudgetRunContext,
  type BudgetUsage,
} from "./budget.js";

function usage(partial: Partial<BudgetUsage> = {}): BudgetUsage {
  return { ...ZERO_BUDGET_USAGE, ...partial };
}

function policy(limits: BudgetLimits, overrides: Partial<Omit<BudgetPolicy, "limits">> = {}): BudgetPolicy {
  return { limits, ...overrides };
}

const CONTEXT: BudgetRunContext = {
  requestId: "req-1",
  applicationId: "app-1",
  taskId: "task-1",
  taskClass: "research",
  currentTarget: { provider: "openai", model: "gpt-4o" },
};

describe("evaluateBudget — each limit is enforced", () => {
  it("stays within budget below the warn threshold", () => {
    const decision = evaluateBudget(usage({ costUsd: 0.5 }), policy({ maxCostUsd: 1 }));
    expect(decision.status).toBe("ok");
    expect(decision.action).toBe("continue");
    expect(decision.triggeredBy).toEqual([]);
    expect(decision.terminal).toBe(false);
    expect(decision.intent).toBeUndefined();
    expect(decision.remaining.costUsd).toBeCloseTo(0.5);
    expect(decision.reason).toBe("within budget");
  });

  it("flags cost that reaches the cap as exceeded", () => {
    const decision = evaluateBudget(usage({ costUsd: 1 }), policy({ maxCostUsd: 1 }));
    expect(decision.status).toBe("exceeded");
    expect(decision.triggeredBy).toEqual(["cost"]);
    expect(decision.remaining.costUsd).toBe(0);
    expect(decision.fractions.cost).toBeCloseTo(1);
  });

  it("flags tokens over the cap", () => {
    const decision = evaluateBudget(usage({ tokens: 12_000 }), policy({ maxTokens: 10_000 }));
    expect(decision.status).toBe("exceeded");
    expect(decision.triggeredBy).toEqual(["tokens"]);
    expect(decision.fractions.tokens).toBeCloseTo(1.2);
  });

  it("flags steps over the cap", () => {
    const decision = evaluateBudget(usage({ steps: 6 }), policy({ maxSteps: 5 }));
    expect(decision.status).toBe("exceeded");
    expect(decision.triggeredBy).toEqual(["steps"]);
  });

  it("flags tool-calls over the cap", () => {
    const decision = evaluateBudget(usage({ toolCalls: 4 }), policy({ maxToolCalls: 3 }));
    expect(decision.status).toBe("exceeded");
    expect(decision.triggeredBy).toEqual(["toolCalls"]);
  });

  it("does not enforce an unset limit (fraction is null)", () => {
    const decision = evaluateBudget(usage({ tokens: 1_000_000, costUsd: 0.1 }), policy({ maxCostUsd: 1 }));
    expect(decision.status).toBe("ok");
    expect(decision.fractions.tokens).toBeNull();
    expect(decision.fractions.cost).toBeCloseTo(0.1);
    expect(decision.remaining.tokens).toBeUndefined();
  });

  it("detects the approaching band at the warn threshold", () => {
    const decision = evaluateBudget(usage({ costUsd: 0.8 }), policy({ maxCostUsd: 1 }));
    expect(decision.status).toBe("approaching");
    expect(decision.triggeredBy).toEqual(["cost"]);
  });

  it("respects a custom warn threshold", () => {
    const p = policy({ maxTokens: 1000 }, { warnThreshold: 0.5 });
    expect(evaluateBudget(usage({ tokens: 499 }), p).status).toBe("ok");
    expect(evaluateBudget(usage({ tokens: 500 }), p).status).toBe("approaching");
  });

  it("reports every exceeded dimension in canonical order", () => {
    const decision = evaluateBudget(
      usage({ costUsd: 2, tokens: 20, steps: 9, toolCalls: 9 }),
      policy({ maxCostUsd: 1, maxTokens: 10, maxSteps: 5, maxToolCalls: 5 }),
    );
    expect(decision.triggeredBy).toEqual(["cost", "tokens", "steps", "toolCalls"]);
  });

  it("prefers exceeded over approaching when dimensions disagree", () => {
    const decision = evaluateBudget(
      usage({ costUsd: 0.85, tokens: 10 }),
      policy({ maxCostUsd: 1, maxTokens: 10 }),
    );
    expect(decision.status).toBe("exceeded");
    // Only the exceeded dimension drives the decision, not the approaching one.
    expect(decision.triggeredBy).toEqual(["tokens"]);
  });
});

describe("evaluateBudget — each policy action", () => {
  const over = () => usage({ costUsd: 2 });
  const limits = { maxCostUsd: 1 };

  it("continue: carries on even when exceeded", () => {
    const decision = evaluateBudget(over(), policy(limits, { onExceeded: "continue" }));
    expect(decision.action).toBe("continue");
    expect(decision.terminal).toBe(false);
    expect(decision.intent).toBeUndefined();
  });

  it("stop: is the default on exceed and is terminal", () => {
    const decision = evaluateBudget(over(), policy(limits));
    expect(decision.action).toBe("stop");
    expect(decision.terminal).toBe(true);
    expect(decision.intent).toBeUndefined();
  });

  it("escalate: is terminal and carries no intent", () => {
    const decision = evaluateBudget(over(), policy(limits, { onExceeded: "escalate" }));
    expect(decision.action).toBe("escalate");
    expect(decision.terminal).toBe(true);
    expect(decision.intent).toBeUndefined();
  });

  it("switch_model: emits a switch_model intent with remaining budget", () => {
    const decision = evaluateBudget(
      usage({ costUsd: 0.9, tokens: 500 }),
      policy({ maxCostUsd: 1, maxTokens: 1000 }, { onApproaching: "switch_model" }),
    );
    expect(decision.action).toBe("switch_model");
    expect(decision.terminal).toBe(false);
    expect(decision.intent).toEqual({
      kind: "switch_model",
      triggeredBy: ["cost"],
      remaining: { costUsd: expect.closeTo(0.1), tokens: 500 },
      reason: decision.reason,
    });
  });

  it("compress_context: emits a compress_context intent", () => {
    const decision = evaluateBudget(
      usage({ tokens: 9000 }),
      policy({ maxTokens: 10_000 }, { onApproaching: "compress_context" }),
    );
    expect(decision.action).toBe("compress_context");
    expect(decision.terminal).toBe(false);
    expect(decision.intent?.kind).toBe("compress_context");
    expect(decision.intent?.remaining.tokens).toBe(1000);
  });

  it("distinguishes the approaching action from the exceeded action", () => {
    const p = policy({ maxCostUsd: 1 }, { onApproaching: "switch_model", onExceeded: "escalate" });
    expect(evaluateBudget(usage({ costUsd: 0.9 }), p).action).toBe("switch_model");
    expect(evaluateBudget(usage({ costUsd: 1.5 }), p).action).toBe("escalate");
  });
});

describe("evaluateBudget — exceeded remedy falls back to stop (runaway safety net)", () => {
  it("switch_model on an exceeded cap halts but still surfaces the remedy", () => {
    const decision = evaluateBudget(usage({ costUsd: 2 }), policy({ maxCostUsd: 1 }, { onExceeded: "switch_model" }));
    expect(decision.action).toBe("stop");
    expect(decision.terminal).toBe(true);
    expect(decision.remedyExhausted).toBe(true);
    expect(decision.intent?.kind).toBe("switch_model");
    expect(decision.reason).toContain("cannot recover past cap");
  });

  it("compress_context on an exceeded cap halts but still surfaces the remedy", () => {
    const decision = evaluateBudget(usage({ tokens: 20 }), policy({ maxTokens: 10 }, { onExceeded: "compress_context" }));
    expect(decision.action).toBe("stop");
    expect(decision.terminal).toBe(true);
    expect(decision.remedyExhausted).toBe(true);
    expect(decision.intent?.kind).toBe("compress_context");
  });

  it("the same remedy as an approaching action still runs and is non-terminal", () => {
    const decision = evaluateBudget(usage({ costUsd: 0.9 }), policy({ maxCostUsd: 1 }, { onApproaching: "switch_model" }));
    expect(decision.action).toBe("switch_model");
    expect(decision.terminal).toBe(false);
    expect(decision.remedyExhausted).toBeUndefined();
  });

  it("escape hatch: onExceeded continue still overruns deliberately", () => {
    const decision = evaluateBudget(usage({ costUsd: 5 }), policy({ maxCostUsd: 1 }, { onExceeded: "continue" }));
    expect(decision.action).toBe("continue");
    expect(decision.terminal).toBe(false);
    expect(decision.remedyExhausted).toBeUndefined();
  });

  it("records the fallback through the sink as a stop carrying the remedy intent", () => {
    const sink = new InMemoryBudgetSink();
    const tracker = new BudgetTracker(
      policy({ maxToolCalls: 1 }, { onExceeded: "switch_model" }),
      { context: CONTEXT, sink, clock: () => "t" },
    );
    tracker.recordToolCall(); // toolCalls 1 -> exceeded -> switch_model falls back to stop
    tracker.recordToolCall(); // toolCalls 2 -> still exceeded -> stop
    expect(sink.events.map((event) => event.action)).toEqual(["stop", "stop"]);
    expect(sink.events[0]?.intentKind).toBe("switch_model");
  });
});

describe("evaluateBudget — zero-valued caps (allow nothing)", () => {
  it("is exceeded immediately, even at zero usage", () => {
    const decision = evaluateBudget(ZERO_BUDGET_USAGE, policy({ maxSteps: 0 }));
    expect(decision.status).toBe("exceeded");
    expect(decision.action).toBe("stop");
    expect(decision.triggeredBy).toEqual(["steps"]);
    expect(decision.fractions.steps).toBe(1);
  });

  it("reports an infinite fraction once anything is spent against a zero cost cap", () => {
    const decision = evaluateBudget(usage({ costUsd: 0.01 }), policy({ maxCostUsd: 0 }));
    expect(decision.status).toBe("exceeded");
    expect(decision.fractions.cost).toBe(Infinity);
    expect(decision.remaining.costUsd).toBe(0);
  });

  it("a tracker with a zero step cap stops before and on the first step", () => {
    const tracker = new BudgetTracker(policy({ maxSteps: 0 }));
    expect(tracker.peek().action).toBe("stop");
    expect(tracker.recordStep().action).toBe("stop");
  });
});

describe("isTerminalAction", () => {
  it("classifies actions", () => {
    const terminal: BudgetAction[] = ["stop", "escalate"];
    const nonTerminal: BudgetAction[] = ["continue", "switch_model", "compress_context"];
    for (const action of terminal) expect(isTerminalAction(action)).toBe(true);
    for (const action of nonTerminal) expect(isTerminalAction(action)).toBe(false);
  });
});

describe("assertValidBudgetPolicy", () => {
  it("rejects a negative or non-finite limit but accepts zero", () => {
    expect(() => assertValidBudgetPolicy(policy({ maxSteps: -1 }))).toThrow(/>= 0/);
    expect(() => assertValidBudgetPolicy(policy({ maxCostUsd: Number.POSITIVE_INFINITY }))).toThrow(/>= 0/);
    expect(() => assertValidBudgetPolicy(policy({ maxCostUsd: 0, maxSteps: 0 }))).not.toThrow();
  });

  it("rejects a warn threshold outside (0, 1]", () => {
    expect(() => assertValidBudgetPolicy(policy({ maxCostUsd: 1 }, { warnThreshold: 0 }))).toThrow(/warnThreshold/);
    expect(() => assertValidBudgetPolicy(policy({ maxCostUsd: 1 }, { warnThreshold: 1.5 }))).toThrow(/warnThreshold/);
  });

  it("accepts an empty limit set (nothing enforced)", () => {
    expect(() => assertValidBudgetPolicy(policy({}))).not.toThrow();
    expect(evaluateBudget(usage({ costUsd: 999 }), policy({})).status).toBe("ok");
  });

  it("evaluateBudget rejects negative usage", () => {
    expect(() => evaluateBudget(usage({ costUsd: -1 }), policy({ maxCostUsd: 1 }))).toThrow(/>= 0/);
  });
});

describe("BudgetTracker — accumulation across steps and tool-calls", () => {
  it("accumulates deltas and decides on the running total", () => {
    const tracker = new BudgetTracker(policy({ maxCostUsd: 1 }, { onExceeded: "stop" }));
    expect(tracker.record({ costUsd: 0.4 }).action).toBe("continue");
    expect(tracker.record({ costUsd: 0.4 }).status).toBe("approaching");
    const third = tracker.record({ costUsd: 0.4 });
    expect(third.status).toBe("exceeded");
    expect(third.action).toBe("stop");
    expect(tracker.usage.costUsd).toBeCloseTo(1.2);
  });

  it("counts steps and tool-calls as it records them", () => {
    const tracker = new BudgetTracker(policy({ maxSteps: 3, maxToolCalls: 2 }));
    tracker.recordStep({ costUsd: 0.1 });
    tracker.recordStep();
    const toolA = tracker.recordToolCall({ tokens: 100 });
    expect(toolA.status).toBe("ok");
    expect(tracker.usage).toEqual({ costUsd: 0.1, tokens: 100, steps: 2, toolCalls: 1 });
    const toolB = tracker.recordToolCall();
    expect(toolB.status).toBe("exceeded");
    expect(toolB.triggeredBy).toEqual(["toolCalls"]);
  });

  it("peek decides without mutating usage", () => {
    const tracker = new BudgetTracker(policy({ maxSteps: 2 }, { warnThreshold: 0.5 }));
    tracker.recordStep();
    expect(tracker.peek().status).toBe("approaching");
    expect(tracker.usage.steps).toBe(1);
  });

  it("the usage getter hands out a copy", () => {
    const tracker = new BudgetTracker(policy({ maxCostUsd: 1 }));
    tracker.record({ costUsd: 0.2 });
    const snapshot = tracker.usage;
    snapshot.costUsd = 999;
    expect(tracker.usage.costUsd).toBeCloseTo(0.2);
  });

  it("rejects a negative delta", () => {
    const tracker = new BudgetTracker(policy({ maxCostUsd: 1 }));
    expect(() => tracker.record({ tokens: -5 })).toThrow(/>= 0/);
  });

  it("the same usage reached by different paths yields the same decision", () => {
    const p = policy({ maxCostUsd: 1, maxToolCalls: 4 }, { onExceeded: "escalate" });
    const a = new BudgetTracker(p);
    a.record({ costUsd: 0.5, toolCalls: 1 });
    a.record({ costUsd: 0.6, toolCalls: 3 });
    const viaTracker = a.peek();
    const viaPure = evaluateBudget(usage({ costUsd: 1.1, toolCalls: 4 }), p);
    expect(viaTracker).toEqual(viaPure);
  });
});

describe("BudgetTracker — telemetry", () => {
  it("records only actionable decisions (action !== continue) through the sink", () => {
    const sink = new InMemoryBudgetSink();
    const clock = () => "2026-11-07T00:00:00.000Z";
    const tracker = new BudgetTracker(
      policy({ maxCostUsd: 1 }, { onApproaching: "switch_model", onExceeded: "stop" }),
      { context: CONTEXT, sink, clock },
    );
    tracker.record({ costUsd: 0.5 }); // ok -> continue -> not recorded
    tracker.record({ costUsd: 0.35 }); // approaching -> switch_model -> recorded
    tracker.record({ costUsd: 0.5 }); // exceeded -> stop -> recorded

    expect(sink.events.map((event) => event.action)).toEqual(["switch_model", "stop"]);
    const [switchEvent, stopEvent] = sink.events;
    expect(switchEvent).toMatchObject({
      requestId: "req-1",
      applicationId: "app-1",
      taskId: "task-1",
      taskClass: "research",
      status: "approaching",
      action: "switch_model",
      intentKind: "switch_model",
      timestamp: "2026-11-07T00:00:00.000Z",
    });
    expect(stopEvent.intentKind).toBeUndefined();
    expect(stopEvent.status).toBe("exceeded");
  });

  it("does not record when no sink or context is configured", () => {
    const sink = new InMemoryBudgetSink();
    const noContext = new BudgetTracker(policy({ maxCostUsd: 1 }), { sink });
    noContext.record({ costUsd: 5 });
    expect(sink.events).toHaveLength(0);
  });

  it("budgetDecisionEvent maps a decision and context to a telemetry record", () => {
    const decision = evaluateBudget(usage({ costUsd: 2 }), policy({ maxCostUsd: 1 }));
    const event = budgetDecisionEvent(decision, CONTEXT, "2026-11-07T12:00:00.000Z");
    expect(event).toEqual({
      requestId: "req-1",
      applicationId: "app-1",
      taskId: "task-1",
      taskClass: "research",
      status: "exceeded",
      action: "stop",
      triggeredBy: ["cost"],
      usage: { costUsd: 2, tokens: 0, steps: 0, toolCalls: 0 },
      reason: decision.reason,
      timestamp: "2026-11-07T12:00:00.000Z",
    });
  });

  it("budgetInferenceEvent projects onto the shared InferenceEvent pipe", () => {
    const decision = evaluateBudget(usage({ costUsd: 2 }), policy({ maxCostUsd: 1 }));
    const event = budgetDecisionEvent(decision, CONTEXT, "2026-11-07T12:00:00.000Z");
    const inference = budgetInferenceEvent(event, CONTEXT.currentTarget);
    expect(inference).toEqual({
      requestId: "req-1",
      applicationId: "app-1",
      taskClass: "research",
      provider: "openai",
      model: "gpt-4o",
      costUsd: 0,
      routeReason: "budget:exceeded:stop:cost",
      timestamp: "2026-11-07T12:00:00.000Z",
    });
  });

  it("budgetInferenceEvent falls back to the budget controller when no target is known", () => {
    const decision = evaluateBudget(usage({ costUsd: 0.5 }), policy({ maxCostUsd: 1 }));
    const event = budgetDecisionEvent(decision, { requestId: "r", applicationId: "a" }, "t");
    const inference = budgetInferenceEvent(event);
    expect(inference.provider).toBe("mesh");
    expect(inference.model).toBe("budget-controller");
    expect(inference.routeReason).toBe("budget:ok:continue:none");
  });
});
