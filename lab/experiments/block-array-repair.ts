// EXPERIMENT (lab-local, not in the product): block-array system prefix repair.
//
// Found by replaying the real LiteLLM wire capture (lab/captures.ts): a
// per-request value — a clock — at the head of a block-array `system` prompt
// makes the customer's own cache stamp pure write premium. Every turn rewrites
// ~7,000 tokens at 1.25x and never reads. The product's prefix repair
// (packages/sdk-js reduce-request.ts) deliberately leaves a block-array system
// untouched, so the loss survives Mesh today.
//
// This transform relocates the volatile LINES out of each system text block
// into one trailing, unstamped text block. The stamped block then stays
// byte-identical across turns, so the provider's breakpoint matches and the
// prefix is read at 0.1x. Every line survives verbatim; only its position
// changes.
//
// GATE-REQUIRED. It changes the order of what the model reads (a date anchor
// moves from the top of the prompt to the end of the system section), which is
// exactly what the replay gate's date-anchor probes exist to catch
// (docs/rnd/lever-backlog.md P3, condition 2). The lab measures its COST effect
// on the capture; its QUALITY effect is unmeasured until a gate runs, so it can
// be quantified here but never promoted from this harness.

type AnyObject = Record<string, unknown>;

/** Per-request values that end a cacheable prefix (same shapes the product repairs). */
const VOLATILE: RegExp[] = [
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
];

function isVolatileLine(line: string): boolean {
  return VOLATILE.some((pattern) => pattern.test(line));
}

function isTextBlock(block: unknown): block is AnyObject & { type: "text"; text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as AnyObject).type === "text" &&
    typeof (block as AnyObject).text === "string"
  );
}

export type BlockArrayRepair = {
  request: AnyObject;
  /** The lines that were relocated, in their original order. */
  moved: string[];
};

/**
 * Relocate volatile lines out of block-array system text blocks into a single
 * trailing unstamped block. Returns the request unchanged when the system is
 * not a block array, when there is nothing volatile, or when a block would be
 * left empty (never produce an empty text block — that is a 400).
 */
export function repairBlockArraySystem(request: AnyObject): BlockArrayRepair {
  const system = request.system;
  if (!Array.isArray(system)) return { request, moved: [] };

  const moved: string[] = [];
  const blocks: unknown[] = [];
  for (const block of system) {
    if (!isTextBlock(block)) {
      blocks.push(block);
      continue;
    }
    const lines = block.text.split("\n");
    const stable = lines.filter((line) => !isVolatileLine(line));
    const volatile = lines.filter(isVolatileLine);
    if (volatile.length === 0 || stable.join("\n").trim() === "") {
      blocks.push(block);
      continue;
    }
    moved.push(...volatile);
    blocks.push({ ...block, text: stable.join("\n") });
  }

  if (moved.length === 0) return { request, moved: [] };
  // The relocated lines go last and carry NO cache_control, so the stamp on the
  // stable block never covers a per-request value.
  blocks.push({ type: "text", text: moved.join("\n") });
  return { request: { ...request, system: blocks }, moved };
}
