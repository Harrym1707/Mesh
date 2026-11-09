import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
// Import the specific core modules, not the package barrel: the barrel
// re-exports the whole library (router, triage, observability adapters,
// billing), which would all bundle into anything that depends on the proxy.
import { collectRequestText, measureOutputReEmission } from "../../core/dist/src/output-diagnostics.js";
import { normalizeProviderUsage, responseServiceTier } from "../../core/dist/src/provider-usage.js";
import { responseText } from "./replay-gate.js";
import { CachePrefixVolatilityGuard } from "./cache-volatility-guard.js";
import { reduceRequest, type MeshTokenReductionConfig } from "./reduce-request.js";
import { extractBlindFeatures } from "./blind-features.js";
import { createSavingsLedger, type SavingsLedger } from "./savings-ledger.js";
import type { MeshRequestEvent } from "./types.js";

/**
 * MESH proxy mode: point an application's base_url here instead of changing
 * its code. The proxy applies the configured token reduction to each request,
 * forwards it to the real provider with the CALLER's own credentials, returns
 * the provider's bytes untouched, and appends one hash-chained ledger event
 * per completed request — the same recomputable record the SDK wrapper writes.
 *
 * The contract, enforced rather than promised:
 * - MESH never holds keys. Auth headers pass through verbatim; nothing is
 *   stored. Prompts are analysed in-process and never written anywhere — the
 *   ledger records usage numbers, lever names and hashes, not content.
 * - Nothing here may break a request. Reduction never throws (a failure
 *   returns the original request); a ledger failure silently disables the
 *   meter; only an unreachable upstream produces an error, and it is the
 *   upstream's own status and body wherever one exists.
 * - Responses stream through as they arrive. Usage for the ledger is parsed
 *   from the SSE events after the last byte has already been forwarded; a
 *   stream whose usage cannot be read produces an UNPRICED event, never a
 *   guessed one.
 * - Lossless levers only by default. Lossy levers and tier/cache stamps are
 *   per-deployment configuration, exactly as in the SDK.
 */

type AnyObject = Record<string, unknown>;

export type MeshProxyOptions = {
  /** Port to listen on; 0 picks a free one (reported by start()). */
  port?: number;
  /** Directory for the hash-chained ledger spools (one per app + provider). */
  ledgerDirectory: string;
  /**
   * Reduction config applied to every proxied request. Pass a getter instead of
   * a fixed config to have it re-read per request, so a policy Theo publishes
   * takes effect without restarting the proxy (hot-reload). Lossless-only default.
   */
  tokenReduction?: MeshTokenReductionConfig | (() => MeshTokenReductionConfig);
  /** Override upstreams, e.g. a mock in tests or an OpenAI-compatible host. */
  anthropicUpstream?: string;
  openaiUpstream?: string;
  /**
   * Enable the provably-blind learning stream: when set, each request also
   * appends an IRREVERSIBLE feature record (keyed HMAC hashes + structural
   * counts, never any prompt content) to a `<app>-<provider>.features.jsonl`
   * spool. This is the hmac key; it must live only in the gateway (ideally
   * sealed inside an enclave). Off when unset — no features are computed.
   */
  blindFeaturesKey?: string;
  /**
   * Mirror ledger events to a Mesh account. When both are set, each appended
   * record is pushed fire-and-forget to `${meshApiUrl}/v1/ledger/events`,
   * authenticated by the Mesh account key. The local spools stay authoritative,
   * and the customer's provider key is never involved.
   */
  meshApiUrl?: string;
  meshAccountKey?: string;
  /**
   * Opt-in local request capture for Theo's replay gate. When set, each proxied
   * request's ORIGINAL body (prompt content included) is appended as JSONL to
   * `path`, owner-only, up to `limit` requests (default 50) AND `maxBytes` on
   * disk (default 5 MiB, enforced against the file's actual size so it holds
   * across restarts). This is the one place the proxy writes prompt content; it
   * is OFF unless explicitly enabled, the file never leaves the machine, and
   * `mesh theo --gate <path>` reads it.
   */
  requestCapture?: { path: string; limit?: number; maxBytes?: number };
};

export type MeshProxy = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

const LOSSLESS_DEFAULT: MeshTokenReductionConfig = {
  toolSchemas: true,
  duplicateContext: true,
  repairCachePrefix: true,
};

