# @harrym1707/signal — MESH Signal

Stage 12 of the MESH build roadmap: the **AI-visibility measurement system**.

MESH Signal measures how a brand (MESH) is represented across AI search / answer
engines. It is a measurement instrument for the GEO strategy, **not** a lever for
manipulating model output. The way to move these numbers is to improve the
underlying evidence — better docs, benchmarks, and references — exactly as the
GEO system doc requires.

## Why repeated measurement

AI answers vary between runs, so a single measurement is noise. This package is
built around that fact: the runner always takes **N full passes** over a
controlled prompt set and stores every run, and the aggregator reports both a
pooled headline rate **and the across-run distribution** (mean / stddev /
min / max). There is no single-shot result.

## The six signals

| Signal | Meaning |
| --- | --- |
| `mention` | the brand is named in the answer text |
| `citation` | the brand appears among the engine's cited sources |
| `link` | the answer contains a resolvable link to an owned domain |
| `category_association` | the brand is tied to a target category (e.g. LLM routing) |
| `factual_description` | the engine describes the brand, and whether correctly |
| `source_overlap` | fraction of cited sources that are the brand's own |

## Shape of the system

```
BrandProfile ─┐
              ▼
AnswerBackend ──► runMeasurements(runs=N) ──► MeasurementRun[] ──► aggregateRuns ──► SignalReport
   (injected)         (scoreAnswer per answer)                         (rates + distributions)
```

- **`schema.ts`** — the result schema (`BrandProfile`, `AnswerSample`,
  `SignalMeasurement`, `MeasurementRun`).
- **`scoring.ts`** — pure, deterministic scoring of one answer into six signals.
- **`runner.ts`** — the measurement loop. The search/model backend is **injected**
  (`AnswerBackend`), so nothing here calls a live API or needs a key.
- **`aggregate.ts`** — pooling and distributions across runs.
- **`mesh-profile.ts`** — the canonical MESH `BrandProfile` preset.

## Usage

```ts
import {
  runMeasurements,
  aggregateRuns,
  MESH_BRAND_PROFILE,
  type AnswerBackend,
} from "@harrym1707/signal";

// Supply your own backend. In production it queries a real engine; keep that
// adapter (and its API key) outside this package.
const backend: AnswerBackend = async (query) => {
  // ...call the engine, return an AnswerSample...
  return { engine: query.engine, query: query.query, text: "", citations: [] };
};

const runs = await runMeasurements({
  backend,
  brand: MESH_BRAND_PROFILE,
  prompts: [
    { engine: "chatgpt", query: "how do I reduce LLM cost?", queryId: "q-cost", categories: ["llm-cost-optimization"] },
  ],
  runs: 20, // take 20 passes; never trust one
});

const report = aggregateRuns(runs);
console.log(report.overall.mentionRate, report.distribution.mentionRate.stddev);
```

## Rate denominators

Denominators differ per signal, following the GEO spec:

- `mentionRate` = mentions / measurements
- `citationRate` = citations / mentions
- `linkRate` = links / mentions
- `descriptionPresentRate` = descriptions present / mentions
- `correctDescriptionRate` = correct descriptions / descriptions present

A `null` rate means the denominator was zero.

## Tests

`vitest run` — `scoring.test.ts`, `aggregate.test.ts`, `runner.test.ts`. All use
mocked backends and fixtures; **no live search/model API is called and no key is
required.**
