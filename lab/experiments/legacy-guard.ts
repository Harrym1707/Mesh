// FROZEN COPY of the product's cache guard as it shipped for the 2026-10-26 live
// run (packages/sdk-js cache-volatility-guard.ts at 658c727). Kept in the lab
// only so the replica of the live coding agent keeps reproducing what the
// provider actually billed — the "before" that the corrected product guard is
// measured against. It hashes the RAW {tools, system} and withholds EVERY
// breakpoint on any churn. Not exported from the product; do not use it there.

import { createHash } from "node:crypto";

type AnyObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is AnyObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value ?? null) ?? "null").digest("hex").slice(0, 32);

type LegacyDecision = {
  stamp: boolean;
  /** Present when stamp is false: why this conversation is not being stamped. */
  reason?: string;
};

type ConversationEntry = {
  prefixHash: string;
  messageHashes: string[];
  volatile: boolean;
  stableStreak: number;
};

export class LegacyVolatilityGuard {
  /** Insertion-ordered; re-inserted on touch, so the first key is the LRU. */
  private readonly conversations = new Map<string, ConversationEntry>();

  constructor(private readonly maxConversations = 1000) {
    if (!Number.isInteger(maxConversations) || maxConversations < 1) {
      throw new Error("maxConversations must be a positive integer.");
    }
  }

  /**
   * Record this request and decide whether its conversation has earned a
   * cache stamp. Call once per request, with the raw (unreduced) request.
   */
  observe(request: unknown): LegacyDecision {
    if (!isPlainObject(request) || !Array.isArray(request.messages) || request.messages.length === 0) {
      return { stamp: true };
    }
    const key = digest([request.model ?? null, request.messages[0]]);
    const prefixHash = digest([request.tools ?? null, request.system ?? null]);
    const messageHashes = (request.messages as unknown[]).map(digest);

    const prior = this.conversations.get(key);
    if (prior !== undefined) this.conversations.delete(key);

    if (prior === undefined) {
      this.conversations.set(key, { prefixHash, messageHashes, volatile: false, stableStreak: 0 });
      this.evict();
      return { stamp: true };
    }

    const prefixChanged = prior.prefixHash !== prefixHash;
    const historyExtends =
      messageHashes.length >= prior.messageHashes.length &&
      prior.messageHashes.every((hash, index) => messageHashes[index] === hash);

    const entry: ConversationEntry = { prefixHash, messageHashes, volatile: prior.volatile, stableStreak: prior.stableStreak };
    let decision: LegacyDecision = { stamp: true };

    if (prefixChanged || !historyExtends) {
      entry.volatile = true;
      entry.stableStreak = 0;
      decision = {
        stamp: false,
        reason: prefixChanged
          ? "tools/system changed between turns of this conversation, so a cached prefix could never be read back"
          : "the conversation history was rewritten between turns, so a cached prefix could never be read back",
      };
    } else if (entry.volatile) {
      entry.stableStreak += 1;
      if (entry.stableStreak >= 2) {
        entry.volatile = false;
        entry.stableStreak = 0;
      } else {
        decision = {
          stamp: false,
          reason: "this conversation's prefix changed on an earlier turn; waiting for it to prove stable before stamping again",
        };
      }
    }

    this.conversations.set(key, entry);
    return decision;
  }

  private evict(): void {
    while (this.conversations.size > this.maxConversations) {
      const oldest = this.conversations.keys().next().value;
      if (oldest === undefined) return;
      this.conversations.delete(oldest);
    }
  }
}
