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
 *   Lossless (billable): schema plumbing the model does not read ($schema,
 *   $comment; $id and $defs only in a tool that contains no reference, because
 *   a reference resolves against them) and `title` fields that only restate the
 *   property name — content
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
const PLUMBING_KEYS = new Set(["$schema", "$comment"]);

/**
 * What a reference resolves against: `$defs` holds the shared definitions and
 * `$id` sets the base a relative reference is read from. They are removable
 * only from a tool that refers to nothing. An earlier version removed them
 * unconditionally, which left `{"$ref": "#/$defs/Customer"}` pointing at a
 * block that was no longer there — a changed request, not a compacted one.
 * Nested models (Pydantic, zod, most MCP servers) compile to exactly that shape.
 */
const REFERENCE_TARGET_KEYS = new Set(["$id", "$defs"]);
const REFERENCE_KEYS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);

/**
 * Keywords whose value is a map from a caller-chosen NAME to a schema. The keys
 * inside are names, not keywords: a parameter called `$id` or `title` is a
 * parameter, and removing it would change what the tool accepts.
 */
const NAME_MAP_KEYS = new Set([
  "properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies",
]);

/** Keywords whose value is data, not schema. Copied through untouched. */
const DATA_KEYS = new Set(["enum", "const", "default", "examples"]);

/**
 * Whether anything in this tool refers to something else. Deliberately broad:
 * any reference keyword anywhere counts, so a doubtful case keeps the targets.
 */
function containsReference(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsReference);
  if (typeof node !== "object" || node === null) return false;
  return Object.entries(node as Record<string, unknown>).some(([key, value]) =>
    (REFERENCE_KEYS.has(key) && typeof value === "string") || containsReference(value));
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
  countTokens?: TokenCounter;
};

export type MinifyChange = {
  kind: "plumbing" | "redundant-title" | "formatting" | "description" | "examples" | "dropped-tool";
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
  let keepReferenceTargets = false;

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
    // Decided per tool: a reference only ever resolves inside its own schema.
    keepReferenceTargets = containsReference(tool);
    retained.push(prune(tool, name, false));
  });

  function prune(node: unknown, path: string, keysAreNames: boolean): unknown {
    if (Array.isArray(node)) return node.map((item, index) => prune(item, `${path}[${index}]`, false));
    if (typeof node !== "object" || node === null) return node;
    const row = node as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (keysAreNames) {
        output[key] = prune(value, `${path}.${key}`, false);
        continue;
      }
      if (PLUMBING_KEYS.has(key) || (REFERENCE_TARGET_KEYS.has(key) && !keepReferenceTargets)) {
        changes.push({
          kind: "plumbing",
          lossless: true,
          at: `${path}.${key}`,
          tokensSaved: countTokens(JSON.stringify({ [key]: value })),
          detail: REFERENCE_TARGET_KEYS.has(key)
            ? `Removed ${key}: nothing in this tool refers to it.`
            : `Removed ${key}, which the model never reads.`,
        });
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
      if (DATA_KEYS.has(key)) {
        output[key] = value;
        continue;
      }
      const isNameMap = NAME_MAP_KEYS.has(key) && typeof value === "object" && value !== null &&
        !Array.isArray(value);
      output[key] = prune(value, `${path}.${key}`, isNameMap);
    }
    return output;
  }

  // Compact serialisation is hygiene, NOT a billable saving: every client
  // JSON-encodes the request body and the provider tokenises the parsed
  // structure, not the byte formatting, so whitespace removal saves zero real
  // tokens (verified against Anthropic count_tokens). No formatting change is
  // recorded — the honest lossless savings are the content removals above.
  const compact = JSON.stringify(retained);
  const tokensAfter = countTokens(compact);

  return {
    tools: retained,
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
