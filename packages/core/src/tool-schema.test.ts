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

/** Resolve a local "#/…" JSON pointer against a document. */
function resolvePointer(document: unknown, reference: string): unknown {
  let node: unknown = document;
  for (const raw of reference.slice(1).split("/").filter((part) => part !== "")) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof node !== "object" || node === null || !(key in node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Every "$ref" string in a schema. */
function referencesIn(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) referencesIn(item, found);
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.push(value);
      else referencesIn(value, found);
    }
  }
  return found;
}

function anthropicTool(inputSchema: Record<string, unknown>): Record<string, unknown> {
  return { name: "create_order", description: "Create an order for a customer.", input_schema: inputSchema };
}

function inputSchemaOf(result: { tools: unknown[] }): Record<string, unknown> {
  return (result.tools[0] as { input_schema: Record<string, unknown> }).input_schema;
}

describe("minifyToolSchemas: references, names and data survive the lossless tier", () => {
  // The shape a nested Pydantic model compiles to.
  const nested = {
    type: "object",
    properties: {
      customer: { $ref: "#/$defs/Customer" },
      note: { type: "string", description: "Free text." },
    },
    required: ["customer"],
    $defs: {
      Customer: {
        type: "object",
        properties: { id: { type: "string" }, address: { $ref: "#/$defs/Address" } },
        required: ["id"],
      },
      Address: { type: "object", properties: { city: { type: "string" } } },
    },
  };

  it("keeps $defs, so every $ref still resolves", () => {
    const result = minifyToolSchemas([anthropicTool(nested)]);
    const sent = inputSchemaOf(result);
    expect(sent.$defs).toEqual(nested.$defs);
    const references = referencesIn(sent);
    expect(references).toEqual(["#/$defs/Customer", "#/$defs/Address"]);
    for (const reference of references) expect(resolvePointer(sent, reference)).toBeDefined();
    // Nothing was removed, so nothing is claimed.
    expect(result.changes).toEqual([]);
    expect(result.losslessTokensSaved).toBe(0);
  });

  it("keeps a definition nothing points to", () => {
    // Proving a definition unreferenced means resolving every form a $ref can
    // take. The lossless tier does not take that bet.
    const schema = { ...nested, $defs: { ...nested.$defs, Orphan: { type: "string" } } };
    expect(inputSchemaOf(minifyToolSchemas([anthropicTool(schema)])).$defs).toEqual(schema.$defs);
  });

  it("keeps draft-07 definitions and a recursive reference", () => {
    const schema = {
      type: "object",
      properties: { root: { $ref: "#/definitions/Node" } },
      definitions: {
        Node: {
          type: "object",
          properties: { children: { type: "array", items: { $ref: "#/definitions/Node" } } },
        },
      },
    };
    const sent = inputSchemaOf(minifyToolSchemas([anthropicTool(schema)]));
    expect(sent).toEqual(schema);
  });

  it("keeps nested $defs and references with escaped pointers", () => {
    const schema = {
      type: "object",
      properties: {
        item: {
          type: "object",
          properties: { size: { $ref: "#/properties/item/$defs/Size~1Unit" } },
          $defs: { "Size/Unit": { type: "string", enum: ["cm", "in"] } },
        },
      },
    };
    const sent = inputSchemaOf(minifyToolSchemas([anthropicTool(schema)]));
    expect(sent).toEqual(schema);
    for (const reference of referencesIn(sent)) expect(resolvePointer(sent, reference)).toBeDefined();
  });

  it("keeps $id when the tool uses a reference, and still removes it when it does not", () => {
    const withReference = {
      $id: "https://example.com/schemas/order.json",
      type: "object",
      properties: { line: { $ref: "line.json" } },
      $defs: { Line: { $id: "line.json", type: "object" } },
    };
    const sent = inputSchemaOf(minifyToolSchemas([anthropicTool(withReference)]));
    expect(sent).toEqual(withReference);

    const withoutReference = { $id: "https://example.com/schemas/order.json", type: "object", properties: {} };
    const result = minifyToolSchemas([anthropicTool(withoutReference)]);
    expect(inputSchemaOf(result)).toEqual({ type: "object", properties: {} });
    expect(result.changes.map((change) => change.kind)).toEqual(["plumbing"]);
  });

  it("decides $id per tool, not for the whole catalogue", () => {
    const plain = { $id: "urn:plain", type: "object", properties: {} };
    const result = minifyToolSchemas([anthropicTool(nested), { ...anthropicTool(plain), name: "ping" }]);
    expect((result.tools[1] as { input_schema: unknown }).input_schema).toEqual({ type: "object", properties: {} });
  });

  it("treats the keys of properties as names, not keywords", () => {
    // A tool that takes a JSON document can have parameters called exactly this.
    const schema = {
      type: "object",
      properties: {
        $id: { type: "string", description: "Identifier of the document." },
        $schema: { type: "string", description: "Schema URL of the document." },
        $comment: { type: "string" },
        $defs: { type: "object" },
        title: { type: "string" },
        description: { type: "string" },
        default: { type: "string" },
        enum: { type: "array", items: { type: "string" } },
        properties: { type: "object", properties: { $id: { type: "string" } } },
      },
      required: ["$id", "$schema"],
    };
    const sent = inputSchemaOf(minifyToolSchemas([anthropicTool(schema)]));
    expect(sent).toEqual(schema);
    const parameters = Object.keys(sent.properties as Record<string, unknown>);
    for (const name of sent.required as string[]) expect(parameters).toContain(name);
  });

  it("keeps parameters named like keywords when descriptions are trimmed or dropped", () => {
    const schema = {
      type: "object",
      properties: { description: { type: "string", description: "The text of the description field." } },
    };
    const dropped = inputSchemaOf(minifyToolSchemas([anthropicTool(schema)], { descriptions: "drop" }));
    // The parameter survives; only its own description text is lossy-removed.
    expect(dropped.properties).toEqual({ description: { type: "string" } });
  });

  it("copies default, const, enum and examples through untouched", () => {
    const schema = {
      type: "object",
      properties: {
        document: {
          type: "object",
          default: { $id: "urn:example:1", $comment: "the caller's", title: "document" },
          examples: [{ $schema: "https://example.com/s.json", description: "an example" }],
        },
        kind: { const: { $id: 7 } },
        mode: { enum: [{ $comment: "a" }, "b"] },
      },
    };
    const sent = inputSchemaOf(minifyToolSchemas([anthropicTool(schema)]));
    expect(sent).toEqual(schema);
    // A copy, not the caller's own object.
    const sentDocument = (sent.properties as Record<string, { default: unknown }>).document!;
    expect(sentDocument.default).not.toBe(schema.properties.document.default);
  });

  it("still removes $schema and $comment inside a definition", () => {
    const schema = {
      type: "object",
      properties: { customer: { $ref: "#/$defs/Customer" } },
      $defs: { Customer: { $comment: "generated", $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" } },
    };
    const result = minifyToolSchemas([anthropicTool(schema)]);
    expect(inputSchemaOf(result).$defs).toEqual({ Customer: { type: "object" } });
    expect(result.changes.every((change) => change.kind === "plumbing" && change.lossless)).toBe(true);
    expect(result.changes).toHaveLength(2);
  });
});

