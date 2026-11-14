import { describe, expect, it } from "vitest";
import { auditToolCatalogue, minifyToolSchemas } from "./tool-schema.js";

function tool(name: string, description: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          accountId: {
            type: "string",
            title: "accountId",
            description: "The customer account identifier as shown in the admin console.",
          },
          limit: { type: "integer", title: "Maximum results", description: "Between 1 and 100." },
        },
        required: ["accountId"],
        ...extra,
      },
    },
  };
}

const LONG = "Look up a record set for an account. Use this when the customer asks about historical activity " +
  "in this subsystem. Returns a paginated list ordered by creation time descending. Do not call this more " +
  "than once per turn; prefer narrowing the query with filters over paging through results.";

describe("minifyToolSchemas", () => {
  it("keeps descriptions by default, so the default path is lossless", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)]);
    expect(result.lossyTokensSaved).toBe(0);
    expect(result.losslessTokensSaved).toBeGreaterThan(0);
    expect(JSON.stringify(result.tools)).toContain("paginated list");
  });

  it("removes schema plumbing the model never reads", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)]);
    expect(JSON.stringify(result.tools)).not.toContain("$schema");
    expect(result.changes.some((change) => change.kind === "plumbing" && change.lossless)).toBe(true);
  });

  it("removes a title that only restates its property name, and keeps one that does not", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)]);
    const serialised = JSON.stringify(result.tools);
    // accountId's title restated the key; limit's title carries information.
    expect(serialised).not.toContain('"title":"accountId"');
    expect(serialised).toContain("Maximum results");
  });

  it("never reports formatting or plumbing as lossy", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)]);
    for (const change of result.changes) {
      if (change.kind === "formatting" || change.kind === "plumbing" || change.kind === "redundant-title") {
        expect(change.lossless).toBe(true);
      }
    }
  });

  it("reports description trimming as lossy, because descriptions drive tool choice", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)], {
      descriptions: "truncate",
      maximumDescriptionTokens: 12,
    });
    const trims = result.changes.filter((change) => change.kind === "description");
    expect(trims.length).toBeGreaterThan(0);
    expect(trims.every((change) => change.lossless === false)).toBe(true);
    expect(result.lossyTokensSaved).toBeGreaterThan(0);
  });

  it("truncates on a sentence boundary where one fits", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)], {
      descriptions: "truncate",
      maximumDescriptionTokens: 16,
    });
    const serialised = JSON.stringify(result.tools);
    expect(serialised).toContain("Look up a record set for an account.");
    expect(serialised).not.toContain("paginated list");
  });

  it("drops descriptions entirely when asked, and says so", () => {
    const result = minifyToolSchemas([tool("lookup", LONG)], { descriptions: "drop" });
    expect(JSON.stringify(result.tools)).not.toContain("Look up a record set");
    expect(result.changes.some((change) =>
      change.kind === "description" && /chooses between tools/.test(change.detail))).toBe(true);
  });

  it("treats dropping a tool as lossy and names it", () => {
    const result = minifyToolSchemas([tool("keep", LONG), tool("discard", LONG)], { keepTools: ["keep"] });
    expect(result.tools).toHaveLength(1);
    const dropped = result.changes.find((change) => change.kind === "dropped-tool")!;
    expect(dropped.lossless).toBe(false);
    expect(dropped.at).toBe("discard");
    expect(dropped.detail).toMatch(/cannot call what it cannot see/);
  });

  it("only reduces tokens", () => {
    const tools = [tool("a", LONG), tool("b", LONG)];
    const result = minifyToolSchemas(tools, { descriptions: "truncate" });
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it("rejects a catalogue that is not an array, and a bad token limit", () => {
    expect(() => minifyToolSchemas({} as unknown as unknown[])).toThrow(/must be an array/);
    expect(() => minifyToolSchemas([], { maximumDescriptionTokens: 0 })).toThrow(/positive integer/);
  });

  it("handles an empty catalogue", () => {
    const result = minifyToolSchemas([]);
    expect(result.tools).toEqual([]);
    expect(result.lossyTokensSaved).toBe(0);
  });
});

/**
 * Shaped the way Pydantic v2's `model_json_schema()` actually emits a tool
 * whose parameters include a nested model — e.g. what LangChain's
 * `bind_tools`/MCP tool registration sends when a tool argument is itself a
 * BaseModel. `$ref` points into `$defs`; `additionalProperties: false` is
 * what strict-mode schemas require; the nested model's own `title` restates
 * its definition name, exactly as Pydantic auto-generates it.
 */
