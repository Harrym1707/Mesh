import { approximateTokenCount, type TokenCounter } from "./token-reduction.js";

/**
 * Tool and MCP schema minification: the largest lever on agentic workloads.
 *
 * Tool catalogues are resent on every turn because the APIs are stateless, so a
 * 20-turn task pays for the whole catalogue 20 times. Measured on the sample
 * fixtures the catalogue was 66% of a request's input.
 *
 * Minification is split into two tiers and the distinction is not cosmetic.
 *
 *   Lossless (billable): schema plumbing the model does not read ($schema, $id,
 *   $comment) and `title` fields that only restate the property name — content
 *   the provider tokenises, so removing it is a real saving, billable without a
 *   quality gate. Whitespace / JSON formatting is NOT in this tier: the provider
 *   tokenises the PARSED structure, not the byte formatting (verified against
 *   Anthropic count_tokens — pretty vs compact tools return an identical count),
 *   so MESH compacts it as hygiene but never claims it as a saving.
 *
 *   Lossy: descriptions, examples, and dropping tools. Descriptions are how the
 *   model decides which tool to call, so trimming them is a behaviour change,
 *   not a formatting change. Published sources report the large savings here,
 *   but they belong behind a replay check.
 *
 * An earlier version of this project's savings model labelled description
 * trimming "deterministic". That was wrong, and it is the kind of error that
 * turns into a disputed invoice: the saving is real, the no-quality-risk claim
 * attached to it was not.
 */

/** Keys the provider's schema validator reads but the model never sees as prose. */
const PLUMBING_KEYS = new Set(["$schema", "$id", "$comment"]);

/**
 * JSON Schema's two shared-definition conventions: `$defs` (2020-12, what
 * Pydantic v2 and modern LangChain/MCP tool schemas emit) and `definitions`
 * (draft-07, still emitted by Pydantic v1 and some older generators). A
 * `$ref` can point into either. Earlier code treated `$defs` as plumbing and
 * deleted it unconditionally — which is wrong: Anthropic and OpenAI both
 * document support for `$ref`/`$defs` in tool schemas (nested Pydantic
 * models routinely compile to exactly this shape), so a tool with even one
 * nested model had its definitions block removed while its `$ref` pointers
 * stayed behind, pointing at nothing. That is corruption, not compaction.
 */
const DEFINITION_CONTAINER_KEYS = new Set(["$defs", "definitions"]);
const REF_PATTERN = /^#\/(?:\$defs|definitions)\/([^/]+)/;

/** Collect every `$ref` target name reachable from `node`, recursively. */
function collectRefNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefNames(item, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string") {
      const match = REF_PATTERN.exec(value);
      if (match?.[1] !== undefined) out.add(decodeURIComponent(match[1]));
      continue;
    }
    collectRefNames(value, out);
  }
}

/** Every named entry across all `$defs`/`definitions` containers in `tool`. */
function collectDefinitions(node: unknown, out: Map<string, unknown>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectDefinitions(item, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (DEFINITION_CONTAINER_KEYS.has(key) && typeof value === "object" && value !== null) {
      for (const [name, definition] of Object.entries(value as Record<string, unknown>)) {
        out.set(name, definition);
      }
      continue;
    }
    collectDefinitions(value, out);
  }
}

/**
 * Which named definitions in `tool` are actually reachable from a `$ref` the
 * model's schema walk would follow — starting from refs used OUTSIDE any
 * definitions container, then transitively through whatever those
 * definitions themselves reference. A definition unreachable from any live
 * `$ref` can be deleted with certainty: nothing in the schema can ever point
 * at it, so removing it changes zero bytes the model's traversal ever sees.
 */
function liveDefinitionNames(tool: unknown): Set<string> {
  const definitions = new Map<string, unknown>();
  collectDefinitions(tool, definitions);
  if (definitions.size === 0) return new Set();

  const seeds = new Set<string>();
  collectSeedRefs(tool, seeds);

  const live = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (live.has(name)) continue;
    live.add(name);
    const definition = definitions.get(name);
    if (definition === undefined) continue; // dangling ref to a name that was never defined
    const nested = new Set<string>();
    collectRefNames(definition, nested);
    for (const next of nested) if (!live.has(next)) queue.push(next);
  }
  return live;
}

/** Like {@link collectRefNames}, but does not descend into definitions
 *  containers — it finds only the refs the *usable* schema actually makes. */
function collectSeedRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSeedRefs(item, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (DEFINITION_CONTAINER_KEYS.has(key)) continue;
    if (key === "$ref" && typeof value === "string") {
      const match = REF_PATTERN.exec(value);
      if (match?.[1] !== undefined) out.add(decodeURIComponent(match[1]));
      continue;
    }
    collectSeedRefs(value, out);
  }
}

export type MinifyOptions = {
  /**
   * What to do with description fields.
   * `keep` stays lossless. `truncate` clips to `maximumDescriptionTokens`.
   * `drop` removes them, which is the largest saving and the largest risk.
   */
  descriptions?: "keep" | "truncate" | "drop";
  maximumDescriptionTokens?: number;
  /** Remove `examples` arrays. The model does read these, so this is lossy. */
  dropExamples?: boolean;
  /** Tool names to keep. Omit to keep all; naming a subset is lossy. */
  keepTools?: readonly string[];
  /**
   * Sort the retained tool array into a stable, name-ordered canonical order.
   * The set and schema of each tool is unchanged — only the array's order
   * moves — but a framework that resends the same catalogue in a different
   * order turn-to-turn (e.g. because it rebuilds the list from a mutable
   * registry) breaks the cache prefix on every such turn for no reason. Off
   * by default: it is a serialization-order change, so it ships opt-in.
   */
  canonicalOrder?: boolean;
  countTokens?: TokenCounter;
};

export type MinifyChange = {
  kind:
    | "plumbing"
    | "redundant-title"
    | "formatting"
    | "description"
    | "examples"
    | "dropped-tool"
    | "unused-definition"
    | "tool-order";
  lossless: boolean;
  /** Where in the catalogue, e.g. a tool name or a property path. */
  at: string;
  tokensSaved: number;
  detail: string;
};

export type MinifyResult = {
  tools: unknown[];
  tokensBefore: number;
  tokensAfter: number;
  /** Tokens removed without any possibility of changing tool selection. */
  losslessTokensSaved: number;
  /** Tokens removed by altering what the model reads. Needs a replay check. */
  lossyTokensSaved: number;
  changes: MinifyChange[];
};

function toolNameOf(tool: unknown, index: number): string {
  if (typeof tool === "object" && tool !== null) {
    const row = tool as Record<string, unknown>;
    const direct = typeof row.name === "string" ? row.name : undefined;
    const nested = typeof row.function === "object" && row.function !== null
      ? (row.function as Record<string, unknown>).name
      : undefined;
    return direct ?? (typeof nested === "string" ? nested : `tool-${index}`);
  }
  return `tool-${index}`;
}

function truncateToTokens(text: string, limit: number, countTokens: TokenCounter): string {
  if (countTokens(text) <= limit) return text;
  // Clip on a sentence boundary where one is available, so the remaining text
  // still reads as an instruction rather than breaking mid-clause.
  const sentences = text.split(/(?<=[.!?])\s+/);
  let kept = "";
  for (const sentence of sentences) {
    const candidate = kept === "" ? sentence : `${kept} ${sentence}`;
    if (countTokens(candidate) > limit) break;
    kept = candidate;
  }
  if (kept !== "") return kept;
  const words = text.split(/\s+/);
  let fallback = "";
  for (const word of words) {
    const candidate = fallback === "" ? word : `${fallback} ${word}`;
    if (countTokens(candidate) > limit) break;
    fallback = candidate;
  }
  return fallback;
}

/**
 * Minify a tool catalogue, reporting every change and which tier it belongs to.
 *
 * Defaults are lossless only: descriptions are kept. A caller wanting the large
 * saving opts into it explicitly and gets it reported as lossy.
 */
