import {
  ANTHROPIC_CACHE_5M,
  ANTHROPIC_NO_CACHE,
  approximateTokenCount,
  lookupPrice,
  publishedModelPrices,
  simulateCache,
  type SimulatedRequest,
} from "../packages/core/src/index.js";

/**
 * Lever backlog P5 — shared-prefix fan-out serialization — measured.
 *
 *   node --import tsx evals/run-fanout-collision.ts
 *
 * The lever backlog (docs/rnd/lever-backlog.md, P5) names the simulator's own
 * optimism as the first thing to fix: "add entry-available-at-first-response-
 * START concurrency semantics to cache-simulator.ts IN THE SAME CHANGE and
 * restate the multi-agent band under them first (it will come down) — the
 * lever's credit is the delta against the corrected baseline, never the
 * current optimistic one." That correction landed tonight in
 * `cache-simulator.ts`'s new `cacheAvailabilityDelaySeconds` option. This
 * script is the restatement.
 *
 * The shape: a multi-agent orchestrator fans sub-agents out to run
 * CONCURRENTLY, all carrying the same system + tools block. This is not a
 * guess about framework internals — it is documented behaviour: LangGraph's
 * "superstep" runs every node reached by a fan-out edge at the same time and
 * waits for all of them before continuing (docs.langchain.com/oss/python/
 * langgraph/graph-api-control-flow; langchain-ai.github.io/langgraph/how-tos/
 * branching), and CrewAI's async task/crew APIs document the same
 * asyncio.gather-style concurrent dispatch for tasks and crews run in
 * parallel (docs.crewai.com/en/learn/kickoff-async). A provider's cache entry
 * for a prefix exists only once that prefix's FIRST request has a response
 * (its write has registered) — so N agents dispatched in the same superstep,
 * all sharing an as-yet-uncached prefix, do not get "1 write + (N-1) reads":
 * every one of them is still racing the first one's write and pays the write
 * premium.
 *
 * Three arms, same request stream, same prices:
 *   NAIVE    — today's pre-existing simulator behaviour (instant
 *              availability). This is the number a workload-matrix-style
 *              fixture would have reported before tonight; it is the
 *              OPTIMISTIC baseline the backlog says to retire.
 *   REAL     — the same stream, same cache policy, but with the new
 *              concurrency-aware availability delay: every within-round
 *              sub-agent dispatch is modelled as truly simultaneous
 *              (atSeconds identical, matching the documented superstep/
 *              asyncio.gather behaviour above), so they all collide. This is
 *              what the orchestrator is ACTUALLY paying today, with no MESH
 *              fan-out lever.
 *   LATCHED  — the same stream, but each round's racers are, in effect, held
 *              by `FanOutLatch` until the first racer's write would have
 *              registered: modelled here by moving every non-first racer's
 *              atSeconds forward by the estimated time-to-first-byte, which
 *              is exactly what the latch's hold achieves on the wire (see
 *              fan-out-latch.ts and its proxy.test.ts integration tests,
 *              which prove this timing shift end-to-end over real HTTP).
 *
 * The honest reportable number is LATCHED vs REAL, never LATCHED vs NAIVE —
 * NAIVE was never a real cost, so "beating" it is not a saving.
 *
 * TTFB ESTIMATE, labelled as such: no provider publishes a prefill-latency
 * formula. Artificial Analysis's third-party provider benchmarks (median
 * time-to-first-token over a rolling 72h window, non-reasoning Claude
 * Sonnet) put Anthropic between roughly 1.16s and 1.96s across snapshots for
 * a 10,000-token input (artificialanalysis.ai/models/claude-sonnet-5/
 * providers and related snapshots, captured 2026-11-12). This fixture's
 * shared prefix (system + 10 tool schemas) is ~3,500 tokens — shorter than
 * that benchmark's 10,000-token input, so if anything this likely
 * OVERSTATES real TTFB at this fixture's size, which understates how many
 * requests would actually clear a round's collision window on their own and
 * therefore does not flatter the lever. A flat 1.5s is used for every
 * round regardless of exact token count: a genuinely variable formula would
 * need its own measured curve, which nobody has run; collapsing to one
 * round number inside the cited range is the conservative middle, not a
 * tuned-to-flatter constant.
 */

