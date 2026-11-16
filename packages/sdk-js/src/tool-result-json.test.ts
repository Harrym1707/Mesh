import { describe, expect, it } from "vitest";
import { reduceRequest, type MeshTokenReductionConfig } from "./reduce-request.js";
import { defaultPolicy, policyCoverage, policyToReductionConfig, type TheoPolicy } from "./theo-policy.js";

/**
 * The opt-in `toolResultJson` lever: JSON tool results lose their layout
 * whitespace and nothing else.
 */

const AT = "2026-11-16T00:00:00.000Z";
const ON: MeshTokenReductionConfig = { toolResultJson: true };
const LEVER = "tool-result-json-compaction";

const PULLS = [
  { number: 46, title: "lab: agent tasks", user: { login: "someone", id: 12345678901234567890 }, draft: false },
  { number: 47, title: "fix: keep  lexemes", user: { login: "someone", id: 12345678901234567890 }, draft: true },
];
/** What a tool or MCP server typically returns: indented JSON. */
const PRETTY = `${JSON.stringify(PULLS, null, 2).replaceAll("12345678901234567000", "12345678901234567890")}\n`;
const COMPACT = '[{"number":46,"title":"lab: agent tasks","user":{"login":"someone","id":12345678901234567890},"draft":false},' +
  '{"number":47,"title":"fix: keep  lexemes","user":{"login":"someone","id":12345678901234567890},"draft":true}]';

const NUMBERED_READ = '     1\t{\n     2\t  "name": "mesh",\n     3\t  "private": true\n     4\t}';
const LOG = "$ pnpm test\n\n Test Files  67 passed (67)\n      Tests  987 passed (987)\n";

type Message = Record<string, unknown>;

