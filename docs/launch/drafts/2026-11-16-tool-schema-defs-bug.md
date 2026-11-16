# Our "lossless" tool-schema lever wasn't — it deleted $defs

MESH ships a tool-schema-compaction lever on by default: before a request
reaches the provider, it strips redundant keys from the JSON Schemas your
tools declare (titles that just restate a property name, `$schema`,
`$comment`, that kind of thing) so you pay for fewer input tokens. We call it
lossless because the schema the model sees should be semantically identical
to the one you sent — same validation behavior, same referenceable shape,
fewer bytes.

It wasn't lossless. If a tool's schema used `$defs` — the block that holds
shared type definitions other parts of the schema point at with `$ref` — the
lever deleted the whole block and left every `$ref` pointing at nothing.

## How it broke

`$defs` is exactly the shape Pydantic (and a lot of other schema generators)
emit for nested models: define `Address` once under `$defs`, then reference
it from `home_address` and `work_address` with `$ref: "#/$defs/Address"`
instead of repeating the fields twice. Our compaction pass treated `$defs`
as structural plumbing — the same category as `$schema` or `$comment` — and
removed it outright, on the theory that nothing downstream needed it. That
theory was wrong for any tool that actually used a `$ref` into it: the
provider receives a schema with `home_address: {"$ref": "#/$defs/Address"}`
and no `$defs` block anywhere, i.e. a reference to nothing.

We found it while reproducing the lever through `reduceRequest` with the
three default levers on — not from a customer report — and once we were
looking, two more faults of the same shape turned up:

- **Keyword-shaped parameter names got deleted.** The compaction pass walks
  `properties` looking for schema keywords to strip. But the *keys* of
  `properties` are parameter names, not keywords. A tool with a parameter
  literally named `$id`, `$schema`, or `$comment` had that parameter deleted
  from `properties` while `required` still listed it — a schema that fails
  its own validation.
- **Data got stripped like it was schema.** `default`, `const`, `enum`, and
  `examples` hold *data values*, not nested schemas. If one of those values
  happened to be an object with a key like `$comment` (a legitimate field in
  someone's data, nothing to do with JSON Schema), the pass walked into it
  and deleted that key too, silently changing the tool's default or enum
  values.

All three bugs are the same root mistake: treating a map's *keys* as if they
were always schema keywords, when sometimes they're names (`properties`,
`$defs`, `definitions`, `patternProperties`, `dependentSchemas`,
`dependencies`) or data (inside `default`, `const`, `enum`, `examples`).

## The fix

Commit `73dcdfe`:

- `$defs` is never removed — referenced or not. Proving a definition is
  unreferenced means correctly resolving every form a `$ref` can take
  (fragment pointers, nested refs, refs from inside other `$defs` entries),
  and a wrong unreferenced-check corrupts the schema. Rather than get that
  resolution right under time pressure, we stopped removing `$defs` at all.
- The keys of every name-to-schema map (`properties`, `patternProperties`,
  `$defs`, `definitions`, `dependentSchemas`, `dependencies`) are now
  treated as names, never matched against the keyword-strip list.
- Values inside `default`, `const`, `enum`, and `examples` are copied
  through untouched — the pass no longer walks into them looking for
  keywords to remove.
- `$id` is kept on any tool that uses a reference keyword anywhere in its
  schema, since a `$ref` can resolve against it.

Nothing else about the lever changed: `$schema`, `$comment`, and `$id` on
tools that don't use references, plus titles that just restate a property
name, are still stripped, same as before.

## What we checked, and what didn't move

971 tests pass across 67 files at default timeouts; `tsc -b` and
`typecheck:lab` are clean. We also ran one request with a nested-model tool
(the Pydantic `$defs`-and-`$ref` shape) through both the broken build and
the fixed one against a stand-in provider: the broken build forwards the
tool schema with `$defs` gone and the `$ref` dangling; the fixed build
forwards it exactly as the client sent it, byte for byte.

No recorded fixture or capture in our test suite used `$defs`, which is how
this shipped in the first place and also why it's an easy sentence to write
honestly: **no published savings figure on the evidence page moves.** The
bug lived in a code path none of our benchmarked traffic exercised. That's
not a reason to shrug it off — correctness bugs in a lever that silently
corrupts your tool schema are exactly the kind of thing a "lossless, default
on" promise can't tolerate even once, and we don't know how many tools
outside our fixtures use `$defs` that this was wrong for the whole time. It
is a reason the number on the comparison table you're reading stays
accurate while we tell you about the bug.

If you're evaluating any tool-schema compaction feature — ours or someone
else's — the question worth asking isn't "what's the token savings," it's
"show me the fixture that has a `$ref` into `$defs`, and show me the output
schema is byte-identical in shape to the input." We didn't have that
fixture. We do now.
