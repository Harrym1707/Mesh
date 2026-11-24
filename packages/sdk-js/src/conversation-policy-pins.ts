import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MeshTokenReductionConfig } from "./reduce-request.js";

/**
 * A conversation keeps the policy it started with.
 *
 * A prompt cache matches an exact prefix, and an agent's conversation is one
 * growing prefix. Every MESH lever changes bytes inside that prefix the same
 * way on every turn, so the cache holds - as long as the SAME levers act on
 * every turn. The policy, though, can change at any moment: Theo publishes a
 * lever, a user edits the policy file, the proxy is started while a client is
 * already mid-conversation. From that turn on the prefix is different bytes,
 * the provider's cache misses from the top, and the whole history is written
 * again at 1.25x instead of read at a tenth. Measured in the lab on cached
 * conversations: up to 45% more input cost for that conversation.
 *
 * So the proxy asks this class which policy a request gets:
 *
 *   - A conversation seen before keeps the policy it was first given, for as
 *     long as a provider cache could still hold it.
 *   - A request that STARTS a conversation (the model has not answered in it
 *     yet, or it is no longer than when the conversation was first seen)
 *     takes the current policy, even if an earlier conversation opened with
 *     the same message. One-shot calls are always starts, so they are never
 *     held on an old policy.
 *   - Once it has been idle longer than any cache lives, nothing is cached any
 *     more and a change is free: it takes the current policy.
 *   - A conversation MESH did not see the start of, whose caller is caching
 *     it, is left untouched: its cached prefix is the caller's own bytes.
 *   - Any other conversation starts on the current policy.
 *
 * One exception, on purpose: a LOSSY lever the current policy no longer has
 * is dropped at once, mid-conversation, cache or no cache. Theo removes a
 * lossy lever when quality drifts, and "never degrade" outranks one re-write.
 *
 * A conversation is identified by its model and first message, keyed with an
 * HMAC, exactly as the volatility guard does: no content is kept.
 */

/** The plain-data fields of a reduction config. Callbacks and guards are never pinned. */
const DATA_KEYS = [
  "toolSchemas", "dropTools", "duplicateContext", "repairCachePrefix", "historyCompaction",
  "crossTurnMemoryDedup", "freshToolResultCap", "toolResultJson", "maxOutputTokens",
  "outputEffort", "executionTier", "cacheTtl",
] as const;
type DataKey = (typeof DATA_KEYS)[number];
export type PinnedPolicy = Partial<Pick<MeshTokenReductionConfig, DataKey>>;

/** No lever at all. Two levers default to on when unset, so they are switched off explicitly. */
export const UNTOUCHED_POLICY: PinnedPolicy = { toolSchemas: false, duplicateContext: false };

