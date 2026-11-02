#!/usr/bin/env bun
/**
 * repo-compare — stdio MCP server exposing the trio algorithmic compare engine.
 *
 * Folds the variant/repo compare feature into an agent-callable surface.
 * Federated via thresher (:25127). Same SDK pattern as coreelec-mcp.
 *
 * Tools:
 *   rc_compare       — N variants → token/ast/semantic matrix + categorized diffs
 *   rc_tree_compare  — two dirs → per-path paired rollup
 *   rc_deps          — extract dependency specifiers from a source string
 *   rc_short_grep    — literal/regex line search over a source string
 *   rc_gh_compare    — clone two GitHub repos, tree-compare (scale-guarded)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { compare, compareTrees, extractDeps } from "../src/compare.ts"
import { walkTree } from "../src/tree.ts"
import { executeReadTrioAudit, searchRoutes } from "../src/audit.ts"
import { semanticOverlap, cosine, embedBgeM3, rerankByQuery } from "../src/semantic.ts"
import { mkdtempSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const server = new McpServer({ name: "trio", version: "0.4.0" })

// ─── read_trio_audit: parallel AST + BM25 + LSP + ROUTE federated search ──
server.tool(
  "read_trio_audit",
  "Parallel AST + BM25 + symbol-ref + ROUTE federated code search and architectural audit. Anchors on the primary identifier in the query (so filler words never dominate), fuses structural matches (ast-grep), lexical tokens (BM25), and declaration+reference symbol hits using RRF. Full untruncated per-channel results are persisted to runs/audit-<ts>/*.json artifacts (returned in `artifacts`).",
  {
    query: z.string().describe("Symbol, pattern, or search terms to audit across the codebase"),
    path: z.string().optional().describe("Root path or directory to search within (defaults to '.')"),
    limit: z.number().optional().default(20).describe("Maximum number of fused hits to return"),
  },
  async ({ query, path = ".", limit = 20 }) => {
    const result = await executeReadTrioAudit(query, path, limit)
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
  },
)

// ─── trio_route: structural route-dispatch tracing ───────────────────────
server.tool(
  "trio_route",
  "Structural route-dispatch tracing: given a mode/action/route key (e.g. 'playback.media', 'chat/completions', 'file_list'), find the dispatch-table entries and handler definitions that route to it, across router/navigator/handler files in TS/JS/Python/Rust. Returns per-file line hits with the dispatch predicate.",
  {
    route: z.string().describe("Mode/action/route key to trace"),
    path: z.string().optional().describe("Directory to search (default '.')"),
    limit: z.number().optional().default(25).describe("Max hits"),
  },
  async ({ route, path = ".", limit = 25 }) => {
    const routes = await searchRoutes(path, route, limit)
    return { content: [{ type: "text", text: JSON.stringify({ routes }, null, 2) }] }
  },
)

// ─── trio_semantic_rerank: bge-m3 query-relevance rerank ───────────────
// Experimentally validated 2026-11-02 (E1): query-rerank places the 429-capped
// provider line above the settings-doc for a "cap concurrent requests" query.
// Fails open to [] when embeddings are unavailable.
server.tool(
  "trio_semantic_rerank",
  "Rerank a list of code snippets by bge-m3 cosine relevance to a natural-language query. Use when lexical search returns many hits and you want the semantically-relevant ones. Each snippet is embedded together with the query; scores are cosine similarity (0..1, >=0.45 is related, >=0.6 is strong). Fails open to [] if the embedding lane is down.",
  {
    query: z.string().describe("Natural-language intent or symbol to rerank by"),
    snippets: z.array(z.string()).max(200).describe("Code/snippet lines to rerank"),
  },
  async ({ query, snippets }) => {
    const t0 = Date.now()
    const { scores } = await rerankByQuery(query, snippets)
    const ranked = scores
      .map((score, i) => ({ index: i, snippet: (snippets[i] ?? "").slice(0, 300), score: Number(score.toFixed(4)) }))
      .sort((a, b) => b.score - a.score)
    return { content: [{ type: "text", text: JSON.stringify({ ranked, ms: Date.now() - t0 }, null, 2) }] }
  },
)

// ─── trio_code_sim: bge-m3 code-similarity matrix ──────────────────────
// Validated: CS1 same-code-shifted 0.847 vs 0.426 diff; CS2 paraphrase-eq
// 0.747 vs 0.491 unrelated. Refactored/renamed-but-same logic clusters well.
server.tool(
  "trio_code_sim",
  "Semantic code-similarity matrix between N code snippets (bge-m3 embeddings + cosine). Detect near-duplicate or paraphrase-equivalent implementations across files/pens even when renamed. 0.7+ = near-duplicate; 0.5-0.7 = same logic rephrased; <0.45 = unrelated.",
  {
    snippets: z.array(z.object({
      id: z.string().describe("identifier (file path or name)"),
      text: z.string().max(4000).describe("code text"),
    })).min(2).max(60).describe("code snippets to compare"),
  },
  async ({ snippets }) => {
    const t0 = Date.now()
    const vecs = await embedBgeM3(snippets.map(s => s.text.slice(0, 1500)))
    const pairs = [] as { a: string; b: string; cosine: number; verdict: string }[]
    for (let i = 0; i < snippets.length; i++) {
      for (let j = i + 1; j < snippets.length; j++) {
        const c = cosine(vecs[i]!, vecs[j]!)
        const verdict = c >= 0.7 ? "near-duplicate" : c >= 0.5 ? "paraphrase-eq" : "unrelated"
        pairs.push({ a: snippets[i]!.id, b: snippets[j]!.id, cosine: Number(c.toFixed(4)), verdict })
      }
    }
    pairs.sort((a, b) => b.cosine - a.cosine)
    return { content: [{ type: "text", text: JSON.stringify({ pairs, ms: Date.now() - t0 }, null, 2) }] }
  },
)

// ─── trio_product_sim: bge-m3 product/README similarity ────────────────
// Validated: PS1 sibling-product READMEs 0.459 vs 0.339 unrelated. Use with
// README-ish prose (0.3-0.5 range — corpus-idiom baselines exist across the
// estate, so compare RELATIVE similarity, not absolute).
server.tool(
  "trio_product_sim",
  "Semantic similarity between product descriptions/READMEs (bge-m3). Find which product a description belongs to, detect overlapping products across pens, or locate a product's canonical home. Pass document pairs; cosine 0.5+ with sibling docs = likely same product family. NOTE: docs within one estate share idiom vocabulary — compare RELATIVE similarity, not absolute.",
  {
    products: z.array(z.object({
      id: z.string().describe("product/repo id"),
      text: z.string().max(4000).describe("README/description prose"),
    })).min(2).max(60),
  },
  async ({ products }) => {
    const t0 = Date.now()
    const vecs = await embedBgeM3(products.map(p => p.text.slice(0, 1500)))
    const pairs = [] as { a: string; b: string; cosine: number }[]
    for (let i = 0; i < products.length; i++) {
      for (let j = i + 1; j < products.length; j++) {
        pairs.push({ a: products[i]!.id, b: products[j]!.id, cosine: Number(cosine(vecs[i]!, vecs[j]!).toFixed(4)) })
      }
    }
    pairs.sort((a, b) => b.cosine - a.cosine)
    return { content: [{ type: "text", text: JSON.stringify({ pairs, ms: Date.now() - t0 }, null, 2) }] }
  },
)

// ─── rc_compare: N variants → metric matrix ────────────────────────────
server.tool(
  "rc_compare",
  "Compare N source variants with three metric layers (token Jaccard, dep-aware AST signature Jaccard, LCS semantic ratio). Returns the pair matrix, identical groups, canonical guess, and per-pair categorized changed lines (import-alias / type-annotation / modified / removed / added).",
  {
    variants: z.array(z.object({
      name: z.string().describe("variant id"),
      source: z.string().describe("source text"),
    })).min(1).describe("variants to compare"),
  },
  async ({ variants }) => {
    const t0 = Date.now()
    const report = compare(variants)
    return { content: [{ type: "text", text: JSON.stringify({ report, ms: Date.now() - t0 }, null, 2) }] }
  },
)

// ─── rc_tree_compare: two dirs → rollup ────────────────────────────────
server.tool(
  "rc_tree_compare",
  "Compare two local directories line-by-line, paired by relative path. Returns a rollup (files/paired/only-a/only-b/identical + mean similarity) and per-file diffs.",
  {
    a: z.string().describe("first directory"),
    b: z.string().describe("second directory"),
  },
  async ({ a, b }) => {
    const t0 = Date.now()
    const ra = await walkTree(a), rb = await walkTree(b)
    const report = compareTrees(ra, rb)
    return { content: [{ type: "text", text: JSON.stringify({ report, ms: Date.now() - t0 }, null, 2) }] }
  },
)

// ─── rc_deps: extract dependency specifiers ────────────────────────────
server.tool(
  "rc_deps",
  "Extract dependency specifiers from a source string (import, export-from, require(), dynamic import).",
  { source: z.string().describe("source text") },
  async ({ source }) => {
    const deps = extractDeps(source)
    return { content: [{ type: "text", text: JSON.stringify({ deps }, null, 2) }] }
  },
)

// ─── rc_short_grep: literal/regex line search ──────────────────────────
server.tool(
  "rc_short_grep",
  "Literal or regex search over a source string; returns line:match hits (helper to pick variants or find a needle).",
  {
    source: z.string().describe("source text"),
    needle: z.string().describe("string or regex to find"),
    regex: z.boolean().optional().describe("treat needle as regex (default literal)"),
  },
  async ({ source, needle, regex }) => {
    const hits = [] as { line: number; text: string }[]
    const re = regex ? new RegExp(needle) : null
    source.split("\n").forEach((line, i) => {
      if (re ? re.test(line) : line.includes(needle)) hits.push({ line: i + 1, text: line.trim() })
    })
    return { content: [{ type: "text", text: JSON.stringify({ count: hits.length, hits }, null, 2) }] }
  },
)

// ─── rc_gh_compare: clone + tree-compare (scale-guarded) ───────────────
function runCli(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // GIT_TERMINAL_PROMPT=0: public clones must never block/prompt on a
    // broken or missing credential helper (gh token invalid, stdin closed).
    // Anonymous access falls through for public repos; private repos error
    // cleanly via the captured stderr instead of hanging.
    const c = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    let out = "", err = ""
    c.stdout.on("data", d => out += d)
    c.stderr.on("data", d => err += d)
    c.on("close", code => code === 0 ? resolve(out) : reject(new Error((err || out).slice(0, 300))))
  })
}
async function cloneRepo(spec: string): Promise<string> {
  const dir = mkdtempSync(`${tmpdir()}/rc-gh-`)
  await runCli("git", ["clone", "--depth", "1", `https://github.com/${spec}`, "repo"], dir)
  return join(dir, "repo")
}
server.tool(
  "rc_gh_compare",
  "Clone two GitHub repos (owner/repo) to tmp and tree-compare them. Scale-guarded by maxFiles. Requires network + git.",
  {
    repoA: z.string().describe("owner/repo"),
    repoB: z.string().describe("owner/repo"),
    maxFiles: z.number().optional().default(3000).describe("file-count guard"),
  },
  async ({ repoA, repoB, maxFiles }) => {
    const t0 = Date.now()
    const da = await cloneRepo(repoA), db = await cloneRepo(repoB)
    const ra = await walkTree(da), rb = await walkTree(db)
    if (ra.length > maxFiles || rb.length > maxFiles) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `tree too large: ${ra.length}/${rb.length} files > maxFiles ${maxFiles}` }, null, 2) }], isError: true }
    }
    const report = compareTrees(ra, rb)
    return { content: [{ type: "text", text: JSON.stringify({ report, ms: Date.now() - t0, homes: [da, db] }, null, 2) }] }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error("trio MCP server running on stdio (7 tools: rc_compare, rc_tree_compare, rc_deps, rc_short_grep, rc_gh_compare, read_trio_audit, trio_route)")