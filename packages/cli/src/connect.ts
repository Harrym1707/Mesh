/**
 * `mesh connect` — how a client on this machine reaches MESH.
 *
 * Prints the proxy's base URLs for Anthropic-style and OpenAI-style clients,
 * the health URL, whether the proxy is answering right now, and the one
 * setting each kind of client needs. It is the banner of `mesh proxy` without
 * starting anything: a coding agent runs it to learn what to set, on a
 * machine where MESH is already running or about to be.
 *
 * It reads no API key, prints none and needs none: a client keeps its own key
 * and MESH passes it straight through. It changes nothing: no settings file,
 * no ledger, no service. One local health request; no other network call.
 */
import { meshIdentity, parseFlags, parsePortFlag, writeJson, type MeshIdentity } from "./json-output.js";
import { DEFAULT_PORT, probeProxy, proxyUrls, resolvePort, type PortSource } from "./machine.js";

export type ConnectClient = {
  /** Stable id for the kind of client. */
  id: "claude-code" | "anthropic" | "openai" | "openai-compatible" | "framework";
  name: string;
  /** Which API shape it speaks, and so which base URL it takes. */
  api: "anthropic" | "openai" | "either";
  /** Environment variables to set, when the client reads one. */
  env: Record<string, string>;
  /** The one thing to do, as a sentence. */
  instruction: string;
};

export type ConnectResult = {
  schema: "mesh-connect/1";
  ok: true;
  mesh: MeshIdentity;
  proxy: {
    /** MESH answered its health check on `port` just now. */
    reachable: boolean;
    /** Something accepts connections on `port` (MESH or another program). */
    portOpen: boolean;
    port: number;
    portSource: PortSource;
  };
  baseUrls: { anthropic: string; openai: string };
  health: string;
  /** What to run when `proxy.reachable` is false. */
  startCommand: string;
  clients: ConnectClient[];
  /** MESH never needs the provider key: the client keeps it and MESH passes it through. */
  apiKeys: string;
};

export type ConnectOptions = {
  /** Describe the proxy on this port instead of the configured one. */
  port?: number;
  wiringStatePath?: string;
  plistPath?: string;
};

/**
 * `mesh connect` as data. Returns; never prints and never exits. Reads no key
 * and changes nothing.
 */
export async function collectConnect(options: ConnectOptions = {}): Promise<ConnectResult> {
  const { port, source } = resolvePort(options.port, {
    ...(options.plistPath === undefined ? {} : { plistPath: options.plistPath }),
    ...(options.wiringStatePath === undefined ? {} : { wiringStatePath: options.wiringStatePath }),
  });
  const probe = await probeProxy(port);
  const urls = proxyUrls(port);
  const portFlag = port === DEFAULT_PORT ? "" : ` --port ${port}`;
  return {
    schema: "mesh-connect/1",
    ok: true,
    mesh: meshIdentity(),
    proxy: { reachable: probe.isMesh, portOpen: probe.portOpen, port, portSource: source },
    baseUrls: { anthropic: urls.anthropic, openai: urls.openai },
    health: urls.health,
    startCommand: `mesh proxy${portFlag}`,
    clients: [
      {
        id: "claude-code",
        name: "Claude Code",
        api: "anthropic",
        env: { ANTHROPIC_BASE_URL: urls.anthropic },
        instruction:
          `Run \`mesh start${portFlag}\` in its own terminal: it sets ANTHROPIC_BASE_URL in ~/.claude/settings.json ` +
          "and puts it back on exit. Then open a new Claude Code session.",
      },
      {
        id: "anthropic",
        name: "Anthropic SDK or any Anthropic-style client",
        api: "anthropic",
        env: { ANTHROPIC_BASE_URL: urls.anthropic },
        instruction: `Set ANTHROPIC_BASE_URL=${urls.anthropic} in the environment of your app.`,
      },
      {
        id: "openai",
        name: "OpenAI SDK or any OpenAI-style client",
        api: "openai",
        env: { OPENAI_BASE_URL: urls.openai },
        instruction: `Set OPENAI_BASE_URL=${urls.openai} in the environment of your app.`,
      },
      {
        id: "openai-compatible",
        name: "A provider other than OpenAI behind the OpenAI-style API",
        api: "openai",
        env: { OPENAI_BASE_URL: urls.openai },
        instruction:
          `Start MESH with the provider's address (mesh proxy${portFlag} --openai-base https://your-provider.example), ` +
          `then set OPENAI_BASE_URL=${urls.openai} in the environment of your app.`,
      },
      {
        id: "framework",
        name: "A framework that takes the base URL in code or config (LangChain, the Vercel AI SDK, LiteLLM and most others)",
        api: "either",
        env: {},
        instruction:
          `Put the same address where the framework takes its base URL: ${urls.anthropic} for Anthropic-style calls, ` +
          `${urls.openai} for OpenAI-style calls.`,
      },
    ],
    apiKeys:
      "Keep your own API key in your client, exactly as now. MESH passes it straight through to your provider; " +
      "this command does not read it, print it or need it.",
  };
}

const USAGE = `Usage: mesh connect [options]

How a client on this machine reaches MESH: the base URLs to set, the health
URL, and whether the proxy is answering right now. Reads no API key and
changes nothing.

  --port <n>   Describe the proxy on this port. Default: the installed
               service's port, else a running \`mesh start\`, else ${DEFAULT_PORT}.
  --json       Print one JSON object (schema mesh-connect/1) instead of text.
  --help       Show this message.

Exits 0 whether or not the proxy is running: that is reported, not failed.`;

/** The text form: the same facts `mesh proxy` prints in its banner. */
export function renderConnect(result: ConnectResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  mesh connect — how a client on this machine reaches MESH`);
  lines.push("");
  lines.push(
    result.proxy.reachable
      ? `  proxy    answering on port ${result.proxy.port}`
      : result.proxy.portOpen
        ? `  proxy    NOT MESH: another program is answering on port ${result.proxy.port}. Start MESH on a free port: mesh proxy --port <n>`
        : `  proxy    not running on port ${result.proxy.port}. Start it with: ${result.startCommand}`,
  );
  lines.push(`  health   ${result.health}`);
  lines.push("");
  lines.push(`  connect  Anthropic clients   ANTHROPIC_BASE_URL=${result.baseUrls.anthropic}`);
  lines.push(`           OpenAI-style        OPENAI_BASE_URL=${result.baseUrls.openai}`);
  lines.push("");
  for (const client of result.clients) {
    lines.push(`  ${client.name}`);
    lines.push(`    ${client.instruction}`);
  }
  lines.push("");
  lines.push(`  ${result.apiKeys}`);
  lines.push("");
  return lines.join("\n");
}

export async function runConnect(argv: string[]): Promise<void> {
  const { values, flags } = parseFlags("connect", argv, { valueFlags: ["--port"] });
  if (flags.has("--help")) { console.log(USAGE); return; }
  const port = parsePortFlag(values["--port"]);
  const result = await collectConnect(port === undefined ? {} : { port });
  if (flags.has("--json")) { writeJson(result); return; }
  console.log(renderConnect(result));
}
