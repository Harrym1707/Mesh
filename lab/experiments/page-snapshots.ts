// EXPERIMENT (lab-local, not in the product): stale page snapshots.
//
// A browsing agent reads a page as a text snapshot (an accessibility tree with
// an element ref per line — Playwright MCP's `browser_snapshot`, agent-browser's
// `snapshot`). Tools such as vercel-labs/agent-browser cut the cost of EACH
// snapshot at the source: interactive elements only, compact text, refs. That
// requires the customer to swap their browser tool, and it leaves the larger
// cost untouched: every snapshot the agent has ever taken stays in the
// transcript and is re-sent on every later turn. One snapshot is a linear cost;
// the transcript is a quadratic one.
//
// Mesh sits where the transcript is, so it can act on the quadratic part
// without the customer changing anything, whichever browser tool they use:
//
//   supersedeStaleSnapshots   Replace every snapshot except the newest with a
//                             one-line stub. A snapshot's refs are dead once a
//                             newer one exists (the tools say so themselves),
//                             but its TEXT may still matter — so this is lossy.
//
//   dedupeStaleSnapshotLines  Content-preserving variant. From each older
//                             snapshot remove only the lines that reappear in
//                             the NEXT snapshot — compared with the element ref
//                             masked, because an older snapshot's refs are dead
//                             and tools that renumber refs on every snapshot
//                             would otherwise defeat the match. Every element
//                             and every piece of text the agent ever saw is
//                             still in the transcript, at its last occurrence,
//                             carrying the ref that is still valid.
//
//   moveBreakpointBeforeFreshSnapshot
//                             Either rewrite changes the newest snapshot one
//                             turn after it was cached, so a breakpoint ON it
//                             is written and never read. The breakpoint moves
//                             to the block just before it: the compacted
//                             history is cached, the fresh page is paid once
//                             at the plain input rate, with no write premium.
//
// All three are pure and deterministic, and each older snapshot is rewritten
// exactly once (when its successor arrives) and is byte-stable afterwards, so
// the provider cache keeps extending.
//
// Content-blind in the lab's sense: a snapshot is recognised by its SHAPE (ref
// markers per line), nothing is interpreted, nothing is stored.

type AnyObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is AnyObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `[ref=e12]` (Playwright MCP) or a leading `@e12` (agent-browser). */
const REF_LINE = /\[ref=e\d+\]|^\s*@e\d+\b/;

export const SUPERSEDED_STUB =
  "[page snapshot superseded by a later snapshot in this conversation; its element refs are no longer valid]";

/** The marker line dedup leaves behind; never removed, never matched. */
const OMITTED_MARKER = /^\[\d+ lines? omitted: unchanged in the next page snapshot\]$/;

/**
 * A page snapshot by shape: at least eight lines, a third of them carrying an
 * element ref — or one this module has already deduplicated.
 */
export function isPageSnapshot(text: string): boolean {
  if (text === SUPERSEDED_STUB) return false;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.some((line) => OMITTED_MARKER.test(line))) return true;
  if (lines.length < 8) return false;
  return lines.filter((line) => REF_LINE.test(line)).length * 3 >= lines.length;
}

type SnapshotSite = { message: number; block: number; text: string };

function toolResultText(block: AnyObject): string | undefined {
  if (block.type !== "tool_result") return undefined;
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content) && block.content.length === 1) {
    const only = block.content[0];
    if (isPlainObject(only) && only.type === "text" && typeof only.text === "string") return only.text;
  }
  return undefined;
}

function withToolResultText(block: AnyObject, text: string): AnyObject {
  if (typeof block.content === "string") return { ...block, content: text };
  const only = (block.content as AnyObject[])[0]!;
  return { ...block, content: [{ ...only, text }] };
}

function snapshotSites(messages: unknown[]): SnapshotSite[] {
  const sites: SnapshotSite[] = [];
  messages.forEach((message, messageIndex) => {
    if (!isPlainObject(message) || message.role !== "user" || !Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (!isPlainObject(block)) return;
      const text = toolResultText(block);
      if (text !== undefined && isPageSnapshot(text)) sites.push({ message: messageIndex, block: blockIndex, text });
    });
  });
  return sites;
}