/** Headers that describe the hop, not the request; never forwarded. */
const HOP_HEADERS = new Set([
  "host", "content-length", "connection", "accept-encoding", "transfer-encoding",
  "upgrade", "te", "trailer", "keep-alive", "proxy-authorization",
]);

/**
 * Copy the caller's headers for one upstream, scoped so a credential meant
 * for one provider is never forwarded to the other: a client configured with
 * BOTH an Anthropic x-api-key and an OpenAI Authorization bearer must not
 * have the off-provider key ride along. x-api-key is Anthropic's header and
 * never goes to OpenAI; Authorization is dropped for Anthropic exactly when
 * an x-api-key is present (Anthropic's own OAuth users carry Authorization
 * WITHOUT x-api-key, and that must keep working). MESH's own routing header
 * never leaves the machine.
 */
function forwardHeaders(req: IncomingMessage, provider: "anthropic" | "openai"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  delete out["x-mesh-application"];
  if (provider === "openai") {
    delete out["x-api-key"];
  } else if (out["x-api-key"] !== undefined) {
    delete out.authorization;
  }
  // Identity keeps the body parseable for usage extraction without a
  // decompression stage in the request path.
  out["accept-encoding"] = "identity";
  return out;
}

/** Largest accepted request body: beyond this is a 413, not an OOM. */
const BODY_CAP = 64 * 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() { super(`Request body exceeds the ${BODY_CAP / (1024 * 1024)} MB cap.`); }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > BODY_CAP) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The proxy serves loopback clients only; reject anything else (DNS rebinding). */
function hostAllowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "";
}

type Surface = {
  provider: "anthropic" | "openai";
  upstreamPath: string;
};

function surfaceOf(path: string): Surface | undefined {
  if (path === "/v1/messages") return { provider: "anthropic", upstreamPath: "/v1/messages" };
  if (path === "/v1/responses") return { provider: "openai", upstreamPath: "/v1/responses" };
  if (path === "/v1/chat/completions") return { provider: "openai", upstreamPath: "/v1/chat/completions" };
  return undefined;
}

/**
 * Merge the usage scattered across a surface's SSE events into one response-
 * shaped object normalizeProviderUsage can read. Returns undefined when the
 * stream carried no readable usage — the event is then unpriced, never guessed.
 */
export function usageFromSse(provider: "anthropic" | "openai", sseText: string): AnyObject | undefined {
  const events: AnyObject[] = [];
  for (const line of sseText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as AnyObject;
      if (typeof parsed === "object" && parsed !== null) events.push(parsed);
    } catch {
      // Non-JSON data lines are legal SSE; skip them.
    }
  }
  if (events.length === 0) return undefined;

  if (provider === "anthropic") {
    // message_start carries the input side; the LAST message_delta carries the
    // final cumulative output_tokens.
    const start = events.find((e) => e.type === "message_start");
    const startUsage = (start?.message as AnyObject | undefined)?.usage as AnyObject | undefined;
    if (startUsage === undefined) return undefined;
    let outputTokens: unknown = startUsage.output_tokens;
    let tier: unknown = (start?.message as AnyObject | undefined)?.service_tier ?? startUsage.service_tier;
    for (const e of events) {
      if (e.type !== "message_delta") continue;
      const deltaUsage = e.usage as AnyObject | undefined;
      if (deltaUsage?.output_tokens !== undefined) outputTokens = deltaUsage.output_tokens;
    }
    return {
      usage: { ...startUsage, output_tokens: outputTokens ?? 0 },
      ...(typeof tier === "string" ? { service_tier: tier } : {}),
    };
  }

  // OpenAI Responses: response.completed carries the whole final response.
  const completed = [...events].reverse().find((e) => e.type === "response.completed");
  const completedResponse = completed?.response as AnyObject | undefined;
  if (completedResponse?.usage !== undefined) return completedResponse;
  // Chat Completions: the final chunk carries usage when the caller asked for
  // it via stream_options.include_usage; otherwise there is nothing to read.
  const withUsage = [...events].reverse().find((e) => e.usage !== undefined && e.usage !== null);
  return withUsage;
}

/**
 * Assistant text of a streamed response, for output-waste metering: the
 * concatenated text deltas of whichever surface produced the stream. Used
 * only after the bytes were already forwarded; never stored.
 */
