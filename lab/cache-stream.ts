/**
 * Text-level pricing of a timed request stream under the provider's published
 * prompt-cache rules, with explicit breakpoints. Shared by the lab harnesses
 * that have to answer "what does this do to the BILL", not "how many tokens
 * does it remove": a change that removes tokens inside a cached prefix can
 * raise the bill, because it turns cheap reads into dear writes.
 *
 * SIMULATOR. Approximate token counts; no provider is called.
 */

import { approximateTokenCount } from "../packages/core/src/token-reduction.js";
import { CachePrefixVolatilityGuard } from "../packages/sdk-js/src/cache-volatility-guard.js";
import { reduceRequest, type MeshTokenReductionConfig } from "../packages/sdk-js/src/reduce-request.js";

export type AnyObject = Record<string, unknown>;

export type TimedRequest = { atSeconds: number; request: AnyObject; outputTokens: number };

/** Output is billed at five times input on the model these sessions name. */
export const OUTPUT_MULTIPLIER = 5;
export const WRITE_MULTIPLIER_5M = 1.25;
export const WRITE_MULTIPLIER_1H = 2;
export const READ_MULTIPLIER = 0.1;
export const TTL_5M_SECONDS = 300;
export const TTL_1H_SECONDS = 3_600;
/** A written entry is readable only once its writer has started to answer. */
export const READABLE_AFTER_SECONDS = 3;
export const MINIMUM_CACHEABLE_TOKENS = 1_024;

/**
 * Token counts are asked for the same prefixes over and over (every turn re-sends
 * the last one, and every lever is compared against the same raw stream), so
 * they are remembered. Bounded: the memo is dropped when it grows large.
 */
const counted = new Map<string, number>();
function tokens(text: string): number {
  const known = counted.get(text);
  if (known !== undefined) return known;
  if (counted.size > 20_000) counted.clear();
  const value = approximateTokenCount(text);
  counted.set(text, value);
  return value;
}

export type Layout = {
  /** The prompt as the provider reads it: tools, then system, then messages. Cache markers are not part of it. */
  content: string;
  /** Offset just after every block that carries a cache_control marker. */
  breakpoints: { offset: number; hour: boolean }[];
  /** True when the request asks for automatic caching with a top-level cache_control. */
  automatic: boolean;
};

/**
 * Lay a Messages request out as the provider matches it. Two requests share a
 * cache entry exactly when one's content up to a breakpoint is a prefix of the
 * other's content, so comparing these strings is comparing cacheability.
 */
export function layout(request: AnyObject): Layout {
  let content = JSON.stringify(request.tools ?? []);
  const breakpoints: Layout["breakpoints"] = [];
  const add = (text: string, block: unknown): void => {
    content += `\n${text}`;
    if (typeof block === "object" && block !== null && "cache_control" in block) {
      const marker = (block as AnyObject).cache_control as AnyObject | undefined;
      breakpoints.push({ offset: content.length, hour: marker?.ttl === "1h" });
    }
  };
  const blockText = (role: string, block: AnyObject): string => {
    if (block.type === "tool_result") {
      return `result:${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`;
    }
    if (block.type === "tool_use") return `call:${JSON.stringify({ name: block.name, input: block.input })}`;
    return `${role}:${typeof block.text === "string" ? block.text : JSON.stringify(block)}`;
  };
  if (typeof request.system === "string") add(`system:${request.system}`, undefined);
  else for (const block of (request.system as AnyObject[] | undefined) ?? []) add(`system:${String(block.text)}`, block);
  for (const message of (request.messages as AnyObject[] | undefined) ?? []) {
    const role = String(message.role);
    if (typeof message.content === "string") add(`${role}:${message.content}`, undefined);
    else for (const block of (message.content as AnyObject[] | undefined) ?? []) add(blockText(role, block), block);
  }
  const automatic = request.cache_control !== undefined && request.cache_control !== null;
  // Automatic caching places one breakpoint on the last cacheable block.
  if (automatic) breakpoints.push({ offset: content.length, hour: (request.cache_control as AnyObject).ttl === "1h" });
  return { content, breakpoints, automatic };
}

