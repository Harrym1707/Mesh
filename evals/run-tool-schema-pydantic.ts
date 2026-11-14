import {
  ANTHROPIC_CACHE_5M,
  approximateTokenCount,
  lookupPrice,
  minifyToolSchemas,
  publishedModelPrices,
  simulateCache,
  type SimulatedRequest,
} from "../packages/core/src/index.js";
import { reduceRequest } from "../packages/sdk-js/src/index.js";

/**
 * Pydantic-shaped tool catalogues on the two workload shapes that actually
 * resend them every turn — multi-agent teams and autonomous long-horizon
 * agents.
 *
 *   node --import tsx evals/run-tool-schema-pydantic.ts
 *
 * Nightly R&D context: tool-schema minification already shipped
 * (packages/core/src/tool-schema.ts) and is on by default. Studying how
 * LangChain's `bind_tools`/`convert_to_openai_tool`, CrewAI, and the MCP tool
 * format actually SERIALIZE a Pydantic v2 model with a nested model field
 * (confirmed via Anthropic's and OpenAI's own docs: both support `$ref` into
 * `$defs` in tool schemas, and the Anthropic SDK's `transform_schema` helper
 * recurses into `$defs` rather than stripping it) surfaced that the shipped
 * minifier treated `$defs` as unconditional plumbing — deleting the ENTIRE
 * definitions block on every tool that used it, leaving `$ref` pointers with
 * nothing to resolve. That is not compaction, it is corruption, and it was
 * live on every default-config `toolSchemas: true` call. Part A below
 * reproduces it. Part B measures the correct, narrower lossless lever this
 * finding converts into (prune only $defs entries nothing references). Part
 * C measures a second, independent lossless lever from the same research —
 * canonical tool-array ordering — against the cache simulator, because tool
 * order instability (a mutable registry, conditionally-registered sub-agent
 * tools, non-deterministic dict/set iteration) breaks the cached prefix on
 * every such turn for zero reason.
 *
 * Honesty constraints:
 * - Part A is a correctness regression, not a savings claim: fixing it adds
 *   back the quality the shipped code had already silently removed.
 * - Parts B and C are LOSSLESS by construction (nothing the model can reach
 *   via $ref changes; canonical order changes array position, not tool
 *   identity or schema) and are reported from this harness's own simulator at
 *   catalogued prices, same methodology as run-workload-matrix.ts.
 */

type AnyObject = Record<string, unknown>;

const AT = "2026-11-14";
const price = lookupPrice(publishedModelPrices, { provider: "anthropic", model: "Sonnet 5.5", at: AT });
if (price.status !== "priced") throw new Error("price lookup failed for Sonnet 5.5");

// --- Part A: the $defs/$ref correctness regression --------------------------

/** What PLUMBING_KEYS-based stripping did before tonight's fix: delete the
 *  whole $defs/definitions container unconditionally, wherever it appears. */
function naiveStripDefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(naiveStripDefs);
  if (typeof node !== "object" || node === null) return node;
  const out: AnyObject = {};
  for (const [key, value] of Object.entries(node as AnyObject)) {
    if (key === "$defs" || key === "$schema" || key === "$id" || key === "$comment") continue;
    out[key] = naiveStripDefs(value);
  }
  return out;
}

function hasDanglingRef(node: unknown, definedNames: Set<string>): boolean {
  if (Array.isArray(node)) return node.some((item) => hasDanglingRef(item, definedNames));
  if (typeof node !== "object" || node === null) return false;
  for (const [key, value] of Object.entries(node as AnyObject)) {
    if (key === "$ref" && typeof value === "string") {
      const match = /^#\/\$defs\/([^/]+)/.exec(value);
      if (match && !definedNames.has(match[1]!)) return true;
    }
    if (hasDanglingRef(value, definedNames)) return true;
  }
  return false;
}

/** A tool shaped exactly as Pydantic v2's `model_json_schema()` emits a
 *  parameter that is itself a nested BaseModel — what LangChain's
 *  `bind_tools`/MCP tool registration sends to the wire for, e.g.,
 *  `def open_ticket(contact: ContactInfo, priority: Priority) -> str`. */