export function minifyToolSchemas(tools: unknown[], options: MinifyOptions = {}): MinifyResult {
  if (!Array.isArray(tools)) throw new Error("A tool catalogue must be an array.");
  const countTokens = options.countTokens ?? approximateTokenCount;
  const descriptions = options.descriptions ?? "keep";
  const maximumDescriptionTokens = options.maximumDescriptionTokens ?? 24;
  if (!Number.isInteger(maximumDescriptionTokens) || maximumDescriptionTokens < 1) {
    throw new Error("maximumDescriptionTokens must be a positive integer.");
  }
  const changes: MinifyChange[] = [];
  // Baseline is the COMPACT serialisation — what actually goes on the wire and
  // what the provider tokenises. Measuring "before" as pretty-printed (indented)
  // counted whitespace the provider never bills, which over-stated the saving
  // (verified against Anthropic count_tokens: pretty vs compact tools -> identical).
  const tokensBefore = countTokens(JSON.stringify(tools));

  const keep = options.keepTools === undefined ? undefined : new Set(options.keepTools);
  const retained: unknown[] = [];
  // Scoped to whichever tool `prune` is currently walking — recomputed per
  // tool because `$defs`/`definitions` and the `$ref`s pointing into them
  // are local to each tool's own parameter schema, not shared catalogue-wide.
  let currentLiveDefinitionNames: Set<string> = new Set();

  tools.forEach((tool, index) => {
    const name = toolNameOf(tool, index);
    if (keep !== undefined && !keep.has(name)) {
      changes.push({
        kind: "dropped-tool",
        lossless: false,
        at: name,
        tokensSaved: countTokens(JSON.stringify(tool)),
        detail: "Tool removed from the catalogue. The model cannot call what it cannot see, so this " +
          "is safe only where the tool is genuinely unreachable for the workload.",
      });
      return;
    }
    currentLiveDefinitionNames = liveDefinitionNames(tool);
    retained.push(prune(tool, name));
  });

  function prune(node: unknown, path: string): unknown {
    if (Array.isArray(node)) return node.map((item, index) => prune(item, `${path}[${index}]`));
    if (typeof node !== "object" || node === null) return node;
    const row = node as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (PLUMBING_KEYS.has(key)) {
        changes.push({
          kind: "plumbing",
          lossless: true,
          at: `${path}.${key}`,
          tokensSaved: countTokens(JSON.stringify({ [key]: value })),
          detail: `Removed ${key}, which the model never reads.`,
        });
        continue;
      }
      if (DEFINITION_CONTAINER_KEYS.has(key) && typeof value === "object" && value !== null) {
        const kept: Record<string, unknown> = {};
        for (const [defName, defValue] of Object.entries(value as Record<string, unknown>)) {
          if (!currentLiveDefinitionNames.has(defName)) {
            changes.push({
              kind: "unused-definition",
              lossless: true,
              at: `${path}.${key}.${defName}`,
              tokensSaved: countTokens(JSON.stringify({ [defName]: defValue })),
              detail: `Removed "${defName}": no "$ref" anywhere in this tool's schema points to it.`,
            });
            continue;
          }
          kept[defName] = prune(defValue, `${path}.${key}.${defName}`);
        }
        // An empty container is only ever reachable via refs we just proved
        // dead, so dropping it removes no $ref's target — nothing points here.
        if (Object.keys(kept).length > 0) output[key] = kept;
        continue;
      }
      if (key === "title" && typeof value === "string") {
        const leaf = path.split(".").pop() ?? "";
        // A title that only restates its own property name carries no information.
        if (value.toLowerCase().replace(/[^a-z0-9]/g, "") === leaf.toLowerCase().replace(/[^a-z0-9]/g, "")) {
          changes.push({
            kind: "redundant-title",
            lossless: true,
            at: `${path}.title`,
            tokensSaved: countTokens(JSON.stringify({ title: value })),
            detail: `Removed title "${value}", which restates the property name.`,
          });
          continue;
        }
      }
      if (key === "examples" && options.dropExamples) {
        changes.push({
          kind: "examples",
          lossless: false,
          at: `${path}.examples`,
          tokensSaved: countTokens(JSON.stringify({ examples: value })),
          detail: "Removed examples. The model does read these when choosing arguments.",
        });
        continue;
      }
      if (key === "description" && typeof value === "string" && descriptions !== "keep") {
        if (descriptions === "drop") {
          changes.push({
            kind: "description",
            lossless: false,
            at: `${path}.description`,
            tokensSaved: countTokens(JSON.stringify({ description: value })),
            detail: "Removed description. Descriptions are how the model chooses between tools.",
          });
          continue;
        }
        const trimmed = truncateToTokens(value, maximumDescriptionTokens, countTokens);
        if (trimmed !== value) {
          changes.push({
            kind: "description",
            lossless: false,
            at: `${path}.description`,
            tokensSaved: countTokens(value) - countTokens(trimmed),
            detail: `Truncated description from ${countTokens(value)} to ${countTokens(trimmed)} tokens.`,
          });
        }
        output[key] = trimmed;
        continue;
      }
      output[key] = prune(value, `${path}.${key}`);
    }
    return output;
  }

  // Canonical ordering: a pure array-order change, so it is scored as a cache
  // stability measure (tokensSaved: 0), never as a token saving. It is also
  // why this runs AFTER pruning rather than before — sorting by name must see
  // each tool's final (post-prune) identity, not reorder first and prune
  // second, which would make the recorded order depend on an arbitrary input
  // order for ties (there are none here since tool names are unique, but the
  // sequencing is the honest invariant to hold regardless).
  let ordered = retained;
  if (options.canonicalOrder) {
    const named = retained.map((tool, index) => ({ name: toolNameOf(tool, index), tool }));
    const sorted = [...named].sort((a, b) => a.name.localeCompare(b.name));
    const moved = sorted.some((entry, index) => entry.tool !== named[index]!.tool);
    if (moved) {
      changes.push({
        kind: "tool-order",
        lossless: true,
        at: "catalogue",
        tokensSaved: 0,
        detail: "Reordered the tool catalogue into a stable, name-sorted order. The set and schema of " +
          "each tool is unchanged; this exists so a framework that resends the same catalogue in a " +
          "different order turn-to-turn (a mutable registry, conditional tool subsets, dict iteration) " +
          "does not break the cached prefix on every such turn for no reason.",
      });
    }
    ordered = sorted.map((entry) => entry.tool);
  }

  // Compact serialisation is hygiene, NOT a billable saving: every client
  // JSON-encodes the request body and the provider tokenises the parsed
  // structure, not the byte formatting, so whitespace removal saves zero real
  // tokens (verified against Anthropic count_tokens). No formatting change is
  // recorded — the honest lossless savings are the content removals above.
  const compact = JSON.stringify(ordered);
  const tokensAfter = countTokens(compact);

  return {
    tools: ordered,
    tokensBefore,
    tokensAfter,
    losslessTokensSaved: changes.filter((change) => change.lossless)
      .reduce((sum, change) => sum + change.tokensSaved, 0),
    lossyTokensSaved: changes.filter((change) => !change.lossless)
      .reduce((sum, change) => sum + change.tokensSaved, 0),
    changes,
  };
}