const TTFB_ESTIMATE_SECONDS = 1.5;

const AT = "2026-10-27";
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

const ORCHESTRATOR_SYSTEM =
  "You are one of several specialist sub-agents fanned out by an orchestrator to work the same ticket " +
  "concurrently. Follow the shared runbook: verify inputs against the ticket's acceptance criteria, cite the " +
  "source document for every claim, prefer small reversible edits, surface anything risky back to the " +
  "orchestrator instead of guessing, and report findings in the shared structured format so the orchestrator " +
  "can merge them without re-reading your reasoning. ".repeat(10);

const SHARED_TOOLS = Array.from({ length: 10 }, (_, index) => ({
  name: `tool_${index}`,
  description:
    `Tool ${index} operates on subsystem ${index} of the shared ticket workspace. Validates input against the ` +
    "schema, retries once on a transient failure, never mutates shared state without acquiring the ticket's " +
    "lock first, and returns a compact JSON result the orchestrator can merge. Call it only when your assigned " +
    `role actually needs subsystem ${index}.`,
  input_schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: { id: { type: "string" }, scope: { type: "string" }, dryRun: { type: "boolean" } },
    required: ["id"],
  },
}));

const SHARED_PREFIX = JSON.stringify({ system: ORCHESTRATOR_SYSTEM, tools: SHARED_TOOLS });
console.log(`shared prefix size: ${approximateTokenCount(SHARED_PREFIX)} tokens (must clear the 1,024-token minimum to be in-scope for this lever at all)\n`);

const SUB_AGENT_ROLES = ["search", "coder", "reviewer", "writer", "security"];
const ROUNDS = 8;

type Mode = "naive" | "real" | "latched";

function buildFanOutStream(mode: Mode, secondsBetweenRounds: number): SimulatedRequest[] {
  const requests: SimulatedRequest[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const roundStart = round * secondsBetweenRounds;
    SUB_AGENT_ROLES.forEach((role, slot) => {
      // NAIVE and REAL: every sub-agent in the round is dispatched at the
      // same instant, matching the documented superstep / gather behaviour.
      // LATCHED: the first dispatches at roundStart; every racer behind it
      // is held by the latch until the first's write would have registered.
      const atSeconds = mode === "latched" && slot > 0 ? roundStart + TTFB_ESTIMATE_SECONDS : roundStart;
      const prompt = [
        ORCHESTRATOR_SYSTEM,
        JSON.stringify(SHARED_TOOLS),
        `Round ${round}, role ${role}: advance ticket 7 from your role's perspective. Report findings.`,
      ].join("\n");
      requests.push({ atSeconds, prompt, outputTokens: 220 });
    });
  }
  return requests;
}

function run(mode: Mode, secondsBetweenRounds: number) {
  const stream = buildFanOutStream(mode, secondsBetweenRounds);
  const delay = mode === "naive" ? undefined : () => TTFB_ESTIMATE_SECONDS;
  return simulateCache(stream, ANTHROPIC_CACHE_5M, price.price, { cacheAvailabilityDelaySeconds: delay });
}

function row(label: string, result: ReturnType<typeof run>) {
  const racing = result.missReasons["racing-write"] ?? 0;
  console.log(
    `  ${label.padEnd(10)} cost $${result.totalCostUsd.toFixed(4)}  hit rate ${(result.hitRate * 100).toFixed(1)}%  ` +
    `racing-write misses ${racing}/${result.calls.length}`,
  );
}