function pydanticTool(name: string, usesSharedDefs: boolean): AnyObject {
  const defs: AnyObject = {
    ContactInfo: {
      title: "ContactInfo",
      type: "object",
      additionalProperties: false,
      properties: {
        email: { type: "string", title: "Email" },
        phone: { type: "string", title: "Phone" },
        address: { $ref: "#/$defs/Address" },
      },
      required: ["email"],
    },
    Address: {
      title: "Address",
      type: "object",
      additionalProperties: false,
      properties: {
        street: { type: "string", title: "Street" },
        city: { type: "string", title: "City" },
        postcode: { type: "string", title: "Postcode" },
      },
    },
  };
  if (usesSharedDefs) {
    // A model exported once for the whole module and reused verbatim per
    // tool, as `langchain_core.utils.function_calling` and MCP server SDKs
    // that share one Pydantic models module across many tools both do —
    // only some tools actually reference every entry in it.
    defs.ErrorEnvelope = {
      title: "ErrorEnvelope",
      type: "object",
      properties: { code: { type: "string", title: "Code" }, message: { type: "string", title: "Message" } },
    };
  }
  return {
    type: "function",
    function: {
      name,
      description:
        `${name} files a request against the ticketing subsystem on behalf of a contact. Validates the ` +
        "contact's address, assigns a priority, and returns the created ticket id. Idempotent on retry.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: defs,
        type: "object",
        additionalProperties: false,
        properties: {
          contact: { $ref: "#/$defs/ContactInfo" },
          priority: { type: "string", enum: ["low", "normal", "high"], title: "Priority" },
        },
        required: ["contact"],
      },
    },
  };
}

// Ten tools, matching run-workload-matrix.ts's TOOLS catalogue size — a
// realistic LangGraph/CrewAI multi-agent toolset where every tool shares the
// same two Pydantic models (ContactInfo, Address) and half additionally carry
// an ErrorEnvelope definition their own properties never reference.
const PYDANTIC_TOOLS: AnyObject[] = Array.from({ length: 10 }, (_, i) => pydanticTool(`tool_${i}`, i % 2 === 0));

console.log("=== Part A: $defs/$ref correctness — reproducing the pre-fix regression ===");
{
  const toolsWithRefs = PYDANTIC_TOOLS.filter((tool) =>
    JSON.stringify(tool).includes('"$ref"')).length;
  const naive = PYDANTIC_TOOLS.map(naiveStripDefs);
  const definedNamesAfterNaiveStrip = new Set<string>(); // naive strip removes $defs entirely: nothing survives
  const brokenCount = naive.filter((tool) => hasDanglingRef(tool, definedNamesAfterNaiveStrip)).length;

  const fixed = minifyToolSchemas(PYDANTIC_TOOLS).tools;
  const stillBrokenCount = fixed.filter((tool) => hasDanglingRef(tool, new Set(["ContactInfo", "Address"]))).length;

  console.log(`${toolsWithRefs}/${PYDANTIC_TOOLS.length} tools in this fixture use $ref into $defs ` +
    "(every tool: ContactInfo -> Address).");
  console.log(`Pre-fix behaviour (blanket $defs removal): ${brokenCount}/${PYDANTIC_TOOLS.length} tools end up ` +
    "with a dangling $ref — their 'contact' parameter now points at a definition that does not exist.");
  console.log(`Tonight's fix: ${stillBrokenCount}/${PYDANTIC_TOOLS.length} tools broken (both $defs entries ` +
    "every tool actually uses are kept; nothing dangles).");
  if (brokenCount !== PYDANTIC_TOOLS.length || stillBrokenCount !== 0) {
    throw new Error("Part A assertion failed — the regression reproduction or the fix verification is wrong.");
  }
}

// --- Part B: unused-definition pruning — the lossless lever this finding converts into ---

