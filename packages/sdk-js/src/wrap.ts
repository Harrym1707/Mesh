import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recomputeInvoice,
  verifyLedgerChain,
  type LedgerRecord,
} from "../../core/dist/src/index.js";
import { withMesh } from "./openai.js";
import type { MeshTokenReductionConfig } from "./reduce-request.js";

/**
 * wrapMesh — the one-line drop-in for an existing provider client.
 *
 *   import OpenAI from "openai";
 *   import { wrapMesh } from "@harrym1707/sdk";
 *   const openai = wrapMesh(new OpenAI());   // <- the only change
 *   // ...use `openai` exactly as before...
 *   console.log(openai.mesh.savings());      // { requests, savedUsd, ... }
 *
 * This is `withMesh` with sane, zero-config defaults for someone who just wants
 * their AI app to spend less without learning the proxy, the ledger, or any
 * options object. The client's response shapes are preserved, its own key is
 * used, prompts never leave the machine, and reduction is LOSSLESS-ONLY by
 * default — so there is no quality risk to switching one import.
 *
 * The savings number is the real measured one: every request appends a
 * hash-chained ledger event priced from provider-reported usage, and
 * `mesh.savings()` recomputes the invoice from that spool — the same audit a
 * customer runs. It is never MESH's own token estimate.
 */

export type WrapMeshOptions = {
  /** Names this app on the ledger + invoice. Default "app". */
  app?: string;
  /** Where the hash-chained savings ledger is written. Default ./.mesh/<app>.jsonl */
  ledgerPath?: string;
  /** Catalogue provider key for pricing. Auto-detected from the client; override if needed. */
  provider?: string;
  /** Override reduction. Default: lossless-only (safe, no quality gate needed). */
  tokenReduction?: MeshTokenReductionConfig;
  /** Opt into the Anthropic prompt-cache stamp on multi-turn traffic ("5m" | "1h"). */
  cacheTtl?: "5m" | "1h";
  /**
   * Mirror ledger events to a Mesh account. Set both to push each metered
   * event to `${meshApiUrl}/v1/ledger/events`, authenticated by the Mesh
   * account key from signup. Reads MESH_API_URL / MESH_ACCOUNT_KEY from the
   * environment when omitted. The provider key is never sent to Mesh.
   */
  meshApiUrl?: string;
  meshAccountKey?: string;
};

export type MeshSavingsSummary = {
  /** Requests metered through MESH for this app. */
  requests: number;
  /** Net verified savings in USD (never MESH's token estimate; from provider usage). */
  savedUsd: number;
  /** MESH's fee at 1% of verified savings. */
  feeUsd: number;
  verdict: "charge" | "do_not_charge";
  ledgerPath: string;
};

export type MeshHandle = {
  /** Recompute the measured savings from the ledger spool. */
  savings(): MeshSavingsSummary;
  /** The ledger spool path, for `recomputeInvoice` / `mesh-report`. */
  ledgerPath: string;
};

const LOSSLESS_DEFAULT: MeshTokenReductionConfig = {
  toolSchemas: true,
  duplicateContext: true,
  repairCachePrefix: true,
};

function looksAnthropic(client: unknown): boolean {
  const c = client as Record<string, any> | null;
  const hasMessages = typeof c?.messages?.create === "function";
  const hasChat = typeof c?.chat?.completions?.create === "function";
  const hasResponses = typeof c?.responses?.create === "function";
  return hasMessages && !hasChat && !hasResponses;
}

export function wrapMesh<T extends object>(client: T, options: WrapMeshOptions = {}): T & { mesh: MeshHandle } {
  const app = options.app ?? "app";
  const ledgerPath = options.ledgerPath ?? join(process.cwd(), ".mesh", `${app}.jsonl`);
  const provider = options.provider ?? (looksAnthropic(client) ? "anthropic" : "openai");
  const tokenReduction: MeshTokenReductionConfig = {
    ...(options.tokenReduction ?? LOSSLESS_DEFAULT),
    ...(options.cacheTtl ? { cacheTtl: options.cacheTtl } : {}),
  };

  const meshApiUrl = options.meshApiUrl ?? process.env.MESH_API_URL;
  const meshAccountKey = options.meshAccountKey ?? process.env.MESH_ACCOUNT_KEY;
  const mirror = meshApiUrl && meshAccountKey ? { apiUrl: meshApiUrl, accountKey: meshAccountKey } : undefined;

  const wrapped = withMesh(client as never, {
    applicationId: app,
    tokenReduction,
    ledger: { path: ledgerPath, provider, ...(mirror ? { mirror } : {}) },
  }) as T;

  const mesh: MeshHandle = {
    ledgerPath,
    savings(): MeshSavingsSummary {
      const empty: MeshSavingsSummary = {
        requests: 0, savedUsd: 0, feeUsd: 0, verdict: "do_not_charge", ledgerPath,
      };
      let records: LedgerRecord[];
      try {
        const lines = readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
        if (lines.length === 0) return empty;
        records = lines.map((line) => JSON.parse(line) as LedgerRecord);
      } catch {
        return empty;
      }
      // A broken chain means the spool was tampered or truncated: report nothing
      // rather than a number that cannot be trusted.
      if (!verifyLedgerChain(records).ok) return empty;
      const invoice = recomputeInvoice(records.map((r) => r.event), { feePercent: 1 });
      return {
        requests: invoice.eventsConsidered,
        savedUsd: invoice.netVerifiedSavingsUsd,
        feeUsd: invoice.amountDueUsd ?? 0,
        verdict: invoice.verdict,
        ledgerPath,
      };
    },
  };

  // One more proxy layer over withMesh's: everything passes through to the
  // wrapped client, and the synthetic `mesh` handle surfaces the savings.
  return new Proxy(wrapped as T & { mesh: MeshHandle }, {
    get(target, property, receiver) {
      if (property === "mesh") return mesh;
      return Reflect.get(target, property, receiver);
    },
  });
}
