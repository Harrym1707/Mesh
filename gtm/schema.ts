// A small runtime schema checker for the go-to-market engine.
//
// Every write to the store is validated against a schema at runtime, because
// the writers are agent sessions handing JSON through the CLI: the TypeScript
// types protect this code, the schemas protect the data. No dependency: the
// repo has no validation library, and the engine adds none.
//
// Objects are strict (an unknown key is an error), so an agent cannot smuggle
// a field the schema does not name.

export type Issue = { path: string; message: string };

export interface Schema<T> {
  /** One-line, human-readable shape. Printed to agents as the output schema. */
  readonly doc: string;
  readonly optional?: boolean;
  check(value: unknown, path: string, issues: Issue[]): void;
  /** Phantom field carrying the static type. Never set. */
  readonly __type?: T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends { optional: true } ? K : never }[keyof S];
type InferShape<S extends Shape> = { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & {
  [K in OptionalKeys<S>]?: Infer<S[K]>;
};
type Simplify<T> = { [K in keyof T]: T[K] } & {};

export class SchemaError extends Error {
  constructor(
    readonly what: string,
    readonly issues: Issue[],
  ) {
    super(`${what} does not match its schema:\n${issues.map((i) => `  ${i.path || "(root)"}: ${i.message}`).join("\n")}`);
    this.name = "SchemaError";
  }
}

export function validate<T>(schema: Schema<T>, value: unknown, what: string): T {
  const issues: Issue[] = [];
  schema.check(value, "", issues);
  if (issues.length > 0) throw new SchemaError(what, issues);
  return value as T;
}

export function issuesOf(schema: Schema<unknown>, value: unknown): Issue[] {
  const issues: Issue[] = [];
  schema.check(value, "", issues);
  return issues;
}

// --- primitives -------------------------------------------------------------

export function str(options: { min?: number; max?: number; pattern?: RegExp; hint?: string } = {}): Schema<string> {
  const min = options.min ?? 1;
  return {
    doc: options.hint ?? "string",
    check(value, path, issues) {
      if (typeof value !== "string") return void issues.push({ path, message: "must be a string" });
      if (value.trim().length < min) issues.push({ path, message: min === 1 ? "must not be empty" : `must be at least ${min} characters` });
      if (options.max !== undefined && value.length > options.max) issues.push({ path, message: `must be at most ${options.max} characters` });
      if (options.pattern && !options.pattern.test(value)) issues.push({ path, message: `must be ${options.hint ?? `like ${options.pattern}`}` });
    },
  };
}

export function num(options: { min?: number; max?: number; int?: boolean } = {}): Schema<number> {
  return {
    doc: options.int ? "integer" : "number",
    check(value, path, issues) {
      if (typeof value !== "number" || !Number.isFinite(value)) return void issues.push({ path, message: "must be a finite number" });
      if (options.int && !Number.isInteger(value)) issues.push({ path, message: "must be a whole number" });
      if (options.min !== undefined && value < options.min) issues.push({ path, message: `must be at least ${options.min}` });
      if (options.max !== undefined && value > options.max) issues.push({ path, message: `must be at most ${options.max}` });
    },
  };
}

export const bool: Schema<boolean> = {
  doc: "boolean",
  check(value, path, issues) {
    if (typeof value !== "boolean") issues.push({ path, message: "must be true or false" });
  },
};

export function oneOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return {
    doc: values.map((v) => JSON.stringify(v)).join(" | "),
    check(value, path, issues) {
      if (typeof value !== "string" || !values.includes(value)) {
        issues.push({ path, message: `must be one of ${values.join(", ")}` });
      }
    },
  };
}

/** A calendar date, YYYY-MM-DD, that is a real day. */
export const isoDate: Schema<string> = {
  doc: "YYYY-MM-DD",
  check(value, path, issues) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      issues.push({ path, message: "must be a date, YYYY-MM-DD" });
    }
  },
};

/** An ISO-8601 instant, as `new Date().toISOString()` writes it. */
export const isoInstant: Schema<string> = {
  doc: "ISO-8601 time",
  check(value, path, issues) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
      issues.push({ path, message: "must be an ISO-8601 UTC time" });
    }
  },
};

// --- combinators ------------------------------------------------------------

export function arr<T>(item: Schema<T>, options: { min?: number; max?: number } = {}): Schema<T[]> {
  return {
    doc: `[${item.doc}]${options.min ? ` (at least ${options.min})` : ""}`,
    check(value, path, issues) {
      if (!Array.isArray(value)) return void issues.push({ path, message: "must be a list" });
      if (options.min !== undefined && value.length < options.min) issues.push({ path, message: `needs at least ${options.min} item(s)` });
      if (options.max !== undefined && value.length > options.max) issues.push({ path, message: `allows at most ${options.max} item(s)` });
      value.forEach((entry, index) => item.check(entry, `${path}[${index}]`, issues));
    },
  };
}

export function opt<T>(inner: Schema<T>): Schema<T> & { optional: true } {
  return {
    doc: inner.doc,
    optional: true,
    check(value, path, issues) {
      if (value === undefined) return;
      inner.check(value, path, issues);
    },
  };
}

export function either<A, B>(a: Schema<A>, b: Schema<B>): Schema<A | B> {
  return {
    doc: `${a.doc} | ${b.doc}`,
    check(value, path, issues) {
      const first: Issue[] = [];
      a.check(value, path, first);
      if (first.length === 0) return;
      const second: Issue[] = [];
      b.check(value, path, second);
      if (second.length === 0) return;
      issues.push({ path, message: `must be ${a.doc} or ${b.doc}` });
    },
  };
}

export function obj<S extends Shape>(shape: S): Schema<Simplify<InferShape<S>>> & { shape: S } {
  const keys = Object.keys(shape);
  return {
    shape,
    doc: `{ ${keys.map((k) => `${k}${shape[k]!.optional ? "?" : ""}: ${shape[k]!.doc}`).join(", ")} }`,
    check(value, path, issues) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return void issues.push({ path, message: "must be an object" });
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!(key in shape)) issues.push({ path: path ? `${path}.${key}` : key, message: "is not a field of this record" });
      }
      for (const key of keys) {
        const field = shape[key]!;
        const at = path ? `${path}.${key}` : key;
        if (record[key] === undefined) {
          if (!field.optional) issues.push({ path: at, message: "is required" });
          continue;
        }
        field.check(record[key], at, issues);
      }
    },
  };
}

/** Free-form JSON object (used only for task inputs an agent hands back verbatim). */
export const anyObject: Schema<Record<string, unknown>> = {
  doc: "object",
  check(value, path, issues) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) issues.push({ path, message: "must be an object" });
  },
};

/** Pretty, indented rendering of an object schema, for prompts and `gtm next`. */
export function describeShape(schema: Schema<unknown>, indent = ""): string {
  const shape = (schema as { shape?: Shape }).shape;
  if (!shape) return `${indent}${schema.doc}`;
  return Object.entries(shape)
    .map(([key, field]) => `${indent}${key}${field.optional ? "?" : ""}: ${field.doc}`)
    .join("\n");
}
