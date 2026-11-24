/**
 * The flow detector: one test per state, over hand-built status objects and
 * an injected clock. Pure, so nothing here touches a disk, a port or the
 * real ~/.mesh.
 */
import { describe, expect, it } from "vitest";
import { IDLE_AFTER_DAYS, detectFlow, flowLines, timeAgo, type FlowInput, type FlowState } from "./flow.js";

const NOW = new Date("2026-11-23T15:00:00.000Z");
const ZONE = "UTC";

type Overrides = {
  service?: Partial<FlowInput["service"]>;
  proxy?: Partial<FlowInput["proxy"]>;
  claudeCode?: Partial<FlowInput["claudeCode"]>;
  callerEnvironment?: Partial<FlowInput["callerEnvironment"]>;
  ledger?: Partial<FlowInput["ledger"]>;
};

/** The founder's machine on 2026-11-23: installed, never connected. */
function statusOf(overrides: Overrides = {}): FlowInput {
  return {
    schema: "mesh-status/1",
    ok: true,
    mesh: { version: "0.0.0", build: "test" },
    runtime: { cached: true, cachedVersion: "abc1234", launcherInstalled: true, runningFromCache: true },
    service: { supported: true, installed: false, manager: "launchd", ...overrides.service },
    proxy: {
      reachable: false,
      portOpen: false,
      port: 8787,
      portSource: "default",
      baseUrls: { anthropic: "http://127.0.0.1:8787", openai: "http://127.0.0.1:8787/v1" },
      health: "http://127.0.0.1:8787/mesh/health",
      ...overrides.proxy,
    },
    claudeCode: {
      state: "not_pointed",
      pointedAtMesh: false,
      port: null,
      startSessionRunning: false,
      detectedBy: "test",
      ...overrides.claudeCode,
    },
    callerEnvironment: { anthropicBaseUrlPointsAtMesh: false, openaiBaseUrlPointsAtMesh: false, ...overrides.callerEnvironment },
    ledger: {
      path: "/home/someone/.mesh/ledger",
      empty: true,
      requests: 0,
      firstRequestAt: null,
      lastRequestAt: null,
      chainVerified: true,
      ...overrides.ledger,
    },
    currency: "USD",
    savings: { netVerifiedUsd: 0, netVerifiedCents: 0, hasVerifiedSavings: false },
    bill: { scope: "all_periods", feePercent: 1, verdict: "do_not_charge", feeCents: 0, feeUsd: 0 },
    coverage: { enforceableLevers: 13, active: 3, held: 0, available: 10, activePercent: 23, levers: [] },
    theo: { hasRun: false, mode: "unknown", pendingProposals: 0 },
  };
}

const up = { reachable: true, portOpen: true };
const pointed = { state: "pointed_at_mesh" as const, pointedAtMesh: true, port: 8787 };
const seen = (lastRequestAt: string, requests = 42): Overrides["ledger"] => ({
  empty: false,
  requests,
  firstRequestAt: "2026-11-01T09:00:00.000Z",
  lastRequestAt,
});
const flow = (overrides: Overrides = {}): ReturnType<typeof detectFlow> => detectFlow(statusOf(overrides), NOW, ZONE);

