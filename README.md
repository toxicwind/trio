# trio

Persistent **Bun notebook kernel** — the estate's standalone take on the most
evolved eval system (tau's JS kernel) as a first-class geode product.

Run JS cells with persistent top-level state across calls, top-level `await`,
rich error folding, and a plain stdio protocol — no Jupyter, no VS Code, no
orphaned host bridge. A single Bun process holds the VM; cells append into it.

## Why

tau and kappa grew separate eval systems. kappa's notebook path
(`kappacode/notebook/*`, `notebook_execute`) is a request/reply bridge gated
to `KAPPA_CLIENT === "vscode"` — orphaned for terminal agents. tau's JS eval
kernels (`packages/coding-agent/src/eval/js/*`) are the most evolved: persistent
VM, prelude, tool bridge, package install, speculation. **trio** productizes
that kernel as a named geode product anyone can run.

## Usage

```sh
# One-off cell (new kernel per process unless --session)
bun bin/trio.ts run 'const x = 21; x * 2'

# Persistent session: cells share top-level state. A `--session NAME` command
# talks to a detached per-session kernel daemon (unix socket under
# ~/.cache/trio/), so state survives across CLI invocations.
bun bin/trio.ts --session demo run 'let acc = 0; acc += 1; acc'
bun bin/trio.ts --session demo run 'acc += 40; acc'

# Reset a session
bun bin/trio.ts --session demo reset

# Status
bun bin/trio.ts status
bun bin/trio.ts --session demo status
```

## Protocol (stdio)

`trio serve` speaks newline-delimited JSON on stdin/stdout:

```json
{"id":1,"op":"run","code":"1 + 1"}
{"id":1,"ok":true,"value":2,"text":""}
```

Ops: `run`, `reset`, `status`. `reset` clears the kernel's top-level
bindings; `status` reports cell/error counts and the session name.

## Semantics (pinned by tests)

- Top-level `let`/`const`/`class`/`function` bindings persist across `run`
  cells in the same session.
- Top-level `await` works; the final expression value is returned.
- `console.log` output is captured to `text`.
- Sync throw / rejected promise produce `ok:false` with the error; the kernel
  survives and later cells still see earlier bindings.
- `reset` drops all user bindings; built-in helpers stay.

## License

Estate internal — all rights reserved.