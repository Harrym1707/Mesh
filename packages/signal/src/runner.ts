/**
 * Runner — take repeated measurements across a prompt set.
 *
 * The search/model backend is injected, so the runner never calls a live API
 * and never needs a key. A real deployment passes a backend that queries an
 * engine; tests pass one that returns fixtures. Because AI answers vary between
 * runs, the runner always takes N full passes over the prompt set and returns
 * every run — aggregation over those runs is done in `aggregate.ts`.
 */

import type { AnswerSample, BrandProfile, MeasurementRun, SignalMeasurement } from "./schema.js";
import { scoreAnswer } from "./scoring.js";

/** One query to put to one engine. The unit of work a backend answers. */
export type EngineQuery = {
  engine: string;
  query: string;
  /** Stable id so the same query lines up across runs; defaults to `query`. */
  queryId?: string;
  /** Category ids this query is meant to probe. */
  categories?: string[];
};

/**
 * The injection boundary. A backend turns a query into a raw answer. It may be
 * async (a live engine) or sync-returning-a-promise (a fixture). It should not
 * throw for an engine failure — return an `AnswerSample` with `error` set so
 * the failure is recorded as a negative measurement; a thrown error is caught
 * by the runner and recorded the same way.
 */
export type AnswerBackend = (query: EngineQuery) => Promise<AnswerSample>;

export type RunMeasurementsOptions = {
  backend: AnswerBackend;
  brand: BrandProfile;
  /** The controlled prompt set, probed once per run. */
  prompts: EngineQuery[];
  /** How many full passes to take. Must be >= 1. */
  runs: number;
  /** Clock injection for deterministic timestamps in tests. */
  now?: () => Date;
  /** Run-id generator; defaults to `run-<index>`. */
  runId?: (runIndex: number) => string;
};

function sampleFromError(query: EngineQuery, error: unknown): AnswerSample {
  return {
    engine: query.engine,
    query: query.query,
    queryId: query.queryId,
    categories: query.categories,
    text: "",
    citations: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Take `runs` full passes over `prompts`, scoring every answer. Returns one
 * `MeasurementRun` per pass, each holding one `SignalMeasurement` per prompt.
 * Queries within a run are answered concurrently; runs are sequential so a
 * later run can, in principle, observe state a backend mutated in an earlier
 * one (and so timestamps are ordered).
 */
export async function runMeasurements(options: RunMeasurementsOptions): Promise<MeasurementRun[]> {
  const { backend, brand, prompts, runs } = options;
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`runMeasurements: runs must be a positive integer, got ${runs}`);
  }
  const clock = options.now ?? (() => new Date());
  const makeRunId = options.runId ?? ((index: number) => `run-${index}`);

  const out: MeasurementRun[] = [];
  for (let runIndex = 0; runIndex < runs; runIndex++) {
    const runId = makeRunId(runIndex);
    const runTimestamp = clock().toISOString();

    const measurements: SignalMeasurement[] = await Promise.all(
      prompts.map(async (query): Promise<SignalMeasurement> => {
        let sample: AnswerSample;
        try {
          sample = await backend(query);
        } catch (error) {
          sample = sampleFromError(query, error);
        }
        return scoreAnswer(sample, brand, { runId, timestamp: runTimestamp });
      }),
    );

    out.push({ runId, timestamp: runTimestamp, measurements });
  }
  return out;
}
