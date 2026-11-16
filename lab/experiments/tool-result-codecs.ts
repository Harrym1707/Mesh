// Lab-local experiment — NOT in the product.
//
// Reducers for tool results, applied before a result is first sent.
//
// Why here: an agent's transcript is mostly tool results (file reads, search
// hits, logs, API responses, pages), and each one is sent again on every later
// turn. A client that already caches (Claude Code does) leaves Mesh nothing to
// gain from caching, and rewriting old history would break that cache. What is
// left is the result itself: make it smaller once, the same way every time, and
// the saving repeats on every turn that re-sends it without touching the
// cached prefix.
//
// Every reducer here is a pure function of the text it is given: same input,
// same output, and a second application changes nothing. That is what makes it
// safe under a client's cache: a result is rewritten identically on the turn it
// arrives and on every later turn.
//
// Tiers, strictest first. Only the first changes nothing a parser can see.
//
//   parse-equal         The same JSON document: only whitespace between tokens
//                       is removed. Number and string lexemes are untouched.
//   render-equal        What a terminal would display: colour codes removed,
//                       carriage-return overwrites applied.
//   reversible          A different encoding with an exact inverse in this
//                       file. Nothing is lost; the model reads another layout.
//   content-preserving  Content removed from one place while the same content
//                       stays, verbatim, elsewhere in the transcript.
//   lossy               Content the model could have read is gone.
//
// Nothing here reads, stores or exports what passes through it. The tests run
// on tool outputs recorded from this repository (lab/agent-tasks/corpus).

type AnyObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is AnyObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type CodecTier = "parse-equal" | "render-equal" | "reversible" | "content-preserving" | "lossy";

export type TextCodec = {
  id: string;
  label: string;
  tier: CodecTier;
  /** Returns the input itself when the codec does not apply or would not shrink it. */
  encode(text: string): string;
  /** The exact inverse, for reversible codecs. */
  decode?(text: string): string;
};

// ---------------------------------------------------------------------------
// JSON, with every scalar kept as the characters it was written with.
// JSON.parse would turn 1.0 into 1 and round integers past 2^53, so a reducer
// built on it is not parse-equal for numbers. This one never re-types a value.
// ---------------------------------------------------------------------------

type JsonNode =
  | { kind: "scalar"; raw: string }
  | { kind: "array"; items: JsonNode[] }
  | { kind: "object"; entries: Array<[key: string, value: JsonNode]> };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WHITESPACE = /[ \t\n\r]*/y;

function parseLexemes(text: string): JsonNode | undefined {
  try {
    JSON.parse(text);
  } catch {
    return undefined; // not JSON: never touched
  }
  let at = 0;
  const skip = (): void => {
    WHITESPACE.lastIndex = at;
    WHITESPACE.exec(text);
    at = WHITESPACE.lastIndex;
  };
  const string = (): string => {
    const start = at;
    at += 1;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    at += 1;
    return text.slice(start, at);
  };
  const value = (): JsonNode => {
    skip();
    const head = text[at];
    if (head === "{") {
      at += 1;
      const entries: Array<[string, JsonNode]> = [];
      skip();
      if (text[at] === "}") {
        at += 1;
        return { kind: "object", entries };
      }
      for (;;) {
        skip();
        const key = string();
        skip();
        at += 1; // the colon
        entries.push([key, value()]);
        skip();
        const next = text[at];
        at += 1;
        if (next === "}") return { kind: "object", entries };
      }
    }
    if (head === "[") {
      at += 1;
      const items: JsonNode[] = [];
      skip();
      if (text[at] === "]") {
        at += 1;
        return { kind: "array", items };
      }
      for (;;) {
        items.push(value());
        skip();
        const next = text[at];
        at += 1;
        if (next === "]") return { kind: "array", items };
      }
    }
    if (head === '"') return { kind: "scalar", raw: string() };
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return { kind: "scalar", raw: literal };
      }
    }
    NUMBER.lastIndex = at;
    const match = NUMBER.exec(text);
    if (match === null) throw new Error("unreachable: JSON.parse accepted this text");
    at = NUMBER.lastIndex;
    return { kind: "scalar", raw: match[0] };
  };
  return value();
}