/** The fields that, when set, switch a LOSSY lever on. */
const LOSSY_KEYS: readonly DataKey[] = [
  "dropTools", "historyCompaction", "crossTurnMemoryDedup", "freshToolResultCap", "maxOutputTokens", "outputEffort",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataOf(config: MeshTokenReductionConfig): PinnedPolicy {
  const out: Record<string, unknown> = {};
  for (const key of DATA_KEYS) {
    const value = (config as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = structuredClone(value);
  }
  return out as PinnedPolicy;
}

const enabled = (value: unknown): boolean =>
  value !== undefined && value !== false && value !== null && !(Array.isArray(value) && value.length === 0);

/** Does this tool-schema setting trim descriptions (the lossy tier)? */
const trimsDescriptions = (value: unknown): boolean =>
  isPlainObject(value) && (value.descriptions === "truncate" || value.descriptions === "drop");

/**
 * Remove from a pinned policy every lossy lever the current policy no longer
 * enables. Returns the same object when nothing had to go.
 */
function withoutWithdrawnLossy(pinned: PinnedPolicy, current: MeshTokenReductionConfig): PinnedPolicy {
  let next: Record<string, unknown> | undefined;
  const edit = (): Record<string, unknown> => (next ??= { ...pinned });
  for (const key of LOSSY_KEYS) {
    if (enabled(pinned[key]) && !enabled((current as Record<string, unknown>)[key])) delete edit()[key];
  }
  if (trimsDescriptions(pinned.toolSchemas) && !trimsDescriptions(current.toolSchemas)) {
    // Fall back to the lossless tier unless the current policy has schemas off altogether.
    edit().toolSchemas = current.toolSchemas === false ? false : true;
  }
  return (next as PinnedPolicy | undefined) ?? pinned;
}

/**
 * A message as it identifies a conversation: without cache markers, and with a
 * plain-string body written as the one text block it is equivalent to. A
 * caching client moves its `cache_control` marker to the newest block every
 * turn, so the FIRST message carries a marker on turn one and none afterwards;
 * its identity must not change with that.
 */
function withoutCacheMarkers(value: unknown, depth = 0): unknown {
  if (depth > 64 || typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => withoutCacheMarkers(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "cache_control") continue;
    out[key] = depth === 0 && key === "content" && typeof inner === "string"
      ? [{ type: "text", text: inner }]
      : withoutCacheMarkers(inner, depth + 1);
  }
  return out;
}

type Entry = {
  policy: PinnedPolicy;
  firstSeenMs: number;
  lastSeenMs: number;
  /** MESH did not see this conversation start and its caller is caching it: nothing is changed. */
  untouched: boolean;
  /** How many messages the request carried when the pin was made. A later request no longer than this is a new start. */
  messagesAtStart: number;
};

export type PinDecision =
  /** No conversation could be identified: the current policy applies. */
  | "unpinned"
  /** First request of a conversation: pinned to the current policy. */
  | "started"
  /** A conversation in flight keeps the policy it started with. */
  | "kept"
  /** As "kept", but a lossy lever the current policy withdrew was dropped. */
  | "kept-lossy-withdrawn"
  /** Idle past the cache lifetime: re-pinned to the current policy. */
  | "refreshed"
  /** Joined mid-conversation under a caller's cache: left untouched. */
  | "untouched";

export type ConversationPolicyPinOptions = {
  /** How long a provider cache can outlive its last read. Default one hour, the longest lifetime offered. */
  cacheLifetimeMs?: number;
  /** Bound on remembered conversations; the least recently seen goes first. Default 5,000. */
  maxConversations?: number;
  /** Key for the conversation hash. Without one a random per-process key is used and nothing is persisted. */
  hmacKey?: string;
  /** Where to keep the pins across restarts (owner-only). Used only together with `hmacKey`. */
  persistPath?: string;
};

export class ConversationPolicyPins {
  private readonly entries = new Map<string, Entry>();
  private readonly cacheLifetimeMs: number;
  private readonly maxConversations: number;
  private readonly key: string;
  private readonly persistPath: string | undefined;
  private lastSavedMs = 0;
  private dirty = false;

  constructor(options: ConversationPolicyPinOptions = {}) {
    this.cacheLifetimeMs = options.cacheLifetimeMs ?? 3_600_000;
    this.maxConversations = options.maxConversations ?? 5_000;
    if (!Number.isFinite(this.cacheLifetimeMs) || this.cacheLifetimeMs < 0) throw new Error("cacheLifetimeMs must be zero or more.");
    if (!Number.isInteger(this.maxConversations) || this.maxConversations < 1) throw new Error("maxConversations must be a positive integer.");
    this.key = options.hmacKey ?? randomBytes(32).toString("hex");
    this.persistPath = options.hmacKey !== undefined ? options.persistPath : undefined;
    this.load();
  }

  /** How many conversations are remembered. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The policy this request gets. `current` is the policy in force now; the
   * result carries its callbacks and guards with the pinned data fields.
   */
  resolve(
    request: unknown,
    current: MeshTokenReductionConfig,
    nowMs: number = Date.now(),
  ): { config: MeshTokenReductionConfig; decision: PinDecision } {
    const conversation = this.conversationOf(request);
    if (conversation === undefined) return { config: current, decision: "unpinned" };

    let decision: PinDecision;
    let entry = this.entries.get(conversation.key);
    // A start: the model has not answered yet, or the conversation is back to
    // (or under) the length it had when first seen - the same opening message
    // used again. An untouched conversation is only restarted by a strictly
    // shorter request, so a retry of the turn it was joined at changes nothing.
    if (entry !== undefined && (!conversation.inFlight ||
        (entry.untouched ? conversation.messageCount < entry.messagesAtStart : conversation.messageCount <= entry.messagesAtStart))) {
      this.entries.delete(conversation.key);
      entry = undefined;
    }
    if (entry !== undefined) {
      const idle = nowMs - entry.lastSeenMs > this.cacheLifetimeMs;
      // An untouched conversation is left alone for one cache lifetime from
      // when it was first seen, then joins the current policy.
      const untouchedExpired = entry.untouched && nowMs - entry.firstSeenMs > this.cacheLifetimeMs;
      if (idle || untouchedExpired) {
        entry.policy = dataOf(current);
        entry.untouched = false;
        entry.firstSeenMs = nowMs;
        decision = "refreshed";
        this.dirty = true;
      } else {
        const kept = entry.untouched ? entry.policy : withoutWithdrawnLossy(entry.policy, current);
        decision = entry.untouched ? "untouched" : kept === entry.policy ? "kept" : "kept-lossy-withdrawn";
        if (kept !== entry.policy) {
          entry.policy = kept;
          this.dirty = true;
        }
      }
      entry.lastSeenMs = nowMs;
      this.entries.delete(conversation.key); // re-insert: most recently seen last
      this.entries.set(conversation.key, entry);
    } else {
      const untouched = conversation.inFlight && conversation.callerCaches;
      entry = {
        policy: untouched ? { ...UNTOUCHED_POLICY } : dataOf(current),
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        untouched,
        messagesAtStart: conversation.messageCount,
      };
      decision = untouched ? "untouched" : "started";
      this.entries.set(conversation.key, entry);
      while (this.entries.size > this.maxConversations) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
      this.dirty = true;
    }
    this.save(nowMs);

    // The current policy's callbacks and guards, with the pinned data fields
    // in place of its own.
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
      if (!(DATA_KEYS as readonly string[]).includes(key)) config[key] = value;
    }
    Object.assign(config, structuredClone(entry.policy));
    return { config: config as MeshTokenReductionConfig, decision };
  }

  /** Write the pins out now (the proxy calls this on shutdown). Never throws. */
  flush(nowMs: number = Date.now()): void {
    this.lastSavedMs = 0;
    this.save(nowMs);
  }

  private conversationOf(request: unknown): { key: string; inFlight: boolean; callerCaches: boolean; messageCount: number } | undefined {
    if (!isPlainObject(request)) return undefined;
    const messages = Array.isArray(request.messages) ? request.messages
      : Array.isArray(request.input) ? request.input : undefined;
    if (messages === undefined || messages.length === 0) return undefined;
    const model = typeof request.model === "string" ? request.model : "";
    let first: string;
    try {
      first = JSON.stringify(withoutCacheMarkers(messages[0])) ?? "";
    } catch {
      return undefined;
    }
    const key = createHmac("sha256", this.key).update(model).update("\n").update(first).digest("hex").slice(0, 32);
    // In flight: the model has already answered at least once in what the caller sent.
    const inFlight = messages.some((message) => isPlainObject(message) &&
      (message.role === "assistant" || message.type === "function_call" || message.type === "function_call_output"));
    let callerCaches = false;
    try {
      callerCaches = (JSON.stringify(request) ?? "").includes('"cache_control"');
    } catch {
      callerCaches = false;
    }
    return { key, inFlight, callerCaches, messageCount: messages.length };
  }

  private load(): void {
    if (this.persistPath === undefined) return;
    try {
      const stored = JSON.parse(readFileSync(this.persistPath, "utf8")) as { version?: number; pins?: unknown };
      if (stored.version !== 1 || !Array.isArray(stored.pins)) return;
      for (const item of stored.pins) {
        if (!Array.isArray(item) || typeof item[0] !== "string" || !isPlainObject(item[1])) continue;
        const entry = item[1] as Partial<Entry>;
        if (!isPlainObject(entry.policy) || typeof entry.firstSeenMs !== "number" || typeof entry.lastSeenMs !== "number") continue;
        this.entries.set(item[0], {
          policy: entry.policy as PinnedPolicy,
          firstSeenMs: entry.firstSeenMs,
          lastSeenMs: entry.lastSeenMs,
          untouched: entry.untouched === true,
          messagesAtStart: typeof entry.messagesAtStart === "number" ? entry.messagesAtStart : 1,
        });
      }
    } catch {
      // No file, or one that cannot be read: start empty. Never a reason to fail.
    }
  }

  private save(nowMs: number): void {
    if (this.persistPath === undefined || !this.dirty) return;
    if (nowMs - this.lastSavedMs < 2_000) return; // at most one write every two seconds
    try {
      // Conversations idle past the cache lifetime need no pin: they refresh on return anyway.
      const pins = [...this.entries].filter(([, entry]) => nowMs - entry.lastSeenMs <= this.cacheLifetimeMs);
      mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.persistPath, `${JSON.stringify({ version: 1, pins })}\n`, { mode: 0o600 });
      this.lastSavedMs = nowMs;
      this.dirty = false;
    } catch {
      // The pin file is a convenience across restarts; the request path never depends on it.
    }
  }
}