function scenario(label: string, secondsBetweenRounds: number) {
  const naive = run("naive", secondsBetweenRounds);
  const real = run("real", secondsBetweenRounds);
  const latched = run("latched", secondsBetweenRounds);
  const uncached = simulateCache(buildFanOutStream("real", secondsBetweenRounds), ANTHROPIC_NO_CACHE, price.price);

  console.log(`\n=== ${label}: ${ROUNDS} rounds x ${SUB_AGENT_ROLES.length} concurrent sub-agents, ` +
    `${secondsBetweenRounds}s between rounds (5m TTL ${secondsBetweenRounds <= 300 ? "stays warm across rounds" : "expires between rounds"}) ===`);
  row("uncached", uncached);
  row("naive", naive);
  row("real", real);
  row("latched", latched);

  const leverSavingUsd = real.totalCostUsd - latched.totalCostUsd;
  const leverSavingPct = (leverSavingUsd / real.totalCostUsd) * 100;
  const realRacing = real.missReasons["racing-write"] ?? 0;
  console.log(`  HONEST LEVER CREDIT (latched vs REAL, never vs naive): $${leverSavingUsd.toFixed(4)} = ` +
    `${leverSavingPct.toFixed(1)}% of what this scenario's fan-out actually costs today; ` +
    `${realRacing}/${real.calls.length} calls collided without the lever.`);
  if (real.totalCostUsd > uncached.totalCostUsd) {
    console.log(`  WARNING: REAL ($${real.totalCostUsd.toFixed(4)}) costs MORE than not caching at all ` +
      `($${uncached.totalCostUsd.toFixed(4)}) — stamping cache_control on this fan-out WITHOUT the latch is a ` +
      `net loss here, not merely a smaller win: every collision pays a write premium and reads nothing back.`);
  }
  return { naive, real, latched, uncached, leverSavingPct, realRacing };
}

console.log(`shared prefix at ${approximateTokenCount(SHARED_PREFIX)} tokens — clears the 1,024-token minimum, so this lever is in scope.`);

// Scenario A — a busy orchestrator: rounds close enough together (90s) that
// the shared prefix, once written, stays warm across EVERY later round
// within the same session. This is the case the lever backlog's "92% per
// racer" framing implicitly assumed recurs every round; it does not.
const busy = scenario("busy multi-agent team (same session, prefix stays warm)", 90);

// Scenario B — a bursty, ticket-queue-driven team: each round is a separate
// ticket arriving after the team has been idle long enough (600s > the 300s
// TTL) that the PREVIOUS ticket's cache write has already expired. Every
// ticket's fan-out therefore re-collides from a cold prefix, exactly like
// round 0 of scenario A.
const bursty = scenario("bursty ticket-queue team (prefix expires between tickets)", 600);

console.log(
  `\n=== what this fixture actually shows, stated plainly ===\n` +
  `The collision this lever fixes is a COLD-START cost on the shared prefix, not a per-round tax: once any ` +
  `round's fan-out has written the prefix and a later round reads it inside the 5m TTL, there is nothing left ` +
  `to collide on. A busy, continuously-running multi-agent team pays the collision cost once per cold start ` +
  `(here: ${busy.realRacing} collided calls out of ${ROUNDS * SUB_AGENT_ROLES.length} total, all in round 0) and ` +
  `the lever's credit (${busy.leverSavingPct.toFixed(1)}% of that scenario's total cost) is correspondingly ` +
  `small over a long session. A bursty, ticket-at-a-time team whose idle gaps between tickets exceed the TTL ` +
  `re-collides on EVERY ticket's fan-out (here: ${bursty.realRacing}/${ROUNDS * SUB_AGENT_ROLES.length}, one per ` +
  `round) and the same lever is worth ${bursty.leverSavingPct.toFixed(1)}% of that scenario's total cost — a ` +
  `materially larger, recurring number on exactly the deployment shape (support/ops ticket queues, scheduled ` +
  `review bots) where it is least likely that caching already solved this on its own.\n\n` +
  `Basis for both: SIMULATOR-MEASURED on a synthetic fixture built from documented concurrent-dispatch framework ` +
  `behaviour (LangGraph's superstep — docs.langchain.com/oss/python/langgraph/graph-api-control-flow, ` +
  `langchain-ai.github.io/langgraph/how-tos/branching — and CrewAI's async task/crew dispatch — ` +
  `docs.crewai.com/en/learn/kickoff-async), with an ESTIMATED ${TTFB_ESTIMATE_SECONDS}s time-to-first-byte (see ` +
  `header comment for the citation and why it is, if anything, conservative for this fixture's prefix size). Real ` +
  `production collision FREQUENCY — how often an orchestrator's idle gap between fan-outs actually exceeds the ` +
  `TTL — is unmeasured; this fixture brackets it with the two regimes above rather than asserting one blended ` +
  `number. Never quote either percentage as a portfolio-wide saving without that bracketing.`,
);