export type ToolCatalogueAudit = {
  tools: number;
  tokens: number;
  meanTokensPerTool: number;
  /** Largest offenders first, so a catalogue can be trimmed by hand. */
  largest: Array<{ name: string; tokens: number; descriptionTokens: number }>;
  /** Achievable without any behaviour change. */
  losslessTokensSaved: number;
  /** Additionally achievable by trimming descriptions, behind a replay check. */
  descriptionTokensSaved: number;
};

/**
 * Audit a catalogue: how big it is, which tools dominate, and how much each tier
 * of minification would recover. This is what makes the lever measured rather
 * than assumed, so a workload with an already-lean catalogue is credited nothing.
 */
export function auditToolCatalogue(
  tools: unknown[],
  options: { countTokens?: TokenCounter; maximumDescriptionTokens?: number } = {},
): ToolCatalogueAudit {
  const countTokens = options.countTokens ?? approximateTokenCount;
  const lossless = minifyToolSchemas(tools, { countTokens, descriptions: "keep" });
  const trimmed = minifyToolSchemas(tools, {
    countTokens,
    descriptions: "truncate",
    maximumDescriptionTokens: options.maximumDescriptionTokens ?? 24,
  });

  const largest = tools.map((tool, index) => {
    const serialised = JSON.stringify(tool);
    const descriptions = [...serialised.matchAll(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
      .reduce((sum, match) => sum + countTokens(match[1] ?? ""), 0);
    return { name: toolNameOf(tool, index), tokens: countTokens(serialised), descriptionTokens: descriptions };
  }).sort((left, right) => right.tokens - left.tokens);

  const tokens = countTokens(JSON.stringify(tools));
  return {
    tools: tools.length,
    tokens,
    meanTokensPerTool: tools.length === 0 ? 0 : tokens / tools.length,
    largest: largest.slice(0, 10),
    losslessTokensSaved: Math.max(0, lossless.tokensBefore - lossless.tokensAfter),
    descriptionTokensSaved: trimmed.lossyTokensSaved,
  };
}
