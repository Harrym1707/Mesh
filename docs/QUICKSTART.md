# Quickstart

> This file previously documented an early telemetry-receiver prototype that
> no longer exists. The real quickstart lives in the [README](../README.md)
> and on [www.mesh-technology.com](https://www.mesh-technology.com). Short version:

```bash
curl -fsSL https://www.mesh-technology.com/install.sh | sh   # or: npm install -g @harrym1707/mesh
mesh start    # Claude Code
mesh proxy    # your own app or agent
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