describe("timeAgo", () => {
  const at = (iso: string): number => Date.parse(iso);
  const now = NOW.getTime();
  it("says it as a person would", () => {
    expect(timeAgo(at("2026-11-23T14:59:30Z"), now, ZONE)).toBe("less than a minute ago");
    expect(timeAgo(at("2026-11-23T14:59:00Z"), now, ZONE)).toBe("1 minute ago");
    expect(timeAgo(at("2026-11-23T14:58:00Z"), now, ZONE)).toBe("2 minutes ago");
    expect(timeAgo(at("2026-11-23T12:00:00Z"), now, ZONE)).toBe("3 hours ago");
    expect(timeAgo(at("2026-11-22T10:00:00Z"), now, ZONE)).toBe("yesterday");
    expect(timeAgo(at("2026-11-19T10:00:00Z"), now, ZONE)).toBe("4 days ago");
  });
  it("counts days by the calendar in the given zone, and a late-evening request as hours", () => {
    // 23:00 the evening before, read at 03:00: four hours, not "yesterday".
    expect(timeAgo(at("2026-11-22T23:00:00Z"), at("2026-11-23T03:00:00Z"), ZONE)).toBe("4 hours ago");
    // 13 hours ago and the same calendar day in Los Angeles, though the UTC date differs.
    expect(timeAgo(at("2026-11-23T08:30:00Z"), at("2026-11-23T21:30:00Z"), "America/Los_Angeles")).toBe("13 hours ago");
    expect(timeAgo(at("2026-11-22T20:00:00Z"), at("2026-11-23T21:30:00Z"), "America/Los_Angeles")).toBe("yesterday");
  });
  it("reads a time in the future as just now", () => {
    expect(timeAgo(now + 60_000, now, ZONE)).toBe("less than a minute ago");
  });
});