function pydanticToolWithNestedModel(name: string): unknown {
  return {
    type: "function",
    function: {
      name,
      description: "Create a support ticket for the named contact.",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          ContactInfo: {
            title: "ContactInfo",
            type: "object",
            additionalProperties: false,
            properties: {
              email: { type: "string", title: "Email" },
              phone: { type: "string", title: "Phone" },
            },
            required: ["email"],
          },
        },
        type: "object",
        additionalProperties: false,
        properties: {
          contact: { $ref: "#/$defs/ContactInfo" },
          priority: { type: "string", enum: ["low", "high"] },
        },
        required: ["contact"],
      },
    },
  };
}

describe("minifyToolSchemas — $defs / $ref (Pydantic-shaped schemas)", () => {
  it("keeps a $defs entry a $ref still points to, instead of corrupting the schema", () => {
    const result = minifyToolSchemas([pydanticToolWithNestedModel("open_ticket")]);
    const serialised = JSON.stringify(result.tools);
    // The regression this guards: $defs used to be unconditionally removed as
    // "plumbing", leaving `{"$ref":"#/$defs/ContactInfo"}` dangling — a
    // provider given that schema can no longer resolve what `contact` is.
    expect(serialised).toContain('"$ref":"#/$defs/ContactInfo"');
    expect(serialised).toContain('"ContactInfo"');
    expect(JSON.parse(serialised)[0].function.parameters.$defs.ContactInfo.properties.email).toBeDefined();
  });

  it("removes a $defs entry nothing refers to, and reports it as lossless", () => {
    const tool = pydanticToolWithNestedModel("open_ticket") as any;
    tool.function.parameters.$defs.Unused = { title: "Unused", type: "object", properties: {} };
    const result = minifyToolSchemas([tool]);
    const serialised = JSON.stringify(result.tools);
    expect(serialised).not.toContain("Unused");
    expect(serialised).toContain("ContactInfo"); // the live one survives
    const removed = result.changes.find((c) => c.kind === "unused-definition");
    expect(removed?.lossless).toBe(true);
    expect(removed?.at).toContain("Unused");
  });

  it("drops the whole $defs container once every entry in it is unreferenced", () => {
    const lean = [{
      type: "function",
      function: {
        name: "ping",
        parameters: {
          $defs: { Orphan: { type: "object", properties: {} } },
          type: "object",
          properties: { id: { type: "string" } },
        },
      },
    }];
    const result = minifyToolSchemas(lean);
    expect(JSON.stringify(result.tools)).not.toContain("$defs");
  });

  it("follows a transitive chain: a definition referenced only by another live definition survives", () => {
    const chained = [{
      type: "function",
      function: {
        name: "schedule",
        parameters: {
          $defs: {
            Appointment: {
              type: "object",
              properties: { location: { $ref: "#/$defs/Address" } },
            },
            Address: { type: "object", properties: { city: { type: "string" } } },
          },
          type: "object",
          properties: { appointment: { $ref: "#/$defs/Appointment" } },
        },
      },
    }];
    const result = minifyToolSchemas(chained);
    const serialised = JSON.stringify(result.tools);
    expect(serialised).toContain("Appointment");
    expect(serialised).toContain("Address"); // kept only via the transitive hop through Appointment
    expect(result.changes.some((c) => c.kind === "unused-definition")).toBe(false);
  });

  it("handles legacy draft-07 `definitions` the same way as `$defs`", () => {
    const draft07 = [{
      type: "function",
      function: {
        name: "legacy_tool",
        parameters: {
          definitions: {
            Live: { type: "object", properties: { x: { type: "string" } } },
            Dead: { type: "object", properties: { y: { type: "string" } } },
          },
          type: "object",
          properties: { v: { $ref: "#/definitions/Live" } },
        },
      },
    }];
    const result = minifyToolSchemas(draft07);
    const serialised = JSON.stringify(result.tools);
    expect(serialised).toContain("Live");
    expect(serialised).not.toContain("Dead");
  });

  it("still strips genuine plumbing ($schema) and redundant titles inside a kept $defs entry", () => {
    const tool = pydanticToolWithNestedModel("open_ticket") as any;
    tool.function.parameters.$defs.ContactInfo.$comment = "internal note";
    const result = minifyToolSchemas([tool]);
    const serialised = JSON.stringify(result.tools);
    expect(serialised).not.toContain("internal note");
    expect(serialised).not.toContain("$schema");
  });
});