console.log("\n=== Part B: unused-definition pruning (lossless) ===");
{
  const before = approximateTokenCount(JSON.stringify(PYDANTIC_TOOLS));
  const result = minifyToolSchemas(PYDANTIC_TOOLS, { countTokens: approximateTokenCount });
  const after = approximateTokenCount(JSON.stringify(result.tools));
  const unusedRemovals = result.changes.filter((c) => c.kind === "unused-definition");
  console.log(`catalogue: ${before} tokens before, ${after} after minification ` +
    `(${((before - after) / before * 100).toFixed(1)}% smaller); all of it lossless by construction.`);
  console.log(`of that, unreferenced-definition pruning alone removed ${unusedRemovals.length} dead ` +
    `ErrorEnvelope definitions (${unusedRemovals.reduce((s, c) => s + c.tokensSaved, 0)} tokens) that the ` +
    "pre-fix code would never have isolated correctly, because it deleted $defs wholesale instead of " +
    "checking what is actually referenced.");
  if (unusedRemovals.length !== 5) { // tools 0,2,4,6,8 carry the unused ErrorEnvelope
    throw new Error(`expected 5 unused-definition removals, got ${unusedRemovals.length}`);
  }
}

// --- Part C: canonical tool ordering vs cache-prefix stability --------------

console.log("\n=== Part C: canonical tool order vs an unstable framework (cache simulator, catalogued prices) ===");
{
  const PREAMBLE =
    "You are a careful specialist agent on a production multi-agent team. Follow the runbook: verify inputs, " +
    "cite sources, prefer small reversible steps, surface anything risky to the orchestrator. ".repeat(10);

  // Deterministic pseudo-shuffle standing in for what a real framework does:
  // CrewAI/AutoGen/LangGraph commonly rebuild an agent's visible tool list
  // per turn from a mutable registry (which sub-agents are active, which
  // tools are currently permitted) rather than resending one frozen array —
  // so the SET of tools is stable turn to turn, but the array ORDER is not.
  function shuffledTools(turn: number): AnyObject[] {
    const copy = [...PYDANTIC_TOOLS];
    // A small deterministic permutation so each turn's order differs from
    // the last but the fixture stays reproducible across runs.
    const offset = (turn * 3 + 1) % copy.length;
    return [...copy.slice(offset), ...copy.slice(0, offset)];
  }

  function buildStream(canonicalOrder: boolean): SimulatedRequest[] {
    const stream: SimulatedRequest[] = [];
    const agents = ["orchestrator", "search", "coder", "reviewer", "writer"];
    const histories = new Map<string, AnyObject[]>(agents.map((name) => [name, []]));
    for (let round = 0; round < 6; round += 1) {
      for (const [slot, name] of agents.entries()) {
        const history = histories.get(name)!;
        history.push({ role: "user", content: `Round ${round} task for ${name}: advance ticket 7, step ${round}.` });
        const request = {
          model: "claude-sonnet-5-5", max_tokens: 500,
          system: PREAMBLE, tools: shuffledTools(round),
          messages: [...history],
        };
        const { request: reduced } = reduceRequest(request, {
          toolSchemas: canonicalOrder ? { canonicalOrder: true } : true,
        });
        const r = reduced as AnyObject;
        const prompt = JSON.stringify(r.tools) + JSON.stringify(r.system) + JSON.stringify(r.messages);
        stream.push({ atSeconds: round * 40 + slot * 4, prompt, outputTokens: 220 });
        history.push({ role: "assistant", content: `(${name}) round ${round} done.` });
      }
    }
    return stream;
  }

  const unstable = simulateCache(buildStream(false), ANTHROPIC_CACHE_5M, price.price);
  const stabilised = simulateCache(buildStream(true), ANTHROPIC_CACHE_5M, price.price);

  console.log(`without canonicalOrder: hit rate ${(unstable.hitRate * 100).toFixed(1)}%, ` +
    `cost $${unstable.totalCostUsd.toFixed(3)}, miss reasons ${JSON.stringify(unstable.missReasons)}.`);
  console.log(`with canonicalOrder:    hit rate ${(stabilised.hitRate * 100).toFixed(1)}%, ` +
    `cost $${stabilised.totalCostUsd.toFixed(3)}.`);
  const delta = (unstable.totalCostUsd - stabilised.totalCostUsd) / unstable.totalCostUsd;
  console.log(`cache-stability lever vs the same stack without it: ${(delta * 100).toFixed(1)}% lower cost, ` +
    "same tools, same schemas, same messages — the only change is array order surviving the resend.");
  console.log("caveat: the shuffle schedule here is a stand-in for real framework non-determinism (no timestamped " +
    "capture yet shows how often production tool arrays actually reorder turn-to-turn) — this measures the " +
    "lever's mechanism and upper bound on an UNSTABLE catalogue, not its population-wide frequency.");
}
