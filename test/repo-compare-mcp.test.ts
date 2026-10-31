import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { compare, compareTrees, extractDeps, semanticRatio } from "../src/compare.ts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const TRIO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
    expect(typeof semanticRatio).toBe("function");
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
  async function connect() {
    const client = new Client({ name: "trio-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["mcp/server.ts"],
      cwd: TRIO_ROOT,
      env: { ...process.env, REPO_COMPARE_PORT: "" },
    });
    await client.connect(transport);
    return { client, transport };
  }

  test("boots and lists the four rc_* tools", async () => {
    const { client, transport } = await connect();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const want of ["rc_compare", "rc_tree_compare", "rc_deps", "rc_short_grep", "read_trio_audit", "trio_route"]) {
        expect(names).toContain(want);
      }
    } finally {
      await client.close();
      await transport.close();
    }
  });

  test("rc_short_grep returns line numbers + literal/regex modes", async () => {
    const { client, transport } = await connect();
    try {
      const call = async (name: string, arguments_: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: arguments_ })) as { content?: { type: string; text?: string }[] };
        return r?.content?.[0]?.text ?? "";
      };
      const lit = JSON.parse(await call("rc_short_grep", { source: "alpha\nbeta line\ngamma\nbeta2", needle: "beta" }));
      expect(lit.count).toBe(2);
      expect(lit.hits[0].line).toBe(2);
      const re = JSON.parse(await call("rc_short_grep", { source: "a1\nx2\na3", needle: "^a", regex: true }));
      expect(re.count).toBe(2);
    } finally {
      await client.close();
      await transport.close();
    }
  });

  // Live-github test, guarded by the box's GH credential health: the whole
  // estate's tokens (gh hosts.yml + secretsmith keyring) were invalid on
  // 2026-10-31 (gh auth status rc!=0) and anonymous git cloning is
  // intermittently 401'd by GitHub — no product code can fix a revoked
  // account token. When creds are healthy this runs for real.
  const ghHealthy = spawnSync("gh", ["auth", "status"], { encoding: "utf8", timeout: 15000 }).status === 0;
  test.skipIf(!ghHealthy)("rc_gh_compare clones two real repos and returns a rollup", async () => {
    const { client, transport } = await connect();
    try {
      const r = (await client.callTool({ name: "rc_gh_compare", arguments: { repoA: "toxicwind/trio", repoB: "toxicwind/coreelec-mcp", maxFiles: 600 } })) as {
        content?: { type: string; text?: string }[];
      };
      const text = r?.content?.[0]?.text ?? "";
      const data = JSON.parse(text);
      expect(data.report).toBeDefined();
      expect(data.ms).toBeGreaterThan(0);
    } finally {
      await client.close();
      await transport.close();
    }
  });
});