export type PricedStream = {
  /** Token-equivalents at the base input rate. */
  inputUnits: number;
  outputUnits: number;
  units: number;
  inputTokens: number;
  readTokens: number;
  writeTokens: number;
};

/**
 * Price a stream: a request reads the longest live earlier entry its prompt
 * starts with, writes from there to its last breakpoint at the write rate, and
 * pays the rest at the plain rate. An entry expires after its lifetime without
 * a read and cannot be read until 3 seconds after it was written, so requests
 * sent together each pay their own write.
 */
export function priceStream(requests: readonly TimedRequest[]): PricedStream {
  const entries: { prefix: string; lastUsed: number; readableAt: number; ttl: number }[] = [];
  const priced: PricedStream = { inputUnits: 0, outputUnits: 0, units: 0, inputTokens: 0, readTokens: 0, writeTokens: 0 };
  for (const { atSeconds, request, outputTokens } of [...requests].sort((a, b) => a.atSeconds - b.atSeconds)) {
    const { content, breakpoints } = layout(request);
    const total = tokens(content);
    const live = breakpoints.filter(({ offset }) => tokens(content.slice(0, offset)) >= MINIMUM_CACHEABLE_TOKENS);
    const lastBreakpoint = live.length > 0 ? Math.max(...live.map(({ offset }) => offset)) : 0;
    const writeMultiplier = live.some(({ hour }) => hour) ? WRITE_MULTIPLIER_1H : WRITE_MULTIPLIER_5M;
    let hit: (typeof entries)[number] | undefined;
    for (const entry of entries) {
      if (atSeconds - entry.lastUsed > entry.ttl || atSeconds < entry.readableAt) continue;
      if (entry.prefix.length > lastBreakpoint) continue;
      if (hit !== undefined && entry.prefix.length <= hit.prefix.length) continue;
      if (content.startsWith(entry.prefix)) hit = entry;
    }
    const readChars = hit?.prefix.length ?? 0;
    if (hit !== undefined) hit.lastUsed = atSeconds;
    const read = tokens(content.slice(0, readChars));
    const write = lastBreakpoint > readChars ? tokens(content.slice(readChars, lastBreakpoint)) : 0;
    const fresh = Math.max(0, total - read - write);
    priced.inputTokens += total;
    priced.readTokens += read;
    priced.writeTokens += write;
    priced.inputUnits += read * READ_MULTIPLIER + write * writeMultiplier + fresh;
    priced.outputUnits += outputTokens * OUTPUT_MULTIPLIER;
    for (const { offset, hour } of live) {
      const prefix = content.slice(0, offset);
      const ttl = hour ? TTL_1H_SECONDS : TTL_5M_SECONDS;
      const existing = entries.find((entry) => entry.prefix === prefix);
      if (existing !== undefined && atSeconds - existing.lastUsed <= existing.ttl) existing.lastUsed = atSeconds;
      else {
        if (existing !== undefined) entries.splice(entries.indexOf(existing), 1);
        entries.push({ prefix, lastUsed: atSeconds, readableAt: atSeconds + READABLE_AFTER_SECONDS, ttl });
      }
    }
  }
  priced.units = priced.inputUnits + priced.outputUnits;
  return priced;
}

/**
 * Run a stream through the real reducer under one configuration. One
 * volatility guard per stream, as the proxy keeps one per process.
 */
export function reduceStream(requests: readonly TimedRequest[], config: MeshTokenReductionConfig | undefined): TimedRequest[] {
  if (config === undefined) return [...requests];
  const guarded: MeshTokenReductionConfig = config.cacheTtl === undefined
    ? config
    : { ...config, cacheVolatilityGuard: new CachePrefixVolatilityGuard() };
  return [...requests]
    .sort((a, b) => a.atSeconds - b.atSeconds)
    .map((timed) => ({ ...timed, request: reduceRequest(timed.request, guarded).request as AnyObject }));
}