describe("detectFlow: one state for every machine", () => {
  it("not_set_up: installed, never connected (the founder's own machine)", () => {
    const result = flow();
    expect(result.state).toBe("not_set_up");
    expect(result.headline).toBe("Mesh is installed but not connected, so it has seen nothing and saved nothing.");
    expect(result.fix).toBe("mesh setup");
    expect(result.detail).toContain("Installing Mesh does not connect it");
    expect(flowLines(result)).toEqual([result.headline, "Fix: mesh setup"]);
  });

  it("flowing: says when the last request was, and asks for nothing", () => {
    const minutes = flow({ proxy: up, claudeCode: pointed, ledger: seen("2026-11-23T14:58:00.000Z") });
    expect(minutes.state).toBe("flowing");
    expect(minutes.headline).toBe("Mesh is working: the last request went through it 2 minutes ago.");
    expect(minutes.fix).toBeNull();
    expect(minutes.detail).toContain("42 requests recorded");
    expect(flowLines(minutes)).toEqual([minutes.headline]);
    const yesterday = flow({ proxy: up, claudeCode: pointed, ledger: seen("2026-11-22T10:00:00.000Z") });
    expect(yesterday.headline).toBe("Mesh is working: the last request went through it yesterday.");
  });

  it("flowing from the user's own app: Claude Code is not mentioned as a problem", () => {
    for (const state of ["not_pointed", "pointed_elsewhere", "settings_invalid"] as const) {
      const result = flow({
        proxy: up,
        claudeCode: { state, pointedAtMesh: state === "settings_invalid" ? "unknown" : false },
        ledger: seen("2026-11-23T14:00:00.000Z", 1),
      });
      expect(result.state).toBe("flowing");
      expect(result.fix).toBeNull();
      expect(result.headline).not.toContain("Claude Code");
      expect(result.detail).toContain("1 request recorded");
      expect(result.detail).toContain("an app pointed at Mesh");
      expect(result.detail).not.toContain("not pointed");
    }
  });

  it("proxy_down_client_pointed: says Claude Code's requests are FAILING and how to point it back", () => {
    const result = flow({ claudeCode: { state: "pointed_at_stopped_proxy", port: 8787 } });
    expect(result.state).toBe("proxy_down_client_pointed");
    expect(result.headline).toContain("FAILING");
    expect(result.headline).toContain("Mesh is not running");
    expect(result.fix).toBe("mesh restore");
    expect(result.detail).toContain("mesh setup");
    // With the service installed, the fix is to bring the service back.
    const service = flow({ service: { installed: true }, claudeCode: { state: "pointed_at_stopped_proxy", port: 8787 } });
    expect(service.state).toBe("proxy_down_client_pointed");
    expect(service.headline).toContain("FAILING");
    expect(service.fix).toBe("mesh install");
    expect(service.detail).toContain("mesh uninstall");
    // It outranks everything, a ledger that does not verify included.
    const both = flow({ claudeCode: { state: "pointed_at_stopped_proxy", port: 8787 }, ledger: { ...seen("2026-11-23T14:00:00.000Z"), chainVerified: false } });
    expect(both.state).toBe("proxy_down_client_pointed");
  });

  it("proxy_down: the service is installed but the proxy does not answer", () => {
    const result = flow({ service: { installed: true } });
    expect(result.state).toBe("proxy_down");
    expect(result.headline).toBe("Mesh's background service is installed but not answering, so nothing is going through it.");
    expect(result.fix).toBe("mesh install");
    expect(result.detail).toContain("~/.mesh/daemon.log");
  });

  it("proxy_down: Mesh ran here before and is not running now", () => {
    const result = flow({ ledger: seen("2026-11-23T12:00:00.000Z") });
    expect(result.state).toBe("proxy_down");
    expect(result.headline).toBe("Mesh is not running, so nothing is going through it. The last request it saw was 3 hours ago.");
    expect(result.fix).toBe("mesh setup");
    // Where there is no always-on service, the command that runs it is mesh start.
    const linux = flow({ service: { supported: false, manager: null }, ledger: seen("2026-11-23T12:00:00.000Z") });
    expect(linux.state).toBe("proxy_down");
    expect(linux.fix).toBe("mesh start");
  });

  it("port_taken: another program answers on Mesh's port", () => {
    const result = flow({ proxy: { reachable: false, portOpen: true } });
    expect(result.state).toBe("port_taken");
    expect(result.headline).toContain("Another program is using port 8787");
    expect(result.fix).toBe("mesh setup --port 8788");
  });

  it("client_not_pointed: the proxy is up and nothing points at it", () => {
    const empty = flow({ proxy: up });
    expect(empty.state).toBe("client_not_pointed");
    expect(empty.headline).toBe("Mesh is running but has seen no requests: Claude Code is not pointed at it.");
    expect(empty.fix).toBe("mesh setup");
    expect(empty.detail).toContain("http://127.0.0.1:8787");
    expect(empty.detail).toContain("mesh connect");
    const stale = flow({ proxy: up, ledger: seen("2026-11-13T10:00:00.000Z") });
    expect(stale.state).toBe("client_not_pointed");
    expect(stale.headline).toContain(`no request for more than ${IDLE_AFTER_DAYS} days (the last was 10 days ago)`);
    expect(stale.fix).toBe("mesh setup");
  });

  it("pointed_elsewhere: says so, never prints the address, and offers no command that would replace it", () => {
    const result = flow({ proxy: up, claudeCode: { state: "pointed_elsewhere" } });
    expect(result.state).toBe("pointed_elsewhere");
    expect(result.headline).toBe("Claude Code is pointed at another address, not at Mesh, so Mesh sees none of its requests.");
    expect(result.fix).toBeNull();
    expect(result.detail).toContain("will not replace it");
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });

  it("connected_idle: connected, no request yet", () => {
    const result = flow({ proxy: up, claudeCode: pointed });
    expect(result.state).toBe("connected_idle");
    expect(result.headline).toBe("Mesh is connected but has not seen a request yet.");
    expect(result.detail).toContain("Open a new Claude Code session; your next message goes through Mesh.");
    expect(result.fix).toBeNull();
    // A terminal whose own base URL points at Mesh counts as pointed, with no Claude Code involved.
    const terminal = flow({ proxy: up, callerEnvironment: { openaiBaseUrlPointsAtMesh: true } });
    expect(terminal.state).toBe("connected_idle");
    expect(terminal.detail).toContain("this terminal's base URL points at it");
  });

  it(`connected_idle: connected, but nothing for more than ${IDLE_AFTER_DAYS} days, and the number is said`, () => {
    const result = flow({ proxy: up, claudeCode: pointed, ledger: seen("2026-11-18T10:00:00.000Z") });
    expect(result.state).toBe("connected_idle");
    expect(result.headline).toBe(`Mesh is connected but has seen no request for more than ${IDLE_AFTER_DAYS} days (the last was 5 days ago).`);
    expect(result.detail).toContain("mesh doctor");
    expect(result.fix).toBeNull();
    // Just inside the limit it is still flowing.
    const inside = flow({ proxy: up, claudeCode: pointed, ledger: seen("2026-11-20T15:00:01.000Z") });
    expect(inside.state).toBe("flowing");
    const outside = flow({ proxy: up, claudeCode: pointed, ledger: seen("2026-11-20T14:59:59.000Z") });
    expect(outside.state).toBe("connected_idle");
  });

  it("ledger_not_verified: no figure, and the fix is mesh verify", () => {
    const result = flow({ proxy: up, claudeCode: pointed, ledger: { ...seen("2026-11-23T14:58:00.000Z"), chainVerified: false, brokenAt: { spool: 1, seq: 3 } } });
    expect(result.state).toBe("ledger_not_verified");
    expect(result.headline).toBe("Mesh's ledger did not pass its check, so there is no savings figure.");
    expect(result.fix).toBe("mesh verify");
    expect(result.detail).toContain("spool 1, record 3");
    expect(JSON.stringify(result)).not.toContain("$");
  });

  it("settings_invalid: Mesh will not touch a file it cannot read, and says what to do", () => {
    const down = flow({ claudeCode: { state: "settings_invalid", pointedAtMesh: "unknown" } });
    expect(down.state).toBe("settings_invalid");
    expect(down.headline).toContain("cannot be read");
    expect(down.headline).toContain("will not touch");
    expect(down.detail).toContain("~/.claude/settings.json is not valid JSON");
    expect(down.detail).toContain("then run mesh setup");
    expect(down.detail).toContain("Mesh is also not running");
    expect(down.fix).toBeNull();
    const running = flow({ proxy: up, claudeCode: { state: "settings_invalid", pointedAtMesh: "unknown" } });
    expect(running.state).toBe("settings_invalid");
    expect(running.detail).toContain("Mesh itself is running");
  });

  it("says what is not known instead of guessing", () => {
    // Requests are recorded, but none carries a readable time.
    const untimed = flow({ proxy: up, claudeCode: pointed, ledger: { empty: false, requests: 7, lastRequestAt: null } });
    expect(untimed.state).toBe("connected_idle");
    expect(untimed.headline).toBe("Mesh is connected, but when it last saw a request is not known.");
    const stopped = flow({ ledger: { empty: false, requests: 7, lastRequestAt: null } });
    expect(stopped.state).toBe("proxy_down");
    expect(stopped.detail).toContain("when the last one was is not known");
  });

  it("gives every state a headline that is one sentence, and a fix that is one mesh command or none", () => {
    const cases: Array<[FlowState, Overrides]> = [
      ["flowing", { proxy: up, claudeCode: pointed, ledger: seen("2026-11-23T14:58:00.000Z") }],
      ["connected_idle", { proxy: up, claudeCode: pointed }],
      ["not_set_up", {}],
      ["proxy_down_client_pointed", { claudeCode: { state: "pointed_at_stopped_proxy", port: 8787 } }],
      ["proxy_down", { service: { installed: true } }],
      ["port_taken", { proxy: { portOpen: true } }],
      ["client_not_pointed", { proxy: up }],
      ["pointed_elsewhere", { proxy: up, claudeCode: { state: "pointed_elsewhere" } }],
      ["ledger_not_verified", { ledger: { ...seen("2026-11-23T14:58:00.000Z"), chainVerified: false } }],
      ["settings_invalid", { claudeCode: { state: "settings_invalid", pointedAtMesh: "unknown" } }],
    ];
    for (const [state, overrides] of cases) {
      const result = flow(overrides);
      expect(result.state, state).toBe(state);
      expect(result.headline.endsWith("."), state).toBe(true);
      expect(result.headline.includes("\n"), state).toBe(false);
      expect(result.detail.length, state).toBeGreaterThan(0);
      if (result.fix !== null) expect(result.fix, state).toMatch(/^mesh [a-z]+( --port \d+)?$/);
    }
  });
});
