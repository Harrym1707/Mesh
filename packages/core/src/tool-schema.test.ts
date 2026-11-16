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

/** Follow a same-document JSON pointer (`#/a/b`) from the root schema. */
function resolvePointer(root: unknown, reference: string): unknown {
  let node = root;
  for (const part of reference.replace(/^#\/?/, "").split("/").filter((piece) => piece !== "")) {
    const key = decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Every `$ref` string anywhere in a schema. */
function references(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((item) => references(item, found));
  else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.push(value);
      else references(value, found);
    }
  }
  return found;
}

// The shape a nested model compiles to (Pydantic, zod, most MCP servers): the
// parameter refers to a definition, and one definition refers to another.
function nestedModelTool(definitionsKey: "$defs" | "definitions" = "$defs"): Record<string, unknown> {
  return {
    name: "create_order",
    description: "Create an order for a customer.",
    input_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        customer: { $ref: `#/${definitionsKey}/Customer` },
        quantity: { type: "integer" },
      },
      required: ["customer"],
      [definitionsKey]: {
        Customer: {
          type: "object",
          properties: { name: { type: "string" }, address: { $ref: `#/${definitionsKey}/Address` } },
          required: ["name"],
        },
        Address: { type: "object", properties: { postcode: { type: "string" } } },
      },
    },
  };
}

describe("minifyToolSchemas — references and definitions", () => {
  it("keeps the definitions a $ref points into", () => {
    const original = nestedModelTool();
    const [minified] = minifyToolSchemas([original]).tools as Array<Record<string, unknown>>;
    const schema = minified!.input_schema as Record<string, unknown>;
    const { $schema: _dropped, ...expected } = original.input_schema as Record<string, unknown>;
    expect(schema).toEqual(expected);
    for (const reference of references(schema)) {
      expect(resolvePointer(schema, reference), `${reference} must still resolve`).toBeDefined();
    }
  });

  it("keeps draft-07 `definitions` too", () => {
    const [minified] = minifyToolSchemas([nestedModelTool("definitions")]).tools as Array<Record<string, unknown>>;
    const schema = minified!.input_schema as Record<string, unknown>;
    expect(references(schema).length).toBe(2);
    for (const reference of references(schema)) expect(resolvePointer(schema, reference)).toBeDefined();
  });

  it("keeps $id in a tool that contains a reference, because a relative reference is read against it", () => {
    const original = {
      name: "lookup",
      input_schema: {
        $id: "https://tools.example.com/lookup.json",
        type: "object",
        properties: { customer: { $ref: "customer.json" } },
      },
    };
    const [minified] = minifyToolSchemas([original]).tools;
    expect(minified).toEqual(original);
  });

  it("still removes $defs and $id from a tool that refers to nothing, and decides tool by tool", () => {
    const unreferenced = {
      name: "plain",
      input_schema: {
        $id: "urn:plain",
        type: "object",
        properties: { id: { type: "string" } },
        $defs: { Unused: { type: "object" } },
      },
    };
    const result = minifyToolSchemas([nestedModelTool(), unreferenced]);
    const [withReference, without] = result.tools as Array<Record<string, unknown>>;
    expect(JSON.stringify(withReference)).toContain('"$defs"');
    expect(without).toEqual({ name: "plain", input_schema: { type: "object", properties: { id: { type: "string" } } } });
    expect(result.changes.filter((change) => change.at.startsWith("plain")).map((change) => change.at).sort())
      .toEqual(["plain.input_schema.$defs", "plain.input_schema.$id"]);
  });

  it("still tidies inside the definitions it keeps", () => {
    const original = nestedModelTool();
    const definitions = (original.input_schema as Record<string, Record<string, Record<string, unknown>>>).$defs!;
    definitions.Customer!.title = "Customer";
    definitions.Customer!.$comment = "generated";
    const [minified] = minifyToolSchemas([original]).tools as Array<Record<string, unknown>>;
    const kept = (minified!.input_schema as Record<string, Record<string, Record<string, unknown>>>).$defs!.Customer!;
    expect(kept.title).toBeUndefined();
    expect(kept.$comment).toBeUndefined();
    expect(kept.required).toEqual(["name"]);
  });

  it("never removes a parameter because its name looks like a keyword", () => {
    const original = {
      name: "upsert",
      input_schema: {
        type: "object",
        properties: {
          $id: { type: "string" },
          $schema: { type: "string" },
          $defs: { type: "object" },
          $comment: { type: "string" },
          title: { type: "string" },
          examples: { type: "array" },
        },
        required: ["$id", "title"],
      },
    };
    const result = minifyToolSchemas([original], { dropExamples: true });
    expect(result.tools[0]).toEqual(original);
    expect(result.changes).toEqual([]);
  });

  it("leaves data values alone: defaults, enums and constants are not schema", () => {
    const original = {
      name: "configure",
      input_schema: {
        type: "object",
        properties: {
          options: {
            type: "object",
            default: { $id: "abc", title: "default", $defs: { a: 1 } },
            enum: [{ $schema: "x", title: "0" }],
            const: { $comment: "kept" },
          },
        },
      },
    };
    const result = minifyToolSchemas([original]);
    expect(result.tools[0]).toEqual(original);
    expect(result.changes).toEqual([]);
  });

  it("is stable: minifying the output again changes nothing", () => {
    const once = minifyToolSchemas([nestedModelTool(), tool("lookup", LONG)]);
    const twice = minifyToolSchemas(once.tools);
    expect(twice.tools).toEqual(once.tools);
    expect(twice.changes).toEqual([]);
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