function anthropicTurn(id: string, question: string, result: unknown): Message[] {
  return [
    { role: "user", content: question },
    { role: "assistant", content: [{ type: "tool_use", id, name: "list_pulls", input: { state: "open" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] },
    { role: "assistant", content: `Here is a summary. For reference the shape was {\n  "number": 46\n}` },
  ];
}

function anthropicRequest(messages: Message[]): Record<string, unknown> {
  return {
    model: "claude-sonnet-5-5",
    max_tokens: 1024,
    system: 'Answer from the tool output. Example shape:\n{\n  "number": 1\n}',
    messages,
  };
}

function messagesOf(request: unknown): Message[] {
  return (request as { messages: Message[] }).messages;
}

function toolResultOf(message: Message): Record<string, unknown> {
  return (message.content as Record<string, unknown>[])[0]!;
}

describe("toolResultJson", () => {
  it("the fixture really holds a 20-digit id (JSON.stringify alone would have rounded it)", () => {
    expect(PRETTY).toContain("12345678901234567890");
    expect(PRETTY).toContain("\n    \"number\": 46,");
  });

  it("is off unless asked for", () => {
    const request = anthropicRequest(anthropicTurn("toolu_1", "Which pull requests are open?", PRETTY));
    for (const config of [{}, { toolSchemas: true, duplicateContext: true, repairCachePrefix: true }, { toolResultJson: false }]) {
      const { request: reduced, summary } = reduceRequest(request, config);
      expect(toolResultOf(messagesOf(reduced)[2]!).content).toBe(PRETTY);
      expect(summary.changes.some((change) => change.lever === LEVER)).toBe(false);
    }
    expect(policyToReductionConfig(defaultPolicy("u", AT)).toolResultJson).toBeUndefined();
  });

  it("compacts an Anthropic tool_result and reports it as lossless", () => {
    const request = anthropicRequest(anthropicTurn("toolu_1", "Which pull requests are open?", PRETTY));
    const { request: reduced, summary } = reduceRequest(request, ON);
    const result = toolResultOf(messagesOf(reduced)[2]!);
    expect(result.content).toBe(COMPACT);
    expect(JSON.stringify(JSON.parse(result.content as string))).toBe(JSON.stringify(JSON.parse(PRETTY)));
    expect(result.tool_use_id).toBe("toolu_1");

    const change = summary.changes.find((entry) => entry.lever === LEVER)!;
    expect(change.lossless).toBe(true);
    expect(change.estimatedTokensSaved).toBeGreaterThan(0);
    expect(summary.estimatedLosslessTokensSaved).toBe(change.estimatedTokensSaved);
    expect(summary.estimatedTokensAfter).toBeLessThan(summary.estimatedTokensBefore);
    expect(summary.skipped).toBe(false);
  });

  it("touches tool output only: user text, system text and the model's own turns stay byte-identical", () => {
    const prettyQuestion = `Is this right?\n{\n  "a": 1\n}`;
    const jsonQuestion = '{\n  "typed by": "the user"\n}';
    const request = anthropicRequest([
      ...anthropicTurn("toolu_1", prettyQuestion, PRETTY),
      { role: "user", content: jsonQuestion },
      { role: "user", content: [{ type: "text", text: jsonQuestion }] },
      { role: "assistant", content: jsonQuestion },
    ]);
    const { request: reduced } = reduceRequest(request, ON);
    const before = messagesOf(request);
    const after = messagesOf(reduced);
    expect((reduced as { system: string }).system).toBe(request.system);
    for (const index of [0, 1, 3, 4, 5, 6]) expect(after[index]).toEqual(before[index]);
    expect(toolResultOf(after[2]!).content).toBe(COMPACT);
  });

  it("handles block-array results, and keeps images, cache_control and is_error as they were", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const request = anthropicRequest([
      { role: "user", content: "Check both." },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "a", input: {} },
          { type: "tool_use", id: "toolu_2", name: "b", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: PRETTY }, image, { type: "text", text: LOG }],
            cache_control: { type: "ephemeral" },
          },
          { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: '{\n  "error": "not found"\n}' },
          { type: "text", text: '{\n  "user": "text beside the results"\n}' },
        ],
      },
    ]);
    const { request: reduced } = reduceRequest(request, ON);
    const blocks = messagesOf(reduced)[2]!.content as Record<string, unknown>[];
    expect(blocks[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: [{ type: "text", text: COMPACT }, image, { type: "text", text: LOG }],
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[1]).toEqual({ type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: '{"error":"not found"}' });
    expect(blocks[2]).toEqual({ type: "text", text: '{\n  "user": "text beside the results"\n}' });
  });

  it("handles Chat Completions tool messages and Responses function_call_output items", () => {
    const chat = {
      model: "gpt-5",
      messages: [
        { role: "user", content: "Which pull requests are open?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "list", arguments: '{ "state": "open" }' } }] },
        { role: "tool", tool_call_id: "call_1", content: PRETTY },
        { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: PRETTY }] },
      ],
    };
    const chatReduced = messagesOf(reduceRequest(chat, ON).request);
    expect(chatReduced[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: COMPACT });
    expect(chatReduced[3]).toEqual({ role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: COMPACT }] });
    // The model's own tool-call arguments are its words, not tool output.
    expect(chatReduced[1]).toEqual(chat.messages[1]);

    const responses = {
      model: "gpt-5",
      input: [
        { role: "user", content: "Which pull requests are open?" },
        { type: "function_call", call_id: "call_1", name: "list", arguments: '{ "state": "open" }' },
        { type: "function_call_output", call_id: "call_1", output: PRETTY },
      ],
    };
    const { request: reduced, summary } = reduceRequest(responses, ON);
    const input = (reduced as { input: Message[] }).input;
    expect(input[2]).toEqual({ type: "function_call_output", call_id: "call_1", output: COMPACT });
    expect(input[1]).toEqual(responses.input[1]);
    expect(summary.changes.filter((change) => change.lever === LEVER)).toHaveLength(1);
  });

  it("leaves results that are not one whole JSON document byte-identical, and returns the request itself", () => {
    const others = [
      NUMBERED_READ,
      LOG,
      `Found 2 pull requests:\n${PRETTY}`,
      `${PRETTY}(truncated)`,
      '{"a":1}\n{"b":2}\n',
      COMPACT,
      '{ "trailing": 1, }',
      "",
    ];
    for (const result of others) {
      const request = anthropicRequest(anthropicTurn("toolu_1", "What is there?", result));
      const { request: reduced, summary } = reduceRequest(request, ON);
      expect(reduced).toBe(request);
      expect(summary.changes).toEqual([]);
    }
  });

  it("gives the same bytes every time, so a growing conversation keeps its earlier turns identical", () => {
    const turns = [
      anthropicTurn("toolu_1", "Which pull requests are open?", PRETTY),
      anthropicTurn("toolu_2", "And the package file?", NUMBERED_READ),
      anthropicTurn("toolu_3", "And the checks?", JSON.stringify({ total_count: 2, check_runs: [{ name: "test", conclusion: "success" }] }, null, 4)),
      anthropicTurn("toolu_4", "Did the tests pass?", LOG),
    ];
    let previous: string[] = [];
    for (let count = 1; count <= turns.length; count += 1) {
      const request = anthropicRequest(turns.slice(0, count).flat());
      const first = reduceRequest(request, ON).request;
      const second = reduceRequest(request, ON).request;
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      // Reducing what was already reduced changes nothing.
      expect(reduceRequest(first, ON).request).toBe(first);

      const serialised = messagesOf(first).map((message) => JSON.stringify(message));
      expect(serialised.slice(0, previous.length)).toEqual(previous);
      previous = serialised;
    }
  });

  it("stays byte-stable together with the fresh-result cap and history compaction", () => {
    const big = JSON.stringify(
      Array.from({ length: 80 }, (_, index) => ({ id: index, path: `src/module-${index}.ts`, status: "modified", note: "No issues found." })),
      null,
      2,
    );
    const turns = Array.from({ length: 8 }, (_, index) => anthropicTurn(`toolu_${index}`, `Step ${index}?`, index % 2 === 0 ? big : PRETTY));
    const config: MeshTokenReductionConfig = { toolResultJson: true, freshToolResultCap: true, historyCompaction: true };
    let previous: string[] = [];
    for (let count = 1; count <= turns.length; count += 1) {
      const request = anthropicRequest(turns.slice(0, count).flat());
      const reduced = reduceRequest(request, config);
      expect(reduced.summary.skipped).toBe(false);
      expect(JSON.stringify(reduceRequest(request, config).request)).toBe(JSON.stringify(reduced.request));
      previous = messagesOf(reduced.request).map((message) => JSON.stringify(message));
    }
    expect(previous.length).toBe(turns.length * 4);
  });

  it("never makes a request longer and never breaks one", () => {
    const awkward: unknown[] = [
      null,
      "a string",
      { model: "claude-sonnet-5-5", messages: "not an array" },
      { model: "claude-sonnet-5-5", messages: [null, 7, { role: "user" }, { role: "user", content: [null, { type: "tool_result" }] }] },
      { model: "gpt-5", input: [{ type: "function_call_output", output: 12 }, { role: "tool" }, { role: "tool", content: null }] },
    ];
    for (const request of awkward) {
      const { request: reduced } = reduceRequest(request, ON);
      expect(reduced).toBe(request);
    }
    const request = anthropicRequest(anthropicTurn("toolu_1", "Which pull requests are open?", PRETTY));
    const { request: reduced } = reduceRequest(request, ON);
    expect(JSON.stringify(reduced).length).toBeLessThan(JSON.stringify(request).length);
  });
});

describe("toolResultJson in Theo's policy", () => {
  it("is enforceable from a policy file, and is not in the default policy", () => {
    const base = defaultPolicy("u", AT);
    expect(base.levers.some((lever) => lever.lever === LEVER)).toBe(false);
    const stand = policyCoverage(base).stands.find((entry) => entry.lever === LEVER)!;
    expect(stand.state).toBe("available");

    const opted: TheoPolicy = { ...base, levers: [...base.levers, { lever: LEVER, class: "lossless" }] };
    expect(policyToReductionConfig(opted).toolResultJson).toBe(true);
    expect(policyCoverage(opted).stands.find((entry) => entry.lever === LEVER)!.state).toBe("active");

    // Listed as lossy with no proof, it is withheld like any other lossy lever.
    const unproven: TheoPolicy = { ...base, levers: [...base.levers, { lever: LEVER, class: "lossy" }] };
    expect(policyToReductionConfig(unproven).toolResultJson).toBeUndefined();
  });
});