export function outputTextFromSse(provider: "anthropic" | "openai", sseText: string): string {
  const parts: string[] = [];
  for (const line of sseText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as AnyObject;
      if (provider === "anthropic") {
        const delta = parsed.delta as AnyObject | undefined;
        if (parsed.type === "content_block_delta" && typeof delta?.text === "string") parts.push(delta.text);
      } else {
        if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") parts.push(parsed.delta);
        const choices = parsed.choices as Array<AnyObject> | undefined;
        const chatDelta = choices?.[0]?.delta as AnyObject | undefined;
        if (typeof chatDelta?.content === "string") parts.push(chatDelta.content);
      }
    } catch {
      // Non-JSON data lines are legal SSE; skip.
    }
  }
  return parts.join("");
}

/** Start the MESH proxy. Resolves once the server is listening. */
export function startMeshProxy(options: MeshProxyOptions): Promise<MeshProxy> {
  // Reduction may be a getter, resolved per request, so a policy Theo publishes
  // takes effect without restarting the proxy. The volatility guard is stateful
  // across requests (it suppresses cache stamping of prefixes that churn between
  // turns, a measured live loss otherwise), so keep ONE instance and merge it
  // into whatever policy is current.
  const reductionOption = options.tokenReduction;
  const resolveBaseReduction: () => MeshTokenReductionConfig =
    typeof reductionOption === "function"
      ? reductionOption
      : () => reductionOption ?? LOSSLESS_DEFAULT;
  let volatilityGuard: CachePrefixVolatilityGuard | undefined;
  const currentReduction = (): MeshTokenReductionConfig => {
    let base: MeshTokenReductionConfig;
    try {
      base = resolveBaseReduction() ?? LOSSLESS_DEFAULT;
    } catch {
      base = LOSSLESS_DEFAULT; // a bad policy file must never break the request path
    }
    if (base.cacheTtl !== undefined && base.cacheVolatilityGuard === undefined) {
      volatilityGuard ??= new CachePrefixVolatilityGuard();
      return { ...base, cacheVolatilityGuard: volatilityGuard };
    }
    return base;
  };
  const upstreams = {
    anthropic: (options.anthropicUpstream ?? "https://api.anthropic.com").replace(/\/$/, ""),
    openai: (options.openaiUpstream ?? "https://api.openai.com").replace(/\/$/, ""),
  };
  const ledgers = new Map<string, SavingsLedger>();
  const LEDGER_CAP = 200;
  // Byte-identical request detection (metering only): real agent traces show
  // 4-8% of actions are exact retries. Hash of app + raw body -> requestId,
  // LRU-bounded; the ledger event carries duplicateOfRequestId so the
  // statement can show retry waste. Hashes only; content never stored.
  const recentRequestHashes = new Map<string, string>();
  const RECENT_HASH_CAP = 500;
  const ledgerFor = (applicationId: string, provider: "anthropic" | "openai"): SavingsLedger => {
    // Key by the SANITIZED name: two raw ids that sanitize to the same spool
    // file must share one ledger instance, or their interleaved chain tails
    // would fork the hash chain inside that file.
    const safeApp = applicationId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "proxy";
    const key = `${safeApp}\n${provider}`;
    const existing = ledgers.get(key);
    if (existing !== undefined) {
      ledgers.delete(key);
      ledgers.set(key, existing); // refresh LRU order
      return existing;
    }
    // Bound the map: a client inventing application ids must not grow memory
    // and open files without limit. Evicting is safe — a recreated ledger
    // resumes its chain from the spool's tail.
    while (ledgers.size >= LEDGER_CAP) {
      const oldest = ledgers.keys().next().value;
      if (oldest === undefined) break;
      ledgers.delete(oldest);
    }
    const ledger = createSavingsLedger({
      path: join(options.ledgerDirectory, `${safeApp}-${provider}.jsonl`),
      provider,
      ...(options.meshApiUrl && options.meshAccountKey
        ? { mirror: { apiUrl: options.meshApiUrl, accountKey: options.meshAccountKey } }
        : {}),
    });
    ledgers.set(key, ledger);
    return ledger;
  };

  // The blind learning stream: irreversible features beside the content-free
  // ledger. Best-effort and fully isolated — a features write can never affect
  // the request path (it runs inside the ledger try/catch that already swallows
  // failures). Only enabled when a per-deployment hmac key is supplied.
  const blindFeaturesKey = options.blindFeaturesKey;
  const writeBlindFeatures = (applicationId: string, provider: "anthropic" | "openai", record: unknown): void => {
    const safeApp = applicationId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "proxy";
    // Private to the user: metadata + keyed hashes only, but not world-readable.
    mkdirSync(options.ledgerDirectory, { recursive: true, mode: 0o700 });
    appendFileSync(join(options.ledgerDirectory, `${safeApp}-${provider}.features.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };

  // Opt-in request capture for Theo's gate — OFF unless requestCapture is set.
  // This is the only path that writes prompt content, bounded and owner-only.
  const requestCapture = options.requestCapture;
  const captureLimit = requestCapture?.limit ?? 50;
  const captureMaxBytes = requestCapture?.maxBytes ?? 5 * 1024 * 1024;
  let capturedRequests = 0;
  // Seed from the file's current size so the byte cap bounds prompt content on
  // disk across restarts, not just within one process.
  let capturedBytes = ((): number => {
    if (requestCapture === undefined) return 0;
    try { return existsSync(requestCapture.path) ? statSync(requestCapture.path).size : 0; } catch { return 0; }
  })();
  const writeCapturedRequest = (body: unknown): void => {
    if (requestCapture === undefined || body === undefined || capturedRequests >= captureLimit) return;
    try {
      const line = `${JSON.stringify({ request: body })}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (capturedBytes + lineBytes > captureMaxBytes) return; // keep prompt content on disk bounded
      mkdirSync(dirname(requestCapture.path), { recursive: true, mode: 0o700 });
      appendFileSync(requestCapture.path, line, { mode: 0o600 });
      capturedRequests += 1;
      capturedBytes += lineBytes;
    } catch {
      // Capture is best-effort and must never affect the request path.
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?")[0]!;

    // Loopback clients only: a browser page rebound to this origin must not
    // be able to drive the proxy.
    if (!hostAllowed(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "MESH proxy serves loopback clients only." }));
      return;
    }

    // CSRF-to-localhost defense. A web page in the user's browser can reach this
    // loopback port, but when it drives a cross-origin request the browser
    // attaches Sec-Fetch-Site: cross-site / same-site (and the page cannot forge
    // it). A real local CLI client (Claude Code, an SDK) sends no Sec-Fetch
    // headers at all. Reject the browser cross-origin case; it can only ever be
    // forced noise/DoS (the proxy injects no credentials, so no key/quota is at
    // stake), but it has no legitimate use.
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite === "cross-site" || fetchSite === "same-site") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "MESH proxy does not serve cross-origin browser requests." }));
      return;
    }

    // Transparent GET passthrough (model lists, etc.): no reduction, no
    // ledger event, bytes forwarded both ways. The provider is picked the way
    // the providers themselves do: x-api-key is Anthropic's header. The
    // forwarded headers are scoped to that one provider — the other
    // provider's credential never rides along.
    if (req.method === "GET" && path.startsWith("/v1/")) {
      const provider = req.headers["x-api-key"] !== undefined ? "anthropic" : "openai";
      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(`${upstreams[provider]}${req.url}`, {
          headers: forwardHeaders(req, provider),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (cause) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Upstream unreachable: ${(cause as Error).message}` }));
        return;
      }
      const passHeaders: Record<string, string> = {};
      upstreamResponse.headers.forEach((value, name) => {
        if (!HOP_HEADERS.has(name.toLowerCase())) passHeaders[name] = value;
      });
      res.writeHead(upstreamResponse.status, passHeaders);
      res.end(Buffer.from(await upstreamResponse.arrayBuffer()));
      return;
    }

    const surface = req.method === "POST" ? surfaceOf(path) : undefined;
    if (surface === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: "MESH proxy forwards POST /v1/messages (Anthropic), /v1/responses and " +
          "/v1/chat/completions (OpenAI-compatible). Point your client's base_url at this server.",
      }));
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readBody(req);
    } catch (cause) {
      if (cause instanceof BodyTooLargeError && !res.headersSent) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: cause.message }));
      }
      return;
    }
    let body: AnyObject | undefined;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as AnyObject;
    } catch {
      body = undefined;
    }
    if (body === undefined || typeof body !== "object") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "The request body is not a JSON object." }));
      return;
    }

    // Reduce. reduceRequest never throws; a failure returns the original.
    // currentReduction() resolves the latest policy (hot-reload) per request.
    const { request: reducedRequest, summary } = reduceRequest(body, currentReduction());
    const sendBody = JSON.stringify(reducedRequest);
    const applicationIdHeader = req.headers["x-mesh-application"];
    const applicationId = ((Array.isArray(applicationIdHeader) ? applicationIdHeader[0] : applicationIdHeader) ?? "proxy").slice(0, 128);
    const headers = forwardHeaders(req, surface.provider);
    headers["content-type"] = "application/json";

    // The upstream call is aborted the moment the CLIENT goes away: a
    // cancelled generation must stop billing the caller's key, not stream to
    // completion against a dead socket. Timeouts are phased — one for
    // connection+headers, then a rolling idle timeout per chunk — because a
    // single whole-fetch deadline would cut off long legitimate streams.
    const upstreamControl = new AbortController();
    const abortUpstream = (reason: string): void => upstreamControl.abort(new Error(reason));
    const onClientClose = (): void => {
      if (!res.writableEnded) abortUpstream("client disconnected");
    };
    res.on("close", onClientClose);
    const HEADER_TIMEOUT_MS = 120_000;
    const IDLE_TIMEOUT_MS = 120_000;
    let phaseTimer: NodeJS.Timeout = setTimeout(() => abortUpstream("upstream produced no response headers within 120s"), HEADER_TIMEOUT_MS);

    const requestId = randomUUID();
    const bodyHash = createHash("sha256").update(applicationId).update("\n").update(rawBody).digest("hex");
    const duplicateOfRequestId = recentRequestHashes.get(bodyHash);
    if (duplicateOfRequestId === undefined) {
      while (recentRequestHashes.size >= RECENT_HASH_CAP) {
        const oldest = recentRequestHashes.keys().next().value;
        if (oldest === undefined) break;
        recentRequestHashes.delete(oldest);
      }
      recentRequestHashes.set(bodyHash, requestId);
    }

    const startedAt = Date.now();
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(`${upstreams[surface.provider]}${surface.upstreamPath}`, {
        method: "POST",
        headers,
        body: sendBody,
        signal: upstreamControl.signal,
      });
    } catch (cause) {
      clearTimeout(phaseTimer);
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Upstream unreachable: ${(cause as Error).message}` }));
      }
      return;
    }
    clearTimeout(phaseTimer);

    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!HOP_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
    });
    if (res.destroyed) {
      abortUpstream("client disconnected");
      return;
    }
    res.writeHead(upstreamResponse.status, responseHeaders);

    // Stream the provider's bytes through as they arrive, accumulating a copy
    // (bounded) for usage extraction AFTER the client has everything. The
    // write path respects backpressure (a slow client must not buffer the
    // whole response in memory), and a destroyed client socket both stops the
    // loop and aborts the upstream read.
    const chunks: Buffer[] = [];
    let accumulated = 0;
    const ACCUMULATION_CAP = 32 * 1024 * 1024;
    let clientLost = false;
    if (upstreamResponse.body !== null) {
      const reader = upstreamResponse.body.getReader();
      try {
        for (;;) {
          phaseTimer = setTimeout(() => abortUpstream("upstream stream idle for 120s"), IDLE_TIMEOUT_MS);
          let done: boolean;
          let value: Uint8Array | undefined;
          try {
            ({ done, value } = await reader.read());
          } finally {
            clearTimeout(phaseTimer);
          }
          if (done) break;
          if (res.destroyed) {
            clientLost = true;
            abortUpstream("client disconnected");
            break;
          }
          const chunk = Buffer.from(value!);
          const flushed = res.write(chunk);
          if (accumulated < ACCUMULATION_CAP) {
            chunks.push(chunk);
            accumulated += chunk.byteLength;
          }
          if (!flushed) {
            await new Promise<void>((proceed) => {
              const onDrain = (): void => { res.off("close", onGone); proceed(); };
              const onGone = (): void => { res.off("drain", onDrain); proceed(); };
              res.once("drain", onDrain);
              res.once("close", onGone);
            });
          }
        }
      } catch {
        // Aborted upstream read (client gone or idle timeout): fall through —
        // whatever usage was accumulated still produces an honest ledger
        // event for the tokens that were actually streamed and billed.
        clientLost = res.destroyed;
      }
    }
    res.off("close", onClientClose);
    if (!clientLost && !res.destroyed) res.end();

    // Ledger event, after the response is fully forwarded. Never throws.
    try {
      const text = Buffer.concat(chunks).toString("utf8");
      const contentType = upstreamResponse.headers.get("content-type") ?? "";
      // Opt-in diagnostic (MESH_PROXY_DEBUG=1): on a non-2xx upstream, log the status,
      // the model and beta header the client sent, and a snippet of the error body
      // (an API error description, never prompt content). Never logs credentials.
      if (process.env.MESH_PROXY_DEBUG === "1" && !upstreamResponse.ok) {
        console.warn(
          `[mesh-debug] upstream ${upstreamResponse.status} model=${JSON.stringify(body.model)} path=${path} ` +
          `anthropic-beta=${JSON.stringify(req.headers["anthropic-beta"] ?? null)} ` +
          `errbody=${text.slice(0, 500)}`,
        );
      }
      let responseShaped: AnyObject | undefined;
      if (contentType.includes("text/event-stream")) {
        responseShaped = usageFromSse(surface.provider, text);
      } else {
        try {
          responseShaped = JSON.parse(text) as AnyObject;
        } catch {
          responseShaped = undefined;
        }
      }
      const usageResult = responseShaped === undefined
        ? undefined
        : normalizeProviderUsage(responseShaped);
      const usage = usageResult?.status === "ok" ? usageResult.usage : undefined;
      const tier = responseShaped === undefined ? undefined : responseServiceTier(responseShaped);
      // Output-waste metering on large completions only (real-trace ground
      // truth: the top 10% of turns carry ~half of output tokens).
      let outputDiagnostics: { inspectedOutputTokens: number; reEmittedOutputTokens: number; reEmittedCodeTokens: number } | undefined;
      if (usage !== undefined && usage.outputTokens >= 200 && responseShaped !== undefined) {
        const outputText = contentType.includes("text/event-stream")
          ? outputTextFromSse(surface.provider, text)
          : responseText(responseShaped);
        if (outputText.length > 0) {
          outputDiagnostics = measureOutputReEmission(collectRequestText(body), outputText);
        }
      }
      const event: MeshRequestEvent = {
        requestId,
        applicationId,
        provider: `${surface.provider}-compatible`,
        model: typeof body.model === "string" ? body.model : "unknown",
        latencyMs: Date.now() - startedAt,
        status: upstreamResponse.ok ? "succeeded" : "failed",
        timestamp: new Date(startedAt).toISOString(),
        ...(summary.skipped ? {} : { reduction: summary }),
        ...(usage === undefined ? {} : {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          uncachedInputTokens: usage.uncachedInputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheWriteInputTokens: usage.cacheWriteInputTokens,
          ...(usage.cacheWrite5mInputTokens === undefined ? {} : {
            cacheWrite5mInputTokens: usage.cacheWrite5mInputTokens,
            cacheWrite1hInputTokens: usage.cacheWrite1hInputTokens ?? 0,
          }),
        }),
        ...(tier === undefined ? {} : { responseServiceTier: tier }),
        ...(outputDiagnostics === undefined ? {} : { outputDiagnostics }),
        ...(duplicateOfRequestId === undefined ? {} : { duplicateOfRequestId }),
      };
      ledgerFor(applicationId, surface.provider).emit(event);

      // Blind learning stream: features of the ORIGINAL request (what the
      // customer actually sent), reduced to irreversible keyed hashes + counts.
      // No prompt content is ever written. Inside this try/catch, so a features
      // failure is as harmless to the request as a ledger failure.
      if (blindFeaturesKey !== undefined) {
        const features = extractBlindFeatures(body, { hmacKey: blindFeaturesKey });
        writeBlindFeatures(applicationId, surface.provider, {
          requestId,
          applicationId,
          timestamp: event.timestamp,
          features,
        });
      }
      writeCapturedRequest(body);
    } catch {
      // The meter must never affect the request path.
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "MESH proxy internal error." }));
      } else {
        res.end();
      }
    });
  });
  // Bound concurrency: each in-flight request may buffer up to the 64MB body
  // cap, so cap simultaneous connections to keep worst-case memory bounded.
  server.maxConnections = 256;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port ?? 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done, fail) =>
          server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
