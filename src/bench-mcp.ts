#!/usr/bin/env bun
// bench-mcp.ts — latency bench over the repo-compare MCP server (HTTP JSON-RPC).
// Mirrors vision-kit's bench.mjs: per-tool TTFT + wall, best-of-N, writes runs/<ts>.json.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.RC_BENCH_PORT ?? 26320);
const CANON = `import { chat } from '@tanstack/ai'
import { geminiText } from '@tanstack/ai-gemini'
import { ollamaText } from '@tanstack/ai-ollama'
const route = createFileRoute('/api/remy-chat')
let provider = 'ollama'
let model = 'mistral:7b'
`;
const FORK = CANON.replace("let provider = 'ollama'", "let provider: string = 'ollama'").replace("let model = 'mistral:7b'", "let model: string = 'mistral:7b'");

async function waitUp(base, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { await fetch(`${base}/health`); return true; } catch { await Bun.sleep(150); }
  }
  return false;
}

async function timeCall(base, name, args, bestOf = 3) {
  let best = Infinity;
  for (let i = 0; i < bestOf; i++) {
    const t0 = performance.now();
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name, arguments: args } }) });
    await r.json();
    best = Math.min(best, performance.now() - t0);
  }
  return { tool: name, bestMs: Number(best.toFixed(2)), bestOf };
}

const child = spawn("bun", ["mcp/server.ts"], { cwd: root, env: { ...process.env, REPO_COMPARE_PORT: String(PORT) }, stdio: "ignore" });
try {
  const base = `http://127.0.0.1:${PORT}/mcp`;
  const up = await waitUp(base);
  if (!up) throw new Error("server did not boot");
  const rows = await Promise.all([
    timeCall(base, "rc_compare", { variants: [{ name: "a", source: CANON }, { name: "b", source: FORK }] }),
    timeCall(base, "rc_deps", { source: CANON }),
    timeCall(base, "rc_short_grep", { source: CANON + CANON + CANON, needle: "provider" }),
    timeCall(base, "rc_tree_compare", { repoA: root + "/src", repoB: root + "/src" }),
  ]);
  const out = { at: new Date().toISOString(), rows };
  mkdirSync(join(root, "runs"), { recursive: true });
  const path = join(root, "runs", `mcp-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log("\nwrote", path);
} finally {
  child.kill();
}