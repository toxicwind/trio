#!/usr/bin/env bun
/**
 * repo-compare — MCP server exposing the trio algorithmic compare engine.
 *
 * Folds the variant/repo compare feature into an agent-callable surface:
 *   rc_compare       — N source variants → tok/ast/sem matrix + canonical guess
 *   rc_tree_compare  — two repo dirs walked, paired by path → rollup + per-file
 *   rc_deps          — extract dependency imports/requires from a source string
 *   rc_short_grep    — quick literal/regex find over a source string (meta-tool
 *                      for picking variants before compare)
 *
 * Federated via thresher (:25127) as stdio; streamable-HTTP JSON-RPC 2.0 shape
 * mirrors vision-kit mcp/server.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { serve } from "bun";
import { compare, compareTrees, extractDeps } from "../src/compare.ts";
import { walkTree } from "../src/tree.ts";

const PORT = Number(process.env.REPO_COMPARE_PORT ?? 25229);
const MAX_READ = 2 * 1024 * 1024; // 2 MiB per source fed to engine

function rpc(id, result, error) {
  const out = { jsonrpc: "2.0", id: id ?? null };
  if (error) out.error = error;
  else out.result = result ?? {};
  return out;
}

function readSource(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const buf = readFileSync(path);
  if (buf.length > MAX_READ) throw new Error(`file too large (${buf.length}b)`);
  return buf.toString("utf8");
}

async function handle(ctx) {
  const args = ctx.args ?? {};
  switch (ctx.tool) {
    case "rc_compare": {
      const variants = Array.isArray(args.variants) ? args.variants : [];
      if (!variants.length) return { error: "variants[] required: [{name, source}]" };
      const parsed = variants.map(v => ({ name: String(v.name), source: String(v.source) }));
      return { report: compare(parsed), n: parsed.length };
    }
    case "rc_tree_compare": {
      const a = String(args.repoA ?? ""), b = String(args.repoB ?? "");
      if (!a || !b) return { error: "repoA and repoB (absolute dirs) required" };
      if (!existsSync(a) || !existsSync(b)) return { error: "repo dir missing" };
      const t0 = Date.now();
      const ra = await walkTree(a), rb = await walkTree(b);
      const report = compareTrees(ra, rb);
      return { report, ms: Date.now() - t0 };
    }
    case "rc_deps": {
      const src = String(args.source ?? "");
      if (!src) return { error: "source required" };
      return { deps: extractDeps(src) };
    }
    case "rc_short_grep": {
      const src = String(args.source ?? "");
      const needle = String(args.needle ?? "");
      if (!src || !needle) return { error: "source and needle required" };
      const flags = args.regex === true ? "g" : "g";
      let re;
      try {
        re = args.regex === true ? new RegExp(needle, flags) : null;
      } catch (e) {
        return { error: `bad regex: ${e.message}` };
      }
      const lines = src.split("\n");
      const hits = [];
      for (let i = 0; i < lines.length; i++) {
        const ok = re ? re.test(lines[i]) : lines[i].includes(needle);
        if (ok) hits.push({ line: i + 1, text: lines[i].slice(0, 200) });
      }
      return { count: hits.length, hits: hits.slice(0, 100) };
    }
    default:
      return rpc(null, null, { code: -32601, message: `unknown tool: ${ctx.tool}` });
  }
}

// tools list
const tools = [
  { name: "rc_compare", description: "Compare N source variants across 3 metric layers (token Jaccard, dep-aware AST signature Jaccard, LCS semantic ratio). Returns matrix, identical groups, canonical guess, per-pair categorized changed-lines.", inputSchema: { type: "object", properties: { variants: { type: "array", items: { type: "object", properties: { name: { type: "string" }, source: { type: "string" } }, required: ["name", "source"] } } }, required: ["variants"] } },
  { name: "rc_tree_compare", description: "Walk two repo directories, pair files by relative path, roll up token/ast/sem similarity + per-file diffs. Fast tree-level ancestry/copy detection.", inputSchema: { type: "object", properties: { repoA: { type: "string", description: "absolute dir" }, repoB: { type: "string", description: "absolute dir" } }, required: ["repoA", "repoB"] } },
  { name: "rc_deps", description: "Extract dependency specifiers (import/export-from/require/dynamic-import) from a source string.", inputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] } },
  { name: "rc_short_grep", description: "Literal or regex search over a source string, returns line:match hits (helper to pick variants before compare).", inputSchema: { type: "object", properties: { source: { type: "string" }, needle: { type: "string" }, regex: { type: "boolean" } }, required: ["source", "needle"] } },
];

const render = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return render({ status: "ok", tools: tools.length });
    if (url.pathname === "/mcp" && req.method === "POST") {
      const body = await req.json();
      const id = body.id;
      if (body.method === "initialize") {
        return render(rpc(id, { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "repo-compare", version: "0.1.0" } }));
      }
      if (body.method === "tools/list") return render(rpc(id, { tools }));
      if (body.method === "tools/call") {
        try {
          const res = await handle({ tool: body.params.name, args: body.params.arguments });
          if (res && res.error) return render(rpc(id, null, { code: -32602, message: res.error }));
          return render(rpc(id, { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] }));
        } catch (e) {
          return render(rpc(id, null, { code: -32603, message: String(e.message || e) }));
        }
      }
      return render(rpc(id, null, { code: -32601, message: "method not found" }));
    }
    return render(rpc(null, null, { code: -32601, message: "not found" }));
  },
});

console.error(`repo-compare MCP server on :${PORT} (${tools.length} tools)`);