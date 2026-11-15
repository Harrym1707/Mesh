import { pathToFileURL } from "node:url";
import { ShadowCoalescingRecorder, type ShadowEvent } from "./recorder.js";

/**
 * Synthetic event-log generator — FABRICATED traffic to exercise the recorder +
 * analyzer end to end without any live calls. The numbers it produces are NOT a
 * measurement of anything; they only prove the pipeline computes what it claims.
 * Real bands come only from recorder events captured on real traffic.
 *
 * It models a few scopes (tenants) issuing deterministic classification requests,
 * with occasional concurrent duplicate bursts (the thing S2 would collapse), plus
 * some unique traffic, some non-deterministic traffic (gated), and some streaming
 * /tool requests (hard-ineligible).
 */

type Plan = {
  scopes: number;
  requests: number;
  /** Probability a request is part of a concurrent duplicate burst. */
  burstProbability: number;
  /** How many extra followers a burst spawns. */
  burstFollowers: number;
  seed: number;
};

const DEFAULT_PLAN: Plan = { scopes: 3, requests: 400, burstProbability: 0.12, burstFollowers: 2, seed: 1 };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateEvents(plan: Plan = DEFAULT_PLAN): ShadowEvent[] {
  const rand = mulberry32(plan.seed);
  const events: ShadowEvent[] = [];
  let clock = 0;
  const recorder = new ShadowCoalescingRecorder({
    getScopeKey: (request) => (request as { scope?: string }).scope,
    emit: (event) => events.push(event),
    now: () => clock,
  });

  const prompts = ["classify sentiment", "extract entities", "tag intent", "detect language", "score toxicity"];

  for (let i = 0; i < plan.requests; i += 1) {
    clock += 1 + Math.floor(rand() * 40); // ms between arrivals
    const scope = `tenant-${Math.floor(rand() * plan.scopes)}`;
    const roll = rand();

    if (roll < 0.08) {
      // Hard-ineligible: a streaming or tool request.
      const streaming = rand() < 0.5;
      const request = streaming
        ? { scope, model: "gpt-x", stream: true, messages: [{ role: "user", content: prompts[0] }] }
        : { scope, model: "gpt-x", tools: [{ name: "lookup" }], messages: [{ role: "user", content: prompts[1] }] };
      const handle = recorder.begin(request);
      clock += 200 + Math.floor(rand() * 800);
      recorder.end(handle, { inputTokens: 500, outputTokens: 50, costUsd: 0.002 });
      continue;
    }

    const nonDeterministic = roll < 0.18; // gated band
    const prompt = prompts[Math.floor(rand() * prompts.length)]!;
    const makeRequest = () => ({
      scope,
      model: "gpt-x",
      ...(nonDeterministic ? { temperature: 0.7 } : { temperature: 0 }),
      messages: [{ role: "user", content: prompt }],
    });

    const leaderLatency = 150 + Math.floor(rand() * 1200);
    const burst = rand() < plan.burstProbability;

    // Leader arrives now and runs for leaderLatency.
    const leader = recorder.begin(makeRequest());
    const leaderStart = clock;

    if (burst) {
      // Followers arrive DURING the leader's window (identical body, same scope).
      for (let f = 0; f < plan.burstFollowers; f += 1) {
        clock = leaderStart + Math.floor(rand() * leaderLatency * 0.8);
        const follower = recorder.begin(makeRequest());
        clock += 150 + Math.floor(rand() * 1200);
        recorder.end(follower, { inputTokens: 520, cachedInputTokens: 0, outputTokens: 48, costUsd: 0.0021 });
      }
    }

    clock = leaderStart + leaderLatency;
    recorder.end(leader, { inputTokens: 520, cachedInputTokens: 0, outputTokens: 48, costUsd: 0.0021 });
  }

  return events;
}

function main(): void {
  for (const event of generateEvents()) console.log(JSON.stringify(event));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
