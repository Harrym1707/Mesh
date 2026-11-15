import { createServer } from "node:http";
import { dashboardHtml } from "./dashboard.js";
import { buildContext } from "./context.js";
import { createApiRouter } from "./routes.js";

type TelemetryEvent = {
  requestId: string;
  applicationId: string;
  provider: string;
  model: string;
  requestedModel?: string;
  taskClass?: string;
  workflow?: string;
  difficulty?: "low" | "medium" | "high";
  riskLevel?: "low" | "medium" | "high";
  contextProfileId?: string;
  contextProfileVersion?: string;
  routePolicyId?: string;
  routeReason?: string;
  modelsAttempted?: string[];
  fallbackUsed?: boolean;
  fallbackReason?: string;
  qualityCheckPassed?: boolean;
  cacheHit?: boolean;
  tokensAvoided?: number;
  costAvoidedUsd?: number;
  inputTokens?: number;
  uncachedInputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs: number;
  status: "succeeded" | "failed";
  error?: string;
  timestamp: string;
};

const port = Number(process.env.PORT ?? 18787);
const maxBodyBytes = 64 * 1024;
const maxEvents = 500;
const events: TelemetryEvent[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function normaliseEvent(value: unknown): TelemetryEvent | undefined {
  if (!isRecord(value)) return undefined;
  const requiredStrings = ["requestId", "applicationId", "provider", "model"] as const;
  if (requiredStrings.some((key) => typeof value[key] !== "string" || value[key] === "")) return undefined;
  if (value.status !== "succeeded" && value.status !== "failed") return undefined;
  if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) return undefined;
  if (typeof value.latencyMs !== "number" || !Number.isFinite(value.latencyMs) || value.latencyMs < 0) return undefined;
  if (!isOptionalCount(value.inputTokens) || !isOptionalCount(value.uncachedInputTokens) ||
      !isOptionalCount(value.cachedInputTokens) || !isOptionalCount(value.cacheWriteInputTokens) ||
      !isOptionalCount(value.outputTokens) || !isOptionalCount(value.costUsd)) return undefined;
  if (value.taskClass !== undefined && typeof value.taskClass !== "string") return undefined;
  if (value.workflow !== undefined && typeof value.workflow !== "string") return undefined;
  if (value.difficulty !== undefined && !["low", "medium", "high"].includes(String(value.difficulty))) return undefined;
  if (value.riskLevel !== undefined && !["low", "medium", "high"].includes(String(value.riskLevel))) return undefined;
  if (value.contextProfileId !== undefined && typeof value.contextProfileId !== "string") return undefined;
  if (value.contextProfileVersion !== undefined && typeof value.contextProfileVersion !== "string") return undefined;
  if (value.error !== undefined && typeof value.error !== "string") return undefined;
  if (value.requestedModel !== undefined && typeof value.requestedModel !== "string") return undefined;
  if (value.routePolicyId !== undefined && typeof value.routePolicyId !== "string") return undefined;
  if (value.routeReason !== undefined && typeof value.routeReason !== "string") return undefined;
  if (value.modelsAttempted !== undefined &&
      (!Array.isArray(value.modelsAttempted) || value.modelsAttempted.some((model) => typeof model !== "string"))) return undefined;
  if (value.fallbackUsed !== undefined && typeof value.fallbackUsed !== "boolean") return undefined;
  if (value.fallbackReason !== undefined && typeof value.fallbackReason !== "string") return undefined;
  if (value.qualityCheckPassed !== undefined && typeof value.qualityCheckPassed !== "boolean") return undefined;
  if (value.cacheHit !== undefined && typeof value.cacheHit !== "boolean") return undefined;
  if (!isOptionalCount(value.tokensAvoided) || !isOptionalCount(value.costAvoidedUsd)) return undefined;

  return {
    requestId: value.requestId as string,
    applicationId: value.applicationId as string,
    provider: value.provider as string,
    model: value.model as string,
    requestedModel: value.requestedModel as string | undefined,
    taskClass: value.taskClass as string | undefined,
    workflow: value.workflow as string | undefined,
    difficulty: value.difficulty as TelemetryEvent["difficulty"],
    riskLevel: value.riskLevel as TelemetryEvent["riskLevel"],
    contextProfileId: value.contextProfileId as string | undefined,
    contextProfileVersion: value.contextProfileVersion as string | undefined,
    routePolicyId: value.routePolicyId as string | undefined,
    routeReason: value.routeReason as string | undefined,
    modelsAttempted: value.modelsAttempted as string[] | undefined,
    fallbackUsed: value.fallbackUsed as boolean | undefined,
    fallbackReason: value.fallbackReason as string | undefined,
    qualityCheckPassed: value.qualityCheckPassed as boolean | undefined,
    cacheHit: value.cacheHit as boolean | undefined,
    tokensAvoided: value.tokensAvoided as number | undefined,
    costAvoidedUsd: value.costAvoidedUsd as number | undefined,
    inputTokens: value.inputTokens as number | undefined,
    uncachedInputTokens: value.uncachedInputTokens as number | undefined,
    cachedInputTokens: value.cachedInputTokens as number | undefined,
    cacheWriteInputTokens: value.cacheWriteInputTokens as number | undefined,
    outputTokens: value.outputTokens as number | undefined,
    costUsd: value.costUsd as number | undefined,
    latencyMs: value.latencyMs,
    status: value.status,
    error: typeof value.error === "string" && value.error.length > 0 ? "provider_error" : undefined,
    timestamp: value.timestamp,
  };
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

const context = buildContext();
const apiRouter = createApiRouter(context);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  // The self-serve API (signup, accounts, metering, payment, admin) handles its
  // own routes first; telemetry and the dashboard below handle the rest.
  if (await apiRouter.handle(req, res, url)) return;

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "mesh-api" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(dashboardHtml);
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/telemetry") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 100;
    sendJson(res, 200, events.slice(0, limit));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/telemetry") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBodyBytes) {
        req.resume();
        sendJson(res, 413, { error: "telemetry_event_too_large" });
        return;
      }
      chunks.push(buffer);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }

    const event = normaliseEvent(parsed);
    if (!event) {
      sendJson(res, 400, { error: "invalid_telemetry_event" });
      return;
    }

    events.unshift(event);
    if (events.length > maxEvents) events.length = maxEvents;
    sendJson(res, 202, { accepted: true });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MESH local dashboard: http://127.0.0.1:${port}`);
});