describe("minifyToolSchemas — canonicalOrder", () => {
  it("leaves order untouched by default", () => {
    const result = minifyToolSchemas([tool("zebra", "Z."), tool("alpha", "A.")]);
    expect(result.tools.map((t: any) => t.function.name)).toEqual(["zebra", "alpha"]);
    expect(result.changes.some((c) => c.kind === "tool-order")).toBe(false);
  });

  it("sorts tools by name and records a zero-token cache-stability change when order moves", () => {
    const result = minifyToolSchemas([tool("zebra", "Z."), tool("alpha", "A.")], { canonicalOrder: true });
    expect(result.tools.map((t: any) => t.function.name)).toEqual(["alpha", "zebra"]);
    const reorder = result.changes.find((c) => c.kind === "tool-order");
    expect(reorder?.lossless).toBe(true);
    expect(reorder?.tokensSaved).toBe(0);
  });

  it("records no tool-order change when the input was already canonical", () => {
    const result = minifyToolSchemas([tool("alpha", "A."), tool("zebra", "Z.")], { canonicalOrder: true });
    expect(result.changes.some((c) => c.kind === "tool-order")).toBe(false);
  });

  it("makes two differently-ordered resends of the same catalogue serialize identically", () => {
    const a = minifyToolSchemas([tool("zebra", "Z."), tool("alpha", "A."), tool("mid", "M.")], { canonicalOrder: true });
    const b = minifyToolSchemas([tool("alpha", "A."), tool("mid", "M."), tool("zebra", "Z.")], { canonicalOrder: true });
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
  });
});

describe("auditToolCatalogue", () => {
  it("separates what is free from what needs verifying", () => {
    const audit = auditToolCatalogue([tool("a", LONG), tool("b", LONG), tool("c", LONG)]);
    expect(audit.tools).toBe(3);
    expect(audit.tokens).toBeGreaterThan(0);
    expect(audit.losslessTokensSaved).toBeGreaterThan(0);
    expect(audit.descriptionTokensSaved).toBeGreaterThan(0);
  });

  it("scales the description saving with how verbose the descriptions are", () => {
    // Which tier is larger depends on what the catalogue happens to contain:
    // the lossless tier is plumbing and indentation, the lossy tier is prose.
    // Asserting an ordering between them would test the fixture rather than the
    // code, so the invariant asserted is that the description saving tracks
    // description length while the lossless saving does not.
    const terse = auditToolCatalogue(Array.from({ length: 8 }, (_, i) => tool(`t${i}`, "Short.")));
    const verbose = auditToolCatalogue(Array.from({ length: 8 }, (_, i) => tool(`t${i}`, LONG)));
    expect(verbose.descriptionTokensSaved).toBeGreaterThan(terse.descriptionTokensSaved * 3);
    expect(verbose.losslessTokensSaved).toBeCloseTo(terse.losslessTokensSaved, -1);
  });

  it("credits an already-lean catalogue almost nothing for description trimming", () => {
    const lean = [{ type: "function", function: { name: "ping", parameters: { type: "object", properties: {} } } }];
    const audit = auditToolCatalogue(lean);
    expect(audit.descriptionTokensSaved).toBe(0);
  });

  it("ranks the largest tools first so a catalogue can be trimmed by hand", () => {
    const audit = auditToolCatalogue([
      tool("small", "Short."),
      tool("large", LONG),
    ]);
    expect(audit.largest[0]!.name).toBe("large");
    expect(audit.largest[0]!.descriptionTokens).toBeGreaterThan(audit.largest[1]!.descriptionTokens);
  });

  it("reports mean size per tool", () => {
    const audit = auditToolCatalogue([tool("a", LONG), tool("b", LONG)]);
    expect(audit.meanTokensPerTool).toBeCloseTo(audit.tokens / 2, 6);
  });

  it("never claims a whitespace/formatting saving — the provider does not bill it", () => {
    // A catalogue with no plumbing and no redundant titles has NOTHING the
    // provider would tokenise differently; compacting its JSON is hygiene, not a
    // saving. The minifier must report zero lossless tokens and no formatting change.
    const clean = [{
      type: "function",
      function: {
        name: "lookup",
        description: "Look up a record by id.",
        parameters: { type: "object", properties: { id: { type: "string", description: "The id." } }, required: ["id"] },
      },
    }];
    const result = minifyToolSchemas(clean, { descriptions: "keep" });
    expect(result.changes.some((c) => c.kind === "formatting")).toBe(false);
    expect(result.losslessTokensSaved).toBe(0);
  });

  it("still credits real content removal (plumbing) as lossless", () => {
    // The helper always carries parameters.$schema + a redundant accountId title.
    const result = minifyToolSchemas([tool("lookup", "Look up a record by id.")], { descriptions: "keep" });
    expect(result.losslessTokensSaved).toBeGreaterThan(0);
    expect(result.changes.some((c) => c.kind === "plumbing")).toBe(true);
  });
});
