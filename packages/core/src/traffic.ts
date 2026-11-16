import { createHash } from "node:crypto";
import { lookupPrice, priceUsage, resolveModelId, type PriceCatalogue } from "./price-catalogue.js";
import { PUBLISHED_LEVERS, minimumCacheableTokensFor, type Lever, type WorkloadProfile } from "./savings-model.js";
import { auditToolCatalogue, type ToolCatalogueAudit } from "./tool-schema.js";
import {
  analysePromptCaching,
  approximateTokenCount,
  dedupeRepeatedBlocks,
  recommendOutputCap,
  type CachingAnalysis,
  type OutputCapAdvice,
  type TokenCounter,
} from "./token-reduction.js";

/**
 * Ingest real traffic and measure what a reduction would be worth on it.
 *
 * Two tiers of input, because most teams can produce the first immediately and
 * the second only after a conversation about privacy:
 *
 *   Tier 1, usage only (model, token counts, date): prices the baseline, finds
 *     the model mix, and recommends output caps. No prompt text is needed, so
 *     this runs on billing exports.
 *   Tier 2, usage plus prompt text: adds prefix-cache analysis, what is breaking
 *     the cache, duplicate context, and measured tool-schema overhead.
 *
 * Nothing here performs I/O or leaves the process. Prompt text is used to
 * compute counts and hashes and is never copied into a report.
 */

export type TrafficRecord = {
  id: string;
  model: string;
  provider: string;
  /** ISO date the request was billed on, used to resolve the rate that applied. */
  at: string;
  inputTokens: number;
  outputTokens: number;
  /** Input already served from the provider's cache. A saving the customer HAS. */
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** Full prompt text, when the log carries it. Enables tier 2 analysis. */
  promptText?: string;
  /** Serialised tool or function definitions sent with the request. */
  toolSchemaText?: string;
  /** Logical grouping. Prompts only share a prefix within one workload. */
  workload: string;
  /**
   * Task this request belongs to, where the log says so. Several requests share
   * one episode id when an agent takes several turns to finish one job.
   */
  episodeId?: string;
};

export type IngestIssue = { line: number; reason: string };

export type IngestResult = {
  records: TrafficRecord[];
  issues: IngestIssue[];
  /** Which adapter matched each record, so an odd result can be traced. */
  adapterCounts: Record<string, number>;
};

type Row = Record<string, unknown>;

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function nested(row: Row, path: string[]): unknown {
  let current: unknown = row;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Row)[key];
  }
  return current;
}

/** Collapse any message/content shape the providers use into plain text. */
function flattenContent(value: unknown): string {
  if (typeof value === "string") return value;
  // Blank-line joined, so block-level analysis can tell messages apart.
  if (Array.isArray(value)) return value.map(flattenContent).filter(Boolean).join("\n\n");
  if (typeof value === "object" && value !== null) {
    const row = value as Row;
    const text = asString(row.text) ?? asString(row.content);
    if (text !== undefined) return text;
    if (Array.isArray(row.content)) return flattenContent(row.content);
  }
  return "";
}

function promptTextFrom(request: Row | undefined): string | undefined {
  if (!request) return undefined;
  const parts: string[] = [];
  const instructions = asString(request.instructions) ?? asString(request.system);
  if (instructions !== undefined) parts.push(instructions);
  else if (Array.isArray(request.system)) parts.push(flattenContent(request.system));
  const body = request.input ?? request.messages ?? request.prompt;
  const flattened = flattenContent(body);
  if (flattened !== "") parts.push(flattened);
  const joined = parts.join("\n\n");
  return joined === "" ? undefined : joined;
}

function toolSchemaTextFrom(request: Row | undefined): string | undefined {
  if (!request) return undefined;
  const tools = request.tools ?? request.functions;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return JSON.stringify(tools);
}

/**
 * Pull a task identifier out of whatever the log calls it.
 *
 * Checked in order of how specifically each names a single task: an explicit
 * episode id, then conversation/thread/session, then an OpenTelemetry trace,
 * then a run id. `previous_response_id` is checked last and only as a marker
 * that the row belongs to a chain, since it names the predecessor rather than
 * the chain itself.
 */
