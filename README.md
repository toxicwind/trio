<div align="center">

<h1>💎 trio</h1>

<p><strong>Tri-Pillar Code Intelligence: Algorithmic Repo Compare, 4-Channel RRF Code Search, & Persistent Bun Notebook Kernel</strong></p>

[![repo](https://img.shields.io/badge/github-toxicwind%2Ftrio-181717.svg?style=for-the-badge&logo=github&logoColor=white)](https://github.com/toxicwind/trio)
[![tests](https://img.shields.io/badge/tests-45%20passed-brightgreen.svg?style=for-the-badge&logo=bun)](https://github.com/toxicwind/trio)
[![runtime](https://img.shields.io/badge/runtime-bun%201.4.4-fbf0df.svg?style=for-the-badge&logo=bun&logoColor=black)](https://bun.sh)
[![mcp](https://img.shields.io/badge/mcp-7%20tools-8A2BE2.svg?style=for-the-badge)](mcp/server.ts)
[![license](https://img.shields.io/badge/license-MIT-green.svg?style=for-the-badge)](LICENSE)

</div>

---

**trio** unifies three critical operational capabilities into a single, high-performance engine for AI agents and engineering workflows:

```
                             ┌──────────────────────────────────┐
                             │          trio Engine             │
                             └─────────────────┬────────────────┘
                                               │
             ┌─────────────────────────────────┼─────────────────────────────────┐
             ▼                                 ▼                                 ▼
  ┌─────────────────────┐           ┌─────────────────────┐           ┌─────────────────────┐
  │   1. Repo Compare   │           │ 2. Code Intelligence│           │ 3. Notebook Kernel  │
  │ • Token Jaccard     │           │ • AST pattern search│           │ • Persistent VM     │
  │ • AST Jaccard       │           │ • FTS5/BM25 text    │           │ • Top-level await   │
  │ • Semantic LCS      │           │ • Symbol & LSP hops │           │ • Stdio JSON RPC    │
  │ • GitHub tree diff  │           │ • Strict ROUTE RRF  │           │ • Socket daemons    │
  └─────────────────────┘           └─────────────────────┘           └─────────────────────┘
```

---

## 🏛️ The Three Pillars

### 1. Algorithmic Variant & Tree Compare
Deep mathematical comparison across source files, directory trees, or live GitHub repositories without false positives from whitespace or formatting.
- **Token Jaccard**: Bag-of-tokens set similarity.
- **AST Signature Jaccard**: Syntax-tree structure comparison invariant to variable renames.
- **Longest Common Subsequence (LCS)**: Semantic ratio analyzing character/block alignment.

### 2. 4-Channel RRF Code Intelligence (`read_trio_audit`, `trio_route`)
Federated search combining **AST**, **BM25**, **LSP**, and **ROUTE** channels using Reciprocal Rank Fusion (RRF).
- **Strict Route Tracing**: Strips guard-clause noise; isolates genuine URL, HTTP, IPC, and router dispatch tables across TypeScript, Python, Go, and Rust.

### 3. Persistent Bun Notebook Kernel
The estate's standalone execution VM:
- Top-level `let`/`const`/`class`/`function` bindings persist across cell executions.
- Top-level `await` supported natively.
- Zero Jupyter or VS Code dependencies.

---

## 🔌 MCP Stdio Server (7 Tools)

Trio ships a ready-to-run Stdio Model Context Protocol (MCP) server at `mcp/server.ts`:

| Tool | Description |
|---|---|
| `rc_compare` | Multi-variant comparison returning token/AST/semantic matrix + diff classifications. |
| `rc_tree_compare` | Deep pairwise directory tree comparison with paired, only-A, and only-B rollups. |
| `rc_deps` | Extract dependency specifiers across diverse project manifests. |
| `rc_short_grep` | High-speed literal and regex search with exact line offsets. |
| `rc_gh_compare` | Clone two remote GitHub repositories and generate comparative audit rollups. |
| `read_trio_audit` | Federated parallel AST + BM25 + LSP code intelligence. |
| `trio_route` | Strict dispatch table tracing across project routers. |

---

## 💻 CLI Usage

### Notebook Kernel

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