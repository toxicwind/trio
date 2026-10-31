# trio — Todo

> Tracking file for the trio product (persistent Bun notebook kernel; geode pen).
> Mirror of the tau todo board for this arc, TDD-forward: tests pin behavior first,
> deletions only after green replacement coverage. No symlinks — real files only.

## Decide (hunt + compare) — DONE

- [x] ffs-sweep notebook artifacts in tau+kappa (`/home/toxic`) — done via ffs
- [x] Verdict: kappa notebook host (`kappacode/notebook/*`, `notebook_host.ts`) is
      registered but **vscode-gated** (`KAPPA_CLIENT === "vscode"` +
      `experimental.native_notebook_tools`) → orphaned for terminal agents; tau's
      `notebook.rs` is a wired `.ipynb` file codec (editing, not execution).
- [x] Compare eval systems: tau (`eval/py` IPython runner + `eval/js` Bun kernel,
      preludes, tool bridge, package installer, speculation) — most evolved;
      kappa has **no eval kernel** in cli/src.
- [x] Product decision: **trio** — productize tau's most-evolved concept (persistent
      Bun JS kernel) standalone. "trio" naming ties to triphylite's fused
      AST+BM25+LSP trio search.

## Build trio product

- [x] TDD kernel contract tests — guessed pass/fail first (12 tests)
- [x] Implement persistent bun notebook kernel (vm context + async wrapper) — 12/12 GREEN
- [x] CLI run/reset/status + stdio server + session daemon persistence
- [x] Typecheck clean + docs (README semantics pinned)
- [x] trio/TODO.md tracking file + geode registry/README row

## Deprecation cleanup (TDD)

- [x] Inventory deprecated artifacts — geode `ssot/ports.env` (self-declared,
      zero consumers, canonical estate/config/ports.env carries all ports);
      tau `legacy-bundled-resolver.ts` (test-only indirection); r/o SSE +
      legacy-* shims are live wiring, kept.
- [x] TDD replacement coverage pass/fail BEFORE each deletion — deprecation
      contract tests red→green; loader test switched to the real shim first.
- [x] Delete deprecated artifacts — no symlinks — after green.
- [x] Full test + typecheck green (glob 6/6, loader 4/4, geode deprecation
      3/3, trio 12/12).

## Verify + ship

- [x] Verify trio end-to-end — CLI one-shot, cross-invocation session
      persistence, status, reset, stdio protocol, class/destructure/await.
- [x] Commit + push (geode 00f53ec, tau a6239049e3).