function episodeIdFrom(outer: Row, request: Row, response: Row): string | undefined {
  const candidates = [
    outer.episodeId, outer.episode_id,
    outer.conversationId, outer.conversation_id,
    outer.threadId, outer.thread_id,
    outer.sessionId, outer.session_id,
    outer.traceId, outer.trace_id,
    outer.runId, outer.run_id,
    nested(outer, ["metadata", "session_id"]),
    nested(outer, ["metadata", "conversation_id"]),
    nested(request, ["metadata", "session_id"]),
    nested(request, ["metadata", "conversation_id"]),
    nested(response, ["metadata", "session_id"]),
  ];
  for (const candidate of candidates) {
    const value = asString(candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

function providerFor(model: string, explicit?: string): string {
  if (explicit) return explicit;
  if (/^(?:claude|opus|sonnet|haiku|fable)/i.test(model)) return "anthropic";
  if (/^(?:gpt|o\d|chatgpt|text-)/i.test(model)) return "openai";
  if (/^gemini/i.test(model)) return "google";
  return "unknown";
}

/**
 * Normalise one logged row.
 *
 * Accepts the OpenAI Responses and Chat Completions shapes, the Anthropic
 * Messages shape, and a bare usage row, with the request and response either
 * nested under `request`/`response` or flattened onto one object. Returns the
 * adapter that matched so a surprising report can be traced to its parser.
 */
export function normaliseTrafficRow(
  row: unknown,
  fallbackDate: string,
  index: number,
): { record: TrafficRecord; adapter: string } | { issue: string } {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return { issue: "Row is not a JSON object." };
  }
  const outer = row as Row;
  const request = (typeof outer.request === "object" && outer.request !== null
    ? outer.request
    : outer) as Row;
  const response = (typeof outer.response === "object" && outer.response !== null
    ? outer.response
    : outer) as Row;
  const usage = (nested(response, ["usage"]) ?? outer.usage ?? outer) as Row;

  const model = asString(request.model) ?? asString(response.model) ?? asString(outer.model);
  if (model === undefined) return { issue: "No model field found." };

  let adapter: string;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let cacheWriteInputTokens: number | undefined;

  const anthropicCacheRead = asNumber(usage.cache_read_input_tokens);
  const anthropicCacheWrite = asNumber(usage.cache_creation_input_tokens);
  if (anthropicCacheRead !== undefined || anthropicCacheWrite !== undefined) {
    adapter = "anthropic-messages";
    // Anthropic reports cache reads and writes OUTSIDE input_tokens.
    const fresh = asNumber(usage.input_tokens) ?? 0;
    cachedInputTokens = anthropicCacheRead ?? 0;
    cacheWriteInputTokens = anthropicCacheWrite ?? 0;
    inputTokens = fresh + cachedInputTokens + cacheWriteInputTokens;
    outputTokens = asNumber(usage.output_tokens);
  } else if (asNumber(usage.prompt_tokens) !== undefined) {
    adapter = "openai-chat";
    inputTokens = asNumber(usage.prompt_tokens);
    outputTokens = asNumber(usage.completion_tokens);
    cachedInputTokens = asNumber(nested(usage, ["prompt_tokens_details", "cached_tokens"])) ?? 0;
  } else if (asNumber(usage.input_tokens) !== undefined) {
    adapter = "openai-responses";
    inputTokens = asNumber(usage.input_tokens);
    outputTokens = asNumber(usage.output_tokens);
    // Responses reports cached tokens INSIDE input_tokens, under a details
    // object. Flattened exports often hoist the same count to the top level,
    // so fall back to that rather than silently reading zero cached tokens and
    // claiming a caching saving the customer already has.
    cachedInputTokens = asNumber(nested(usage, ["input_tokens_details", "cached_tokens"])) ??
      asNumber(outer.cachedInputTokens) ?? asNumber(outer.cached_tokens) ?? 0;
  } else {
    adapter = "usage-row";
    inputTokens = asNumber(outer.inputTokens) ?? asNumber(outer.input_tokens);
    outputTokens = asNumber(outer.outputTokens) ?? asNumber(outer.output_tokens);
    cachedInputTokens = asNumber(outer.cachedInputTokens) ?? asNumber(outer.cached_tokens) ?? 0;
  }

  if (inputTokens === undefined || outputTokens === undefined) {
    return { issue: `Adapter ${adapter} found no usable input/output token counts.` };
  }
  if ((cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0) > inputTokens) {
    return { issue: `Cached tokens exceed total input tokens (${adapter}).` };
  }

  const at = asString(outer.at) ?? asString(outer.date) ?? asString(outer.timestamp)?.slice(0, 10) ??
    asString(outer.created_at)?.slice(0, 10) ?? fallbackDate;
  const promptText = promptTextFrom(request);

  return {
    adapter,
    record: {
      id: asString(outer.id) ?? asString(response.id) ?? `row-${index}`,
      model,
      provider: providerFor(model, asString(outer.provider)),
      at: /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : fallbackDate,
      inputTokens,
      outputTokens,
      ...(cachedInputTokens ? { cachedInputTokens } : {}),
      ...(cacheWriteInputTokens ? { cacheWriteInputTokens } : {}),
      ...(promptText === undefined ? {} : { promptText }),
      ...(toolSchemaTextFrom(request) === undefined ? {} : { toolSchemaText: toolSchemaTextFrom(request)! }),
      workload: asString(outer.workload) ?? asString(outer.endpoint) ?? asString(outer.taskClass) ?? model,
      ...(episodeIdFrom(outer, request, response) === undefined
        ? {}
        : { episodeId: episodeIdFrom(outer, request, response)! }),
    },
  };
}

/** Normalise many rows, collecting per-row problems rather than failing the run. */
export function ingestTraffic(rows: unknown[], fallbackDate: string): IngestResult {
  const records: TrafficRecord[] = [];
  const issues: IngestIssue[] = [];
  const adapterCounts: Record<string, number> = {};
  rows.forEach((row, index) => {
    const result = normaliseTrafficRow(row, fallbackDate, index);
    if ("issue" in result) {
      issues.push({ line: index + 1, reason: result.issue });
      return;
    }
    records.push(result.record);
    adapterCounts[result.adapter] = (adapterCounts[result.adapter] ?? 0) + 1;
  });
  return { records, issues, adapterCounts };
}

/**
 * Per-task view of a workload.
 *
 * The unit that matters for agentic traffic, and the one the market does not
 * report. A technique that cuts each prompt by 91% while tripling the number of
 * prompts has saved nothing, and per-request figures cannot show that: one
 * published bench found progressive disclosure modelled at ~77% delivering ~13%
 * in production, because a router adds a round trip per novel tool call.
 *
 * `identified` matters. Without a task identifier in the log every request is
 * its own episode, round trips read as 1.0, and nothing here is informative.
 * It is reported rather than silently assumed.
 */
export type EpisodeStats = {
  episodes: number;
  /** Mean requests per task. This is the round-trip count a technique can change. */
  meanRoundTrips: number;
  maxRoundTrips: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanCostUsd?: number;
  /** False when the log carried no task identifier, making the above meaningless. */
  identified: boolean;
};

export type WorkloadMeasurement = {
  workload: string;
  /** Model identifier exactly as the log carried it. */
  model: string;
  /** Catalogue key the identifier resolved to, when it resolved at all. */
  resolvedModel?: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens the provider already served from cache before MESH touched anything. */
  alreadyCachedInputTokens: number;
  meanToolSchemaTokens: number;
  /** Measured from the request's own tool definitions; absent when none were sent. */
  toolAudit?: ToolCatalogueAudit;
  /** Present only when the log carried prompt text. */
  caching?: CachingAnalysis;
  outputCap?: OutputCapAdvice;
  duplicateContextTokens: number;
  episodes: EpisodeStats;
  baselineCostUsd?: number;
  /** Set when the catalogue cannot price this model on these dates. */
  unpricedReason?: string;
};

export type TrafficMeasurement = {
  requests: number;
  workloads: WorkloadMeasurement[];
  totalBaselineCostUsd: number;
  /** Models the catalogue could not price; their spend is excluded, never assumed zero. */
  unpricedModels: string[];
  /** Share of input tokens already arriving cached, which MESH must not claim credit for. */
  alreadyCachedShare: number;
  promptTextAvailable: boolean;
  /** True when at least one record carried a task identifier. */
  episodesIdentified: boolean;
  notes: string[];
};

function groupKey(record: TrafficRecord): string {
  return `${record.workload} ${record.provider} ${record.model}`;
}

/**
 * Measure a traffic sample.
 *
 * Deliberately conservative in two places. Input already arriving cached is
 * reported separately and never counted as a MESH saving, because the customer
 * already has it. And a model the catalogue cannot price is named and excluded
 * rather than treated as free, the same discipline applied to benchmark sources.
 */
export function measureTraffic(
  records: TrafficRecord[],
  catalogue: PriceCatalogue,
  options: { countTokens?: TokenCounter; maximumPromptSample?: number } = {},
): TrafficMeasurement {
  if (records.length === 0) throw new Error("Measuring traffic needs at least one record.");
  const countTokens = options.countTokens ?? approximateTokenCount;
  const maximumPromptSample = options.maximumPromptSample ?? 400;
  const notes: string[] = [];

  const groups = new Map<string, TrafficRecord[]>();
  for (const record of records) {
    const key = groupKey(record);
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }

  const workloads: WorkloadMeasurement[] = [];
  const unpricedModels = new Set<string>();
  let totalBaselineCostUsd = 0;
  let totalInputTokens = 0;
  let totalAlreadyCached = 0;
  let anyPromptText = false;

  for (const group of groups.values()) {
    const first = group[0]!;
    const inputTokens = group.reduce((sum, record) => sum + record.inputTokens, 0);
    const outputTokens = group.reduce((sum, record) => sum + record.outputTokens, 0);
    const alreadyCachedInputTokens = group.reduce((sum, record) => sum + (record.cachedInputTokens ?? 0), 0);
    totalInputTokens += inputTokens;
    totalAlreadyCached += alreadyCachedInputTokens;

    const resolution = resolveModelId(catalogue, first.provider, first.model);
    const resolvedModel = resolution.status === "resolved" ? resolution.model : undefined;

    // Baseline cost is priced per record, because rates are dated.
    let baselineCostUsd: number | undefined = 0;
    let unpricedReason: string | undefined;
    if (resolvedModel === undefined) {
      baselineCostUsd = undefined;
      unpricedReason = resolution.status === "unresolved" ? resolution.reason : "Model did not resolve.";
      unpricedModels.add(`${first.provider}/${first.model}`);
    }
    if (resolvedModel !== undefined) {
      let running = 0;
      for (const record of group) {
        const priced = priceUsage(catalogue, { provider: record.provider, model: resolvedModel, at: record.at }, {
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cachedInputTokens: record.cachedInputTokens,
          cacheWriteInputTokens: record.cacheWriteInputTokens,
        });
        if (priced.status === "unpriced") {
          unpricedReason = priced.reason;
          baselineCostUsd = undefined;
          unpricedModels.add(`${record.provider}/${record.model}`);
          break;
        }
        running += priced.costUsd;
      }
      if (baselineCostUsd !== undefined) baselineCostUsd = running;
    }
    if (baselineCostUsd !== undefined) totalBaselineCostUsd += baselineCostUsd;

    const withPrompts = group.filter((record) => record.promptText !== undefined);
    if (withPrompts.length > 0) anyPromptText = true;

    const toolSchemaTokens = group
      .filter((record) => record.toolSchemaText !== undefined)
      .map((record) => countTokens(record.toolSchemaText!));
    const meanToolSchemaTokens = toolSchemaTokens.length === 0
      ? 0
      : toolSchemaTokens.reduce((sum, value) => sum + value, 0) / toolSchemaTokens.length;

    // Audit the catalogue itself rather than assuming a published reduction
    // factor, so a workload with an already-lean catalogue is credited nothing.
    let toolAudit: ToolCatalogueAudit | undefined;
    const withTools = group.find((record) => record.toolSchemaText !== undefined);
    if (withTools !== undefined) {
      try {
        const parsed = JSON.parse(withTools.toolSchemaText!);
        if (Array.isArray(parsed)) toolAudit = auditToolCatalogue(parsed, { countTokens });
      } catch {
        notes.push(`${first.workload}: tool definitions could not be parsed, so no catalogue audit was run.`);
      }
    }

    let caching: CachingAnalysis | undefined;
    if (withPrompts.length >= 2) {
      const lookup = resolvedModel === undefined
        ? ({ status: "unpriced" } as const)
        : lookupPrice(catalogue, { provider: first.provider, model: resolvedModel, at: first.at });
      const sample = withPrompts.slice(0, maximumPromptSample).map((record) => record.promptText!);
      if (sample.length < withPrompts.length) {
        notes.push(
          `${first.workload}: prefix analysis used the first ${sample.length} of ${withPrompts.length} prompts.`,
        );
      }
      caching = analysePromptCaching(sample, {
        countTokens,
        // The floor depends on the model class (Haiku needs 2,048 tokens).
        minimumCacheableTokens: minimumCacheableTokensFor(first.provider, resolvedModel ?? first.model),
        ...(lookup.status === "priced" ? { price: lookup.price } : {}),
      });
    }

    const duplicateContextTokens = withPrompts.reduce((sum, record) => {
      const reduced = dedupeRepeatedBlocks(24, countTokens).reduce(record.promptText!);
      return sum + (countTokens(record.promptText!) - countTokens(reduced.text));
    }, 0);

    const byEpisode = new Map<string, TrafficRecord[]>();
    for (const record of group) {
      const key = record.episodeId ?? `__single__${record.id}`;
      const list = byEpisode.get(key) ?? [];
      list.push(record);
      byEpisode.set(key, list);
    }
    const episodeGroups = [...byEpisode.values()];
    const identified = group.some((record) => record.episodeId !== undefined);
    const roundTrips = episodeGroups.map((episode) => episode.length);
    const episodes: EpisodeStats = {
      episodes: episodeGroups.length,
      meanRoundTrips: roundTrips.reduce((sum, value) => sum + value, 0) / episodeGroups.length,
      maxRoundTrips: Math.max(...roundTrips),
      meanInputTokens: inputTokens / episodeGroups.length,
      meanOutputTokens: outputTokens / episodeGroups.length,
      ...(baselineCostUsd === undefined ? {} : { meanCostUsd: baselineCostUsd / episodeGroups.length }),
      identified,
    };

    workloads.push({
      workload: first.workload,
      model: first.model,
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
      provider: first.provider,
      requests: group.length,
      inputTokens,
      outputTokens,
      alreadyCachedInputTokens,
      meanToolSchemaTokens,
      ...(toolAudit ? { toolAudit } : {}),
      ...(caching ? { caching } : {}),
      ...(group.length >= 2
        ? { outputCap: recommendOutputCap(group.map((record) => record.outputTokens), { quantile: 0.99 }) }
        : {}),
      duplicateContextTokens,
      episodes,
      ...(baselineCostUsd === undefined ? {} : { baselineCostUsd }),
      ...(unpricedReason === undefined ? {} : { unpricedReason }),
    });
  }

  const episodesIdentified = records.some((record) => record.episodeId !== undefined);
  if (!episodesIdentified) {
    notes.push(
      "No task identifier was found, so every request counts as its own episode and round trips read as 1.0. " +
      "Per-task figures are the unit that matters for agentic traffic: add a conversation, session or trace id " +
      "to the log before trusting any technique that changes how many calls a task takes.",
    );
  }
  if (!anyPromptText) {
    notes.push(
      "No prompt text was present, so this is a usage-only measurement: baseline spend and output caps only. " +
      "Prefix-cache headroom, the largest risk-free lever, cannot be measured without prompts.",
    );
  }
  if (unpricedModels.size > 0) {
    notes.push(
      `${unpricedModels.size} model identifier(s) did not resolve to a catalogued rate. Their spend is excluded ` +
      "from the baseline rather than counted as zero; add a dated entry or an alias to include them.",
    );
  }

  workloads.sort((left, right) => (right.baselineCostUsd ?? 0) - (left.baselineCostUsd ?? 0));

  return {
    requests: records.length,
    workloads,
    totalBaselineCostUsd,
    unpricedModels: [...unpricedModels].sort(),
    alreadyCachedShare: totalInputTokens === 0 ? 0 : totalAlreadyCached / totalInputTokens,
    promptTextAvailable: anyPromptText,
    episodesIdentified,
    notes,
  };
}

/** Stable fingerprint of a traffic sample, so repeated runs can be compared. */
export function trafficFingerprint(records: TrafficRecord[]): string {
  const hash = createHash("sha256");
  for (const record of [...records].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(`${record.id}|${record.model}|${record.inputTokens}|${record.outputTokens}|${record.at}`);
  }
  return hash.digest("hex").slice(0, 16);
}


/**
 * Turn a measured workload into a profile the savings model can project on.
 *
 * Segments come from what was actually observed rather than assumed: the tool
 * catalogue is measured from the request's own tool definitions, the stable
 * prefix from what the sampled prompts genuinely share, and whatever remains is
 * treated as the volatile body. Tokens already arriving cached are removed from
 * the stable segment, because that saving is the customer's already.
 */
export function profileFromMeasurement(
  measurement: WorkloadMeasurement,
  options: { repairPrefix?: boolean } = {},
): WorkloadProfile {
  const requests = Math.max(1, measurement.requests);
  const meanInput = measurement.inputTokens / requests;
  const meanOutput = measurement.outputTokens / requests;
  const meanAlreadyCached = measurement.alreadyCachedInputTokens / requests;
  const toolSchemas = Math.min(meanInput, measurement.meanToolSchemaTokens);

  // With repairPrefix, credit the prefix that WOULD cache once per-request values
  // (timestamps, request ids) are moved out of it. That is a real and usually
  // large lever, but it needs a prompt change, so it is opt-in and reported
  // separately rather than folded into the as-is projection.
  const observedPrefix = options.repairPrefix
    ? Math.max(
      measurement.caching?.sharedPrefixTokens ?? 0,
      measurement.caching?.recoverablePrefixTokens ?? 0,
    )
    : measurement.caching?.sharedPrefixTokens ?? 0;
  // Credit only the prefix that is not already being served from cache.
  const uncachedPrefix = Math.max(0, observedPrefix - meanAlreadyCached);
  const systemPrompt = Math.max(0, Math.min(meanInput - toolSchemas, uncachedPrefix));
  // Measured duplicate blocks are modelled as retrieved context, which is the
  // segment the lossless dedup lever reaches. Without this the duplicates are
  // reported but never credited.
  const meanDuplicate = measurement.duplicateContextTokens / requests;
  const retrievedContext = Math.max(0, Math.min(meanInput - toolSchemas - systemPrompt, meanDuplicate));
  const userTurn = Math.max(0, meanInput - toolSchemas - systemPrompt - retrievedContext);

  return {
    name: `${measurement.workload} (${measurement.provider}/${measurement.model})`,
    requests,
    segments: {
      toolSchemas,
      systemPrompt,
      retrievedContext,
      history: 0,
      userTurn,
      output: meanOutput,
    },
    stableSegments: [
      ...(toolSchemas > 0 ? (["toolSchemas"] as const) : []),
      ...(systemPrompt > 0 ? (["systemPrompt"] as const) : []),
    ],
  };
}

/**
 * Build the lever set a measured workload actually supports.
 *
 * `leversFor` applies published reduction factors to any profile with non-empty
 * segments, which is right for archetype modelling and wrong for a customer
 * report: it credited a 60% output reduction to workloads whose replies were
 * already short and tight, and that was the only lever firing on most samples.
 *
 * Here every factor is either measured from the sample or gated on measured
 * evidence that the lever applies at all:
 *
 *   - Output capping uses the observed length distribution, so a workload with
 *     no long tail is credited nothing.
 *   - Duplicate removal is credited exactly the duplicate tokens found.
 *   - Tool levers keep their published factors, which are deterministic
 *     transformations of a catalogue we measured directly, but only fire when
 *     tool definitions were actually present.
 *   - Reasoning-effort tuning is offered only where mean output is long enough
 *     for reasoning tokens to plausibly dominate, at well under the published
 *     factor, and always as needs-verification.
 *
 * Prompt compression and history compaction are deliberately absent. Their
 * published factors are real but workload-specific, and nothing in a usage log
 * measures whether they transfer. They belong behind a replay check, not in an
 * opening projection.
 */
export function leversFromMeasurement(measurement: WorkloadMeasurement): Lever[] {
  const requests = Math.max(1, measurement.requests);
  const levers: Lever[] = [];

  const audit = measurement.toolAudit;
  if (audit && audit.tokens > 0) {
    if (audit.losslessTokensSaved > 0) {
      levers.push({
        ...PUBLISHED_LEVERS.toolSchemaCompaction!,
        reduction: Math.min(1, audit.losslessTokensSaved / audit.tokens),
        evidence: {
          source: "Measured in this sample",
          claim:
            `${audit.tools} tools, ${Math.round(audit.tokens)} tokens. ` +
            `${Math.round(audit.losslessTokensSaved)} tokens are indentation, schema plumbing and titles that ` +
            "restate their property name. The decoded schema is unchanged, so tool selection cannot change.",
        },
      });
    }
    if (audit.descriptionTokensSaved > 0) {
      levers.push({
        ...PUBLISHED_LEVERS.toolSchemaMinification!,
        reduction: Math.min(1, audit.descriptionTokensSaved / audit.tokens),
        evidence: {
          source: "Measured in this sample",
          claim:
            `Truncating tool descriptions to 24 tokens recovers ${Math.round(audit.descriptionTokensSaved)} ` +
            `tokens of ${Math.round(audit.tokens)}. Descriptions are how the model chooses between tools, so ` +
            "this needs a replay check on tool-selection accuracy before rollout.",
        },
      });
    }
  }
  // unused-tool-removal is deliberately absent. Nothing in a usage log shows a
  // tool is unreachable for the workload, only that it was not called in this
  // sample, and removing a tool the model would have needed is a quality
  // regression rather than a saving. It needs call-frequency evidence first.

  if (measurement.duplicateContextTokens > 0) {
    levers.push({
      ...PUBLISHED_LEVERS.duplicateContextRemoval!,
      // The retrievedContext segment holds exactly the duplicates we measured.
      reduction: 1,
      evidence: {
        source: "Measured in this sample",
        claim:
          `${Math.round(measurement.duplicateContextTokens)} tokens of exactly duplicated blocks across ` +
          `${requests} requests. Removing an exact duplicate cannot change the prompt's meaning.`,
      },
    });
  }

  const cap = measurement.outputCap;
  if (cap && cap.projectedTokensSaved > 0 && measurement.outputTokens > 0) {
    levers.push({
      id: "output-cap",
      description:
        `Cap max_output_tokens at ${cap.recommendedCap}, the 99th percentile of this workload's observed ` +
        "response lengths, trimming only the tail beyond it.",
      risk: "needs-verification",
      targets: ["output"],
      reduction: Math.min(1, cap.projectedTokensSaved / measurement.outputTokens),
      evidence: {
        source: "Measured in this sample",
        claim:
          `Observed mean ${Math.round(cap.meanOutputTokens)} and maximum ${cap.maxObserved} output tokens. ` +
          `A cap of ${cap.recommendedCap} truncates ${(cap.truncationRate * 100).toFixed(1)}% of responses, ` +
          "so it needs a replay check on those before rollout.",
      },
    });
  }

  const meanOutput = measurement.outputTokens / requests;
  if (meanOutput > 1_000) {
    levers.push({
      id: "reasoning-effort",
      description:
        "Match reasoning effort to task difficulty via reasoning_effort or budget_tokens, rather than reasoning " +
        "at full effort on every request.",
      risk: "needs-verification",
      // TALE-EP reports 67%; held to 30% because nothing in a usage log confirms
      // how much of this output is reasoning rather than answer.
      reduction: 0.3,
      targets: ["output"],
      evidence: {
        source: "TALE-EP; arXiv:2508.17196 (BudgetThinker)",
        claim:
          `Mean output of ${Math.round(meanOutput)} tokens is long enough for reasoning tokens to be a large ` +
          "share. Published results cut output 67% at under 3% accuracy loss, and on GSM8K accuracy rose while " +
          "output fell 318 to 77 tokens. Modelled at 30% because usage logs do not separate reasoning from answer.",
      },
    });
  }

  return levers;
}
