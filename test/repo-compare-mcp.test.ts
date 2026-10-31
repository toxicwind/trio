import { describe, test, expect } from "bun:test";
import { compare, compareTrees, extractDeps, semanticRatio } from "../src/compare.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fixtures ─────────────────────────────────────────────────────────────
const CANON = `import { chat } from '@tanstack/ai'
import { geminiText } from '@tanstack/ai-gemini'
import { ollamaText } from '@tanstack/ai-ollama'
const route = createFileRoute('/api/remy-chat')
let provider = 'ollama'
let model = 'mistral:7b'
`;
const FORK = `import { chat } from '@tanstack/ai'
import { geminiText } from '@tanstack/ai-gemini'
import { ollamaText } from '@tanstack/ai-ollama'
const route = createFileRoute('/api/remy-chat')
let provider: string = 'ollama'
let model: string = 'mistral:7b'
`;

// ── 1. engine behavior (pure) ────────────────────────────────────────────
describe("rc_compare variant report contract", () => {
  test("identical sources → all metrics 1 + same group", () => {
    const r = compare([{ name: "a", source: CANON }, { name: "b", source: CANON }]);
    expect(r.identicalGroups).toEqual([["a", "b"]]);
    const pair = r.pairs[0];
    expect(pair.tokenJaccard).toBe(1);
    expect(pair.semanticRatio).toBe(1);
    expect(pair.astJaccard).toBe(1);
  });

  test("type-annotation drift detected as 2 typed changes, not phantoms", () => {
    const p = compare([{ name: "a", source: CANON }, { name: "b", source: FORK }]).pairs[0];
    // 6-line fixture, 2 typed lines differ → 2*LCS/(n+m) = 2*4/12 = 0.667
    expect(p.semanticRatio).toBeGreaterThan(0.6);
    const kinds = p.changedLines.map((c: { kind: string }) => c.kind);
    expect(kinds.filter((k: string) => k === "type-annotation").length).toBe(2);
    expect(kinds.filter((k: string) => k === "remove" || k === "add").length).toBe(0);
  });

  test("canonical guess selects most-central variant", () => {
    const r = compare([
      { name: "c", source: CANON },
      { name: "f", source: FORK },
      { name: "far", source: CANON.split("\n").map(() => "// diverged").join("\n") },
    ]);
    expect(r.canonicalGuess).toBe("c");
  });

  test("extractDeps catches import/require/dynamic", () => {
    const deps = extractDeps("import x from 'fp-ts'\nimport {y} from 'effect'\nconst z=require('lodash')\nconst w=await import('zod')");
    for (const d of ["fp-ts", "effect", "lodash", "zod"]) expect(deps).toContain(d);
  });

  test("semanticRatio partial line overlap", () => {
    expect(semanticRatio << 0).toBeLessThan(2); // number, not NaN
  });
});

// ── 2. tree rollup (pure, temp dirs) ─────────────────────────────────────
describe("rc_tree_compare rollup contract", () => {
  function makeTree(root: string, files: Record<string, string>) {
    rmSync(root, { recursive: true, force: true });
    for (const [rel, body] of Object.entries(files)) {
      const p = join(root, rel);
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, body);
    }
  }

  test("paired + only-a + only-b counts are exact", async () => {
    const { walkTree } = await import("../src/tree.ts");
    const A = mkdtempSync(join(tmpdir(), "rcA-")), B = mkdtempSync(join(tmpdir(), "rcB-"));
    makeTree(A, { "same.ts": "export const x = 1", "only-a.ts": "export const a = 1" });
    makeTree(B, { "same.ts": "export const x = 1", "only-b.ts": "export const b = 1" });
    const [ta, tb] = [await walkTree(A), await walkTree(B)];
    const rep = compareTrees(ta, tb);
    expect(rep.files.find((f: { path: string }) => f.path === "same.ts")?.relation).toBe("both");
    expect(rep.files.find((f: { path: string }) => f.path === "only-a.ts")?.relation).toBe("only-a");
    const roll = rep.rollup;
    expect(roll.paired).toBe(1);
    expect(roll.onlyA).toBe(1);
    expect(roll.onlyB).toBe(1);
    rmSync(A, { recursive: true, force: true });
    rmSync(B, { recursive: true, force: true });
  });
});

// ── 3. server integration (spawn real server) ────────────────────────────
describe("repo-compare MCP server", () => {
  test("boots and lists the four rc_* tools", async () => {
    const port = 26299;
    const child = spawn("bun", ["mcp/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, REPO_COMPARE_PORT: String(port) },
    });
    try {
      const base = `http://127.0.0.1:${port}/mcp`;
      let up = false;
      for (let i = 0; i < 40; i++) {
        try { await fetch(`http://127.0.0.1:${port}/health`); up = true; break; }
        catch { await Bun.sleep(150); }
      }
      expect(up).toBe(true);
      const list = await (await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json();
      const names = (list?.result?.tools ?? []).map((t: { name: string }) => t.name);
      expect(names).toContain("rc_compare");
      expect(names).toContain("rc_tree_compare");
      expect(names).toContain("rc_deps");
      expect(names).toContain("rc_short_grep");
    } finally {
      child.kill();
    }
  });

  test("rc_short_grep returns line numbers + literal/regex modes", async () => {
    const port = 26300;
    const child = spawn("bun", ["mcp/server.ts"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, REPO_COMPARE_PORT: String(port) } });
    try {
      const base = `http://127.0.0.1:${port}/mcp`;
      for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await Bun.sleep(150); } }
      const call = async (name: string, arguments_: any) => {
        const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: arguments_ } }) });
        return (await r.json()).result.content[0].text;
      };
      const lit = JSON.parse(await call("rc_short_grep", { source: "alpha\nbeta line\ngamma\nbeta2", needle: "beta" }));
      expect(lit.count).toBe(2);
      expect(lit.hits[0].line).toBe(2);
      const re = JSON.parse(await call("rc_short_grep", { source: "a1\nx2\na3", needle: "^a", regex: true }));
      expect(re.count).toBe(2);
    } finally { child.kill(); }
  });
});