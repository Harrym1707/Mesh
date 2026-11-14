import { createHash } from "node:crypto";

/**
 * Cross-turn volatility guard for the Anthropic cache stamp.
 *
 * The second live export measured the failure this prevents: an agent whose
 * system prompt carried a per-turn clock was stamped every turn, so every
 * turn paid the cache-write premium and no turn ever read — a real loss,
 * honestly ledgered against MESH, but better never made. Prompt caching is a
 * prefix match: content that changes between the turns of one conversation
 * can never be read back, so stamping it only buys write premiums.
 *
 * The guard watches conversations across requests (something the pure
 * per-request reducer cannot do) and answers one question before each stamp:
 * has this conversation's prefix actually been stable so far?
 *
 * - A conversation is identified by its model and FIRST message, which a
 *   multi-turn client re-sends verbatim every turn.
 * - The watched prefix is {tools, system}: if it changes between turns, the
 *   provider's cache misses from position zero and every breakpoint behind
 *   it is worthless.
 * - The message history must EXTEND turn over turn (prior messages a prefix
 *   of current messages). A client-side framework that rewrites history also
 *   invalidates the provider cache every turn.
 *
 * The two breakpoints MESH places fail independently, so they are decided
 * independently (the 2026-10-26 live coding-agent spool measured the cost of
 * treating them as one: three turns billed a 2,267-token prefix at full price
 * that the provider had read from cache one turn earlier):
 *
 * - The SYSTEM breakpoint covers tools + the stamped part of the system
 *   prompt. It is withheld only while that span itself changes between turns.
 *   A rewritten history cannot hurt it: the history comes after it.
 * - The MESSAGE breakpoint covers everything up to the newest message. It is
 *   withheld while either the span or the history churns.
 *
 * Suppression is not permanent: after two consecutive stable observations
 * (e.g. a one-off history compaction followed by normal growth) the withheld
 * breakpoint resumes, so a single disturbance does not forfeit a long
 * conversation's cache earnings. A prefix that churns every turn — the
 * per-turn clock — never produces two stable observations and stays
 * suppressed.
 *
 * WHAT is compared for the system span: the bytes the breakpoint would
 * actually cover, after MESH's deterministic levers, when the reducer supplies
 * them (`context.stampedPrefix`). The provider matches on those bytes, not on
 * what the client sent — so a clock that prefix repair has already moved
 * behind the breakpoint is not churn. Without that context the guard falls
 * back to the client's raw {tools, system}, which is strictly more cautious.
 * The history check always uses the RAW incoming messages, so MESH's own
 * levers are never mistaken for a client rewriting its history.
 */

type AnyObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is AnyObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value ?? null) ?? "null").digest("hex").slice(0, 32);

export type CacheStampDecision = {
  /** False withholds every breakpoint. */
  stamp: boolean;
  /**
   * False withholds only the breakpoint on the newest message; the system
   * breakpoint may still be placed. Absent means the same as `stamp`.
   */
  messageBreakpoint?: boolean;
  /** Present when anything is withheld: why. */
  reason?: string;
};

export type CacheStampContext = {
  /**
   * The content the system breakpoint would cover on this request, after
   * MESH's levers and without any cache_control markers. Only hashed.
   */
  stampedPrefix?: unknown;
};

type Track = { volatile: boolean; stableStreak: number };

type ConversationEntry = {
  prefixHash: string;
  messageHashes: string[];
  prefix: Track;
  history: Track;
};

/** Advance one track; returns whether its breakpoint may be placed this turn. */
function advance(prior: Track, churned: boolean): { track: Track; ok: boolean; proving: boolean } {
  if (churned) return { track: { volatile: true, stableStreak: 0 }, ok: false, proving: false };
  if (!prior.volatile) return { track: prior, ok: true, proving: false };
  const stableStreak = prior.stableStreak + 1;
  if (stableStreak >= 2) return { track: { volatile: false, stableStreak: 0 }, ok: true, proving: false };
  return { track: { volatile: true, stableStreak }, ok: false, proving: true };
}

const PROVING = "this conversation's prefix changed on an earlier turn; waiting for it to prove stable before stamping again";

export class CachePrefixVolatilityGuard {
  /** Insertion-ordered; re-inserted on touch, so the first key is the LRU. */
  private readonly conversations = new Map<string, ConversationEntry>();

  constructor(private readonly maxConversations = 1000) {
    if (!Number.isInteger(maxConversations) || maxConversations < 1) {
      throw new Error("maxConversations must be a positive integer.");
    }
  }

  /**
   * Record this request and decide which cache breakpoints its conversation
   * has earned. Call once per request, with the raw (unreduced) request and,
   * when known, the content the system breakpoint would cover.
   */
  observe(request: unknown, context: CacheStampContext = {}): CacheStampDecision {
    if (!isPlainObject(request) || !Array.isArray(request.messages) || request.messages.length === 0) {
      return { stamp: true };
    }
    const key = digest([request.model ?? null, request.messages[0]]);
    const prefixHash = context.stampedPrefix !== undefined
      ? `span:${digest(context.stampedPrefix)}`
      : `raw:${digest([request.tools ?? null, request.system ?? null])}`;
    const messageHashes = (request.messages as unknown[]).map(digest);

    const prior = this.conversations.get(key);
    if (prior !== undefined) this.conversations.delete(key);

    if (prior === undefined) {
      this.conversations.set(key, {
        prefixHash,
        messageHashes,
        prefix: { volatile: false, stableStreak: 0 },
        history: { volatile: false, stableStreak: 0 },
      });
      this.evict();
      return { stamp: true };
    }

    const prefixChanged = prior.prefixHash !== prefixHash;
    const historyExtends =
      messageHashes.length >= prior.messageHashes.length &&
      prior.messageHashes.every((hash, index) => messageHashes[index] === hash);

    const prefix = advance(prior.prefix, prefixChanged);
    const history = advance(prior.history, !historyExtends);
    this.conversations.set(key, { prefixHash, messageHashes, prefix: prefix.track, history: history.track });

    if (!prefix.ok) {
      return {
        stamp: false,
        messageBreakpoint: false,
        reason: prefixChanged
          ? "tools/system changed between turns of this conversation, so a cached prefix could never be read back"
          : PROVING,
      };
    }
    if (!history.ok) {
      return {
        stamp: true,
        messageBreakpoint: false,
        reason: history.proving
          ? "this conversation's history was rewritten on an earlier turn; waiting for it to prove stable before stamping the newest message again"
          : "the conversation history was rewritten between turns, so a breakpoint on the newest message could never be read back",
      };
    }
    return { stamp: true };
  }

  private evict(): void {
    while (this.conversations.size > this.maxConversations) {
      const oldest = this.conversations.keys().next().value;
      if (oldest === undefined) return;
      this.conversations.delete(oldest);
    }
  }
}