function emit(node: JsonNode): string {
  if (node.kind === "scalar") return node.raw;
  if (node.kind === "array") return `[${node.items.map(emit).join(",")}]`;
  return `{${node.entries.map(([key, value]) => `${key}:${emit(value)}`).join(",")}}`;
}

const looksLikeJson = (text: string): boolean => /^\s*[[{]/.test(text);

/** parse-equal: the same document with the whitespace between tokens removed. */
export const jsonMinify: TextCodec = {
  id: "json-minify",
  label: "JSON without layout whitespace",
  tier: "parse-equal",
  encode(text) {
    if (!looksLikeJson(text)) return text;
    const tree = parseLexemes(text);
    if (tree === undefined) return text;
    const out = emit(tree);
    return out.length < text.length ? out : text;
  },
};

const COLUMNS = '"__cols"';
const ROWS = '"__rows"';

function hasKey(node: JsonNode, key: string): boolean {
  if (node.kind === "scalar") return false;
  if (node.kind === "array") return node.items.some((item) => hasKey(item, key));
  return node.entries.some(([name, value]) => name === key || hasKey(value, key));
}

/** An array of at least three objects that all carry the same keys in the same order. */
function uniformKeys(items: JsonNode[]): string[] | undefined {
  if (items.length < 3) return undefined;
  let keys: string[] | undefined;
  for (const item of items) {
    if (item.kind !== "object" || item.entries.length === 0) return undefined;
    const own = item.entries.map(([key]) => key);
    if (new Set(own).size !== own.length) return undefined;
    if (keys === undefined) keys = own;
    else if (own.length !== keys.length || own.some((key, index) => key !== keys![index])) return undefined;
  }
  return keys;
}

function toColumns(node: JsonNode): JsonNode {
  if (node.kind === "scalar") return node;
  if (node.kind === "object") {
    return { kind: "object", entries: node.entries.map(([key, value]) => [key, toColumns(value)]) };
  }
  const items = node.items.map(toColumns);
  const keys = uniformKeys(node.items);
  if (keys === undefined) return { kind: "array", items };
  return {
    kind: "object",
    entries: [
      [COLUMNS, { kind: "array", items: keys.map((raw) => ({ kind: "scalar", raw }) satisfies JsonNode) }],
      [
        ROWS,
        {
          kind: "array",
          // Rows are built from the ORIGINAL objects' values, converted in turn.
          items: node.items.map((item) => ({
            kind: "array",
            items: (item as Extract<JsonNode, { kind: "object" }>).entries.map(([, value]) => toColumns(value)),
          })),
        },
      ],
    ],
  };
}

function fromColumns(node: JsonNode): JsonNode {
  if (node.kind === "scalar") return node;
  if (node.kind === "array") return { kind: "array", items: node.items.map(fromColumns) };
  const [first, second] = node.entries;
  if (
    node.entries.length === 2 && first![0] === COLUMNS && second![0] === ROWS &&
    first![1].kind === "array" && second![1].kind === "array"
  ) {
    const keys = first![1].items.map((key) => (key as Extract<JsonNode, { kind: "scalar" }>).raw);
    return {
      kind: "array",
      items: second![1].items.map((row) => ({
        kind: "object",
        entries: (row as Extract<JsonNode, { kind: "array" }>).items.map(
          (value, index) => [keys[index]!, fromColumns(value)] as [string, JsonNode],
        ),
      })),
    };
  }
  return { kind: "object", entries: node.entries.map(([key, value]) => [key, fromColumns(value)]) };
}

/**
 * reversible: an array of same-shaped objects becomes one list of column names
 * and one row of values per object, so each key is sent once instead of once
 * per object. Still valid JSON. `decode` returns the minified original exactly.
 */
export const jsonTable: TextCodec = {
  id: "json-table",
  label: "Same-shaped JSON objects as columns and rows",
  tier: "reversible",
  encode(text) {
    if (!looksLikeJson(text)) return text;
    const tree = parseLexemes(text);
    // A document that already uses the marker key cannot be told apart from an
    // encoded one, so it is left alone.
    if (tree === undefined || hasKey(tree, COLUMNS)) return text;
    const out = emit(toColumns(tree));
    return out.length < emit(tree).length ? out : text;
  },
  decode(text) {
    const tree = parseLexemes(text);
    return tree === undefined || !hasKey(tree, COLUMNS) ? text : emit(fromColumns(tree));
  },
};

const SAME = '"__same"';
/** Smaller subtrees are not worth a pointer. */
const MINIMUM_REPEAT_LENGTH = 120;

const pointerSegment = (segment: string): string => segment.replace(/~/g, "~0").replace(/\//g, "~1");
const unescapeSegment = (segment: string): string => segment.replace(/~1/g, "/").replace(/~0/g, "~");

/** `{"__same":"/0/base/repo"}`: the value at that JSON pointer, which always lies earlier in the document. */
const pointerTo = (path: string): JsonNode => ({ kind: "object", entries: [[SAME, { kind: "scalar", raw: JSON.stringify(path) }]] });

function pointerPath(node: JsonNode): string | undefined {
  if (node.kind !== "object" || node.entries.length !== 1) return undefined;
  const [key, value] = node.entries[0]!;
  if (key !== SAME || value.kind !== "scalar" || !value.raw.startsWith('"')) return undefined;
  return JSON.parse(value.raw) as string;
}

function dedupeSubtrees(root: JsonNode): JsonNode {
  const firstSeenAt = new Map<string, string>();
  const visit = (node: JsonNode, path: string): JsonNode => {
    if (node.kind === "scalar") return node;
    const text = emit(node);
    if (text.length >= MINIMUM_REPEAT_LENGTH) {
      const first = firstSeenAt.get(text);
      if (first !== undefined) {
        const pointer = pointerTo(first);
        if (emit(pointer).length < text.length) return pointer;
      } else {
        firstSeenAt.set(text, path);
      }
    }
    if (node.kind === "array") return { kind: "array", items: node.items.map((item, index) => visit(item, `${path}/${index}`)) };
    return {
      kind: "object",
      entries: node.entries.map(([key, value]) => [key, visit(value, `${path}/${pointerSegment(JSON.parse(key) as string)}`)]),
    };
  };
  return visit(root, "");
}

function restoreSubtrees(root: JsonNode): JsonNode {
  const lookup = (path: string): JsonNode => {
    let node = root;
    for (const segment of path.split("/").slice(1).map(unescapeSegment)) {
      if (node.kind === "array") node = node.items[Number(segment)]!;
      else if (node.kind === "object") node = node.entries.find(([key]) => (JSON.parse(key) as string) === segment)![1];
    }
    return node;
  };
  const restore = (node: JsonNode): JsonNode => {
    if (node.kind === "scalar") return node;
    const path = pointerPath(node);
    // A pointer always names an earlier value, so this recursion ends.
    if (path !== undefined) return restore(lookup(path));
    if (node.kind === "array") return { kind: "array", items: node.items.map(restore) };
    return { kind: "object", entries: node.entries.map(([key, value]) => [key, restore(value)]) };
  };
  return restore(root);
}

/**
 * reversible: an object or array identical to one EARLIER in the same document
 * becomes a pointer to it. API responses repeat whole sub-objects (the same
 * repository, user or account on every row). Still valid JSON. `decode`
 * returns the minified original exactly.
 */
export const jsonRepeats: TextCodec = {
  id: "json-repeats",
  label: "A repeated JSON sub-object as a pointer to its first copy",
  tier: "reversible",
  encode(text) {
    if (!looksLikeJson(text)) return text;
    const tree = parseLexemes(text);
    if (tree === undefined || hasKey(tree, SAME)) return text;
    const out = emit(dedupeSubtrees(tree));
    return out.length < emit(tree).length ? out : text;
  },
  decode(text) {
    const tree = parseLexemes(text);
    return tree === undefined || !hasKey(tree, SAME) ? text : emit(restoreSubtrees(tree));
  },
};

// ---------------------------------------------------------------------------
// Terminal output.
// ---------------------------------------------------------------------------

// Colour and text-style codes (SGR): ESC [ … m.
const STYLE_CODE = /\u001b\[[0-9;]*m/g;

/** One line as a terminal would leave it: a carriage return moves to column 0 and later text overwrites. */
function applyCarriageReturns(line: string): string {
  if (!line.includes("\r")) return line;
  const segments = line.split("\r");
  let shown = segments[0]!;
  for (const segment of segments.slice(1)) {
    shown = segment.length >= shown.length ? segment : segment + shown.slice(segment.length);
  }
  return shown;
}

/**
 * render-equal: colour codes removed and carriage-return overwrites applied.
 * Cursor movement and screen-clearing sequences are left exactly as they are:
 * replaying those faithfully needs a terminal emulator, and this does not
 * claim to be one.
 */
export const terminalRender: TextCodec = {
  id: "terminal-render",
  label: "Terminal output as displayed (colour codes, carriage returns)",
  tier: "render-equal",
  encode(text) {
    if (!text.includes("\u001b[") && !text.includes("\r")) return text;
    const out = text.replace(STYLE_CODE, "").split("\n").map(applyCarriageReturns).join("\n");
    return out.length < text.length ? out : text;
  },
};

const REPEAT_MARKER = /^\[previous line repeated (\d+) more times?\]$/;
const repeatMarker = (count: number): string =>
  `[previous line repeated ${count} more time${count === 1 ? "" : "s"}]`;

/** reversible: three or more identical lines in a row become the line and a count. */
export const runLength: TextCodec = {
  id: "run-length-lines",
  label: "Runs of identical lines as one line and a count",
  tier: "reversible",
  encode(text) {
    const lines = text.split("\n");
    // Text that already contains a marker line could not be decoded exactly.
    if (lines.some((line) => REPEAT_MARKER.test(line))) return text;
    const out: string[] = [];
    for (let index = 0; index < lines.length;) {
      let end = index + 1;
      while (end < lines.length && lines[end] === lines[index]) end += 1;
      const run = end - index;
      out.push(lines[index]!);
      if (run >= 3) out.push(repeatMarker(run - 1));
      else if (run === 2) out.push(lines[index]!);
      index = end;
    }
    const joined = out.join("\n");
    return joined.length < text.length ? joined : text;
  },
  decode(text) {
    const out: string[] = [];
    for (const line of text.split("\n")) {
      const match = REPEAT_MARKER.exec(line);
      if (match === null || out.length === 0) out.push(line);
      else for (let count = 0; count < Number(match[1]); count += 1) out.push(out[out.length - 1]!);
    }
    return out.join("\n");
  },
};

const GREP_LINE = /^([^:\n]+):(\d+:.*)$/;
const GROUP_HEADER = /^== (.+) ==$/;
const NUMBERED = /^\d+:/;

/**
 * reversible: `path:line:text` search hits grouped under one heading per file,
 * so a path is sent once instead of once per hit (the layout ripgrep prints
 * with --heading).
 */
export const grepHeading: TextCodec = {
  id: "grep-heading",
  label: "Search hits grouped under one heading per file",
  tier: "reversible",
  encode(text) {
    const lines = text.split("\n");
    // Either of these in the input would make the grouped form ambiguous.
    if (lines.some((line) => GROUP_HEADER.test(line) || NUMBERED.test(line))) return text;
    const out: string[] = [];
    for (let index = 0; index < lines.length;) {
      const match = GREP_LINE.exec(lines[index]!);
      if (match === null) {
        out.push(lines[index]!);
        index += 1;
        continue;
      }
      const path = match[1]!;
      const hits: string[] = [];
      let end = index;
      for (; end < lines.length; end += 1) {
        const next = GREP_LINE.exec(lines[end]!);
        if (next === null || next[1] !== path) break;
        hits.push(next[2]!);
      }
      // A lone hit is cheaper left as it is.
      if (hits.length < 2) out.push(lines[index]!);
      else out.push(`== ${path} ==`, ...hits);
      index = end;
    }
    const joined = out.join("\n");
    return joined.length < text.length ? joined : text;
  },
  decode(text) {
    const out: string[] = [];
    let path: string | undefined;
    for (const line of text.split("\n")) {
      const header = GROUP_HEADER.exec(line);
      if (header !== null) {
        path = header[1];
        continue;
      }
      if (path !== undefined && NUMBERED.test(line)) out.push(`${path}:${line}`);
      else {
        path = undefined;
        out.push(line);
      }
    }
    return out.join("\n");
  },
};

// ---------------------------------------------------------------------------
// Lossy reducers. Measured so the price of not using them is known; never
// promoted without a real quality gate.
// ---------------------------------------------------------------------------

const PASSING_TEST = /^\s*(?:[✓✔√]|PASS\b|ok\s+\d+)/;

/** lossy: runs of three or more passing-test lines become a count. Failures are never touched. */
export const foldPassingTests: TextCodec = {
  id: "fold-passing-tests",
  label: "Passing-test lines folded to a count",
  tier: "lossy",
  encode(text) {
    const lines = text.split("\n");
    const out: string[] = [];
    for (let index = 0; index < lines.length;) {
      let end = index;
      while (end < lines.length && PASSING_TEST.test(lines[end]!)) end += 1;
      const run = end - index;
      if (run >= 3) out.push(`[${run} passing test lines omitted]`);
      else if (run > 0) out.push(...lines.slice(index, end));
      if (end === index) {
        out.push(lines[index]!);
        end += 1;
      }
      index = end;
    }
    const joined = out.join("\n");
    return joined.length < text.length ? joined : text;
  },
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** lossy: a fetched HTML page as its readable text. Markup, scripts, styles and attributes are dropped; link targets are kept. */
export const htmlToText: TextCodec = {
  id: "html-to-text",
  label: "Fetched HTML as readable text",
  tier: "lossy",
  encode(text) {
    if (!/<html[\s>]|<!doctype html/i.test(text)) return text;
    const out = text
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<head\b[\s\S]*?<\/head>/gi, (head) => /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "")
      .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_all, href: string, label: string) =>
        href.startsWith("#") || label.trim() === "" ? label : `${label} (${href})`)
      .replace(/<\/?(?:p|div|section|article|header|footer|main|nav|li|ul|ol|tr|table|h[1-6]|br|pre|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&(#39|[a-z]+);/g, (all, name: string) => ENTITIES[name] ?? all)
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
      .join("\n")
      .trim();
    return out.length < text.length ? out : text;
  },
};

/** Codecs in the order they are applied; each tier includes the ones before it. */
export const TEXT_CODECS: TextCodec[] = [jsonMinify, terminalRender, jsonTable, jsonRepeats, grepHeading, runLength, foldPassingTests, htmlToText];

const TIER_ORDER: CodecTier[] = ["parse-equal", "render-equal", "reversible", "content-preserving", "lossy"];

/** Every text codec at or below `tier`, in application order. */
export function codecsThrough(tier: CodecTier): TextCodec[] {
  const limit = TIER_ORDER.indexOf(tier);
  return TEXT_CODECS.filter((codec) => TIER_ORDER.indexOf(codec.tier) <= limit);
}

/** Apply codecs in order to one tool result. */
export function encodeResult(text: string, codecs: readonly TextCodec[]): string {
  return codecs.reduce((current, codec) => codec.encode(current), text);
}

// ---------------------------------------------------------------------------
// Request-level: tool results in an Anthropic Messages transcript.
// ---------------------------------------------------------------------------

type ResultSite = { message: number; block: number; text: string; toolUseId: string };

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

function resultSites(messages: unknown[]): ResultSite[] {
  const sites: ResultSite[] = [];
  messages.forEach((message, messageIndex) => {
    if (!isPlainObject(message) || message.role !== "user" || !Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (!isPlainObject(block)) return;
      const text = toolResultText(block);
      if (text === undefined) return;
      sites.push({ message: messageIndex, block: blockIndex, text, toolUseId: String(block.tool_use_id ?? "") });
    });
  });
  return sites;
}

function rewriteResults(request: AnyObject, rewrite: (site: ResultSite, index: number, sites: ResultSite[]) => string): AnyObject {
  if (!Array.isArray(request.messages)) return request;
  const sites = resultSites(request.messages);
  const messages = [...request.messages] as AnyObject[];
  let changed = false;
  sites.forEach((site, index) => {
    const replacement = rewrite(site, index, sites);
    if (replacement === site.text) return;
    changed = true;
    const message = messages[site.message]!;
    const content = [...(message.content as AnyObject[])];
    content[site.block] = withToolResultText(content[site.block]!, replacement);
    messages[site.message] = { ...message, content };
  });
  return changed ? { ...request, messages } : request;
}

/** Apply text codecs to every tool result in a request. Pure per result, so a client's cached prefix is unaffected. */
export function encodeToolResults(request: AnyObject, codecs: readonly TextCodec[]): AnyObject {
  return rewriteResults(request, (site) => encodeResult(site.text, codecs));
}

const MINIMUM_REPEAT_CHARS = 400;
const POINTER = /^\[Same output as an earlier tool result in this conversation \(tool_use_id [^)]*\): \d+ lines?, not repeated here\.\]$/;

/**
 * content-preserving: a tool result identical to an EARLIER one is replaced by
 * a one-line pointer to it. The earlier copy is untouched, so history, and any
 * cached prefix, stays byte-identical; only the newest message changes.
 */
export function pointToEarlierIdenticalResult(request: AnyObject): AnyObject {
  return rewriteResults(request, (site, index, sites) => {
    if (site.text.length < MINIMUM_REPEAT_CHARS || POINTER.test(site.text)) return site.text;
    const earlier = sites.slice(0, index).find((other) => other.text === site.text);
    if (earlier === undefined) return site.text;
    const lines = site.text.split("\n").length;
    return `[Same output as an earlier tool result in this conversation (tool_use_id ${earlier.toolUseId}): ${lines} line${lines === 1 ? "" : "s"}, not repeated here.]`;
  });
}

const NUMBERED_READ_LINE = /^\s*\d+\t/;
const READ_OMITTED = /^\[\d+ lines? omitted: unchanged in a later read of this file\]$/;
const stripGutter = (line: string): string => line.replace(/^\s*\d+\t/, "");

/** A numbered file read (`cat -n` layout, as a Read tool returns it), or one this module already reduced. */
export function isNumberedRead(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.some((line) => READ_OMITTED.test(line))) return true;
  if (lines.length < 8) return false;
  return lines.filter((line) => NUMBERED_READ_LINE.test(line)).length * 10 >= lines.length * 9;
}

/**
 * content-preserving: when the same file is read again, the OLDER read loses
 * the runs of lines that the later read repeats (line numbers ignored, since an
 * edit shifts them). The newest read is always complete. This rewrites history,
 * so under a client's cache it costs one re-write of everything after the older
 * read; the harness prices that.
 */
export function dedupeStaleFileReads(request: AnyObject): AnyObject {
  return rewriteResults(request, (site, index, sites) => {
    if (!isNumberedRead(site.text)) return site.text;
    const own = site.text.split("\n");
    const ownContent = new Set(own.filter((line) => !READ_OMITTED.test(line)).map(stripGutter).filter((line) => line.trim() !== ""));
    // The next later read that shares at least half of this read's lines is taken to be the same file.
    const later = sites.slice(index + 1).find((other) => {
      if (!isNumberedRead(other.text)) return false;
      const theirs = new Set(other.text.split("\n").map(stripGutter));
      let shared = 0;
      for (const line of ownContent) if (theirs.has(line)) shared += 1;
      return shared * 2 >= ownContent.size;
    });
    if (later === undefined) return site.text;
    const repeated = new Set(later.text.split("\n").filter((line) => !READ_OMITTED.test(line)).map(stripGutter));
    const out: string[] = [];
    for (let at = 0; at < own.length;) {
      let end = at;
      while (end < own.length && !READ_OMITTED.test(own[end]!) && repeated.has(stripGutter(own[end]!))) end += 1;
      const run = end - at;
      // Short runs (a closing brace, a blank line) stay: dropping them would only fragment the listing.
      if (run >= 3) out.push(`[${run} lines omitted: unchanged in a later read of this file]`);
      else out.push(...own.slice(at, end));
      if (end === at) {
        out.push(own[at]!);
        end += 1;
      }
      at = end;
    }
    return out.join("\n");
  });
}

const UNCHANGED_RANGE = /^\[lines? \d+(?:-\d+)? unchanged from the first read of this file \(tool_use_id [^)]*\)\]$/;
const gutterNumber = (line: string): string => /^\s*(\d+)\t/.exec(line)?.[1] ?? "?";

/**
 * content-preserving, and safe under a client's cache: when a file is read
 * AGAIN, the new read keeps its changed lines and replaces each run of five or
 * more lines that the FIRST read of that file already showed with one line
 * naming the range. The first read is never touched, so history stays
 * byte-identical; only the newest message is smaller.
 *
 * The opposite trade to `dedupeStaleFileReads`: the agent's freshest view of
 * the file is the changes plus a pointer, not the whole file.
 */
export function rereadAsChanges(request: AnyObject): AnyObject {
  return rewriteResults(request, (site, index, sites) => {
    const lines = site.text.split("\n");
    if (!isNumberedRead(site.text) || lines.some((line) => UNCHANGED_RANGE.test(line) || READ_OMITTED.test(line))) return site.text;
    const content = lines.map(stripGutter).filter((line) => line.trim() !== "");
    // The FIRST earlier read sharing at least half of this read's lines. Always
    // the first, so every later read points at a result that is sent verbatim.
    const first = sites.slice(0, index).find((other) => {
      if (!isNumberedRead(other.text)) return false;
      const theirs = new Set(other.text.split("\n").map(stripGutter));
      return content.filter((line) => theirs.has(line)).length * 2 >= content.length;
    });
    if (first === undefined) return site.text;
    const known = new Set(first.text.split("\n").filter((line) => NUMBERED_READ_LINE.test(line)).map(stripGutter));
    const out: string[] = [];
    for (let at = 0; at < lines.length;) {
      let end = at;
      while (end < lines.length && NUMBERED_READ_LINE.test(lines[end]!) && known.has(stripGutter(lines[end]!))) end += 1;
      const run = end - at;
      if (run >= 5) {
        const from = gutterNumber(lines[at]!);
        const to = gutterNumber(lines[end - 1]!);
        out.push(`[lines ${from}-${to} unchanged from the first read of this file (tool_use_id ${first.toolUseId})]`);
      } else out.push(...lines.slice(at, end));
      if (end === at) {
        out.push(lines[at]!);
        end += 1;
      }
      at = end;
    }
    const joined = out.join("\n");
    return joined.length < site.text.length ? joined : site.text;
  });
}

