# Quickstart

> This file previously documented an early telemetry-receiver prototype that
> no longer exists. The real quickstart lives in the [README](../README.md)
> and on [www.mesh-technology.com](https://www.mesh-technology.com). Short version:

Mesh is a local proxy for LLM API traffic, for teams running their own agents on the Anthropic or OpenAI API: out of the box it makes three lossless changes to each request and records every saving in a hash-chained ledger on your own machine, so you can recompute the bill yourself.

```bash
curl -fsSL https://www.mesh-technology.com/install.sh | sh   # or: npm install -g @harrym1707/mesh
mesh proxy    # your own app or agent
mesh start    # Claude Code (works, but gains little on the defaults)
```

For your own app, point your client at it, keeping your own key:

```js
const anthropic = new Anthropic({ baseURL: "http://127.0.0.1:8787" });
```

Every request writes one hash-chained event under `~/.mesh/ledger/`.
Recompute the invoice yourself:

```bash
mesh verify
```

A fresh install makes three lossless changes only (tool-schema compaction,
exact-duplicate removal, cache-prefix repair). The larger figures in the
README needed levers that are off by default; the README says which, and
[docs/site/start.md](site/start.md) says how to switch them on.