function rewriteSnapshots(request: AnyObject, rewrite: (site: SnapshotSite, next: SnapshotSite) => string): AnyObject {
  if (!Array.isArray(request.messages)) return request;
  const sites = snapshotSites(request.messages);
  if (sites.length < 2) return request;
  const messages = [...request.messages] as AnyObject[];
  for (let index = 0; index < sites.length - 1; index += 1) {
    const site = sites[index]!;
    const replacement = rewrite(site, sites[index + 1]!);
    if (replacement === site.text) continue;
    const message = messages[site.message]!;
    const content = [...(message.content as AnyObject[])];
    content[site.block] = withToolResultText(content[site.block]!, replacement);
    messages[site.message] = { ...message, content };
  }
  return { ...request, messages };
}

/** LOSSY: every page snapshot except the newest becomes a one-line stub. */
export function supersedeStaleSnapshots(request: AnyObject): AnyObject {
  return rewriteSnapshots(request, () => SUPERSEDED_STUB);
}

/** A line with its element ref masked: the element, not the handle to it. */
export const maskRef = (line: string): string =>
  line.replace(/\[ref=e\d+\]/g, "[ref]").replace(/^(\s*)@e\d+\b/, "$1@e");

const omitted = (count: number): string =>
  `[${count} line${count === 1 ? "" : "s"} omitted: unchanged in the next page snapshot]`;

/**
 * Content-preserving: from each older snapshot drop the lines that reappear in
 * the next snapshot (refs masked), leaving one marker per run of dropped lines.
 * Not byte-lossless — an older tree loses its repeated branches — but no
 * element or text the agent saw leaves the transcript.
 */
export function dedupeStaleSnapshotLines(request: AnyObject): AnyObject {
  return rewriteSnapshots(request, (site, next) => {
    const later = new Set(next.text.split("\n").filter((line) => !OMITTED_MARKER.test(line)).map(maskRef));
    const out: string[] = [];
    let run = 0;
    const flush = (): void => {
      if (run > 0) out.push(omitted(run));
      run = 0;
    };
    for (const line of site.text.split("\n")) {
      if (line.trim() !== "" && later.has(maskRef(line))) {
        run += 1;
      } else {
        flush();
        out.push(line);
      }
    }
    flush();
    return out.join("\n");
  });
}

/**
 * When the newest message is a fresh page snapshot carrying the message
 * breakpoint, move that breakpoint to the last block of the message before it.
 * Placement only: the model reads the same bytes.
 */
export function moveBreakpointBeforeFreshSnapshot(request: AnyObject): AnyObject {
  if (!Array.isArray(request.messages) || request.messages.length < 2) return request;
  const messages = [...request.messages] as AnyObject[];
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex]!;
  if (!isPlainObject(last) || !Array.isArray(last.content) || last.content.length === 0) return request;
  const blocks = [...(last.content as AnyObject[])];
  const tail = blocks[blocks.length - 1]!;
  if (!isPlainObject(tail) || tail.cache_control === undefined) return request;
  const text = toolResultText(tail);
  if (text === undefined || !isPageSnapshot(text)) return request;

  const previous = messages[lastIndex - 1]!;
  if (!isPlainObject(previous)) return request;
  const marker = tail.cache_control;
  let previousContent: AnyObject[];
  if (typeof previous.content === "string") {
    if (previous.content.trim() === "") return request;
    previousContent = [{ type: "text", text: previous.content, cache_control: marker }];
  } else if (Array.isArray(previous.content) && previous.content.length > 0) {
    previousContent = [...(previous.content as AnyObject[])];
    const end = previousContent[previousContent.length - 1]!;
    if (!isPlainObject(end)) return request;
    previousContent[previousContent.length - 1] = { ...end, cache_control: marker };
  } else {
    return request;
  }
  const { cache_control: _moved, ...unstamped } = tail;
  blocks[blocks.length - 1] = unstamped;
  messages[lastIndex] = { ...last, content: blocks };
  messages[lastIndex - 1] = { ...previous, content: previousContent };
  return { ...request, messages };
}
