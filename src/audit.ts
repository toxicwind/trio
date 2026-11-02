/**
 * trio audit engine — federated parallel AST + BM25 + LSP + ROUTE code
 * intelligence, consolidated from the retired `@geode/triphylite` product
 * (2026-10-31). Same RRF fusion, widened to Rust/Go/Python/TS source so it
 * route-traces estate routers (rhodochrosite proxy is Rust).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Source extensions we scan for lexical/route hits. */
const SRC_RE = /\.(ts|tsx|js|jsx|json|md|py|go|rs)$/;
const CODE_RE = /\.(ts|tsx|js|jsx|rs|py|go)$/;

export interface TrioHit {
	file: string;
	line: number;
	snippet: string;
	source: "ast" | "bm25" | "lsp" | "route";
	score: number;
	context?: string[];
}

export interface FusedTrioHit {
	file: string;
	line: number;
	snippet: string;
	rrfScore: number;
	channels: string[];
}

export interface AuditArtifacts {
	dir: string;
	files: { channel: string; path: string; count: number }[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".cache", "archive", "target", "vendor"]);

async function walkFiles(dir: string, depth: number, want: (name: string) => boolean, cb: (file: string) => Promise<void>) {
	if (depth > 7) return;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) await walkFiles(join(dir, e.name), depth + 1, want, cb);
		} else if (e.isFile() && want(e.name)) {
			try {
				await cb(join(dir, e.name));
			} catch {}
		}
	}
}

// ── query analysis ───────────────────────────────────────────────────────
// A symbol query ("startBunStdinPump definition call sites") must anchor every
// structured channel on the REAL identifier, not the filler words. Stopwords
// here are deliberate: they are the words models paste around a symbol.
const STOPWORDS = new Set([
	"and", "or", "the", "for", "with", "from", "into", "any", "all", "its", "are", "was", "not", "but",
	"definition", "definitions", "called", "calls", "call", "callers", "caller", "sites", "site", "usage",
	"uses", "used", "using", "reference", "references", "where", "declared", "declaration", "symbol",
	"search", "find", "findings", "result", "results", "function", "method", "class", "line", "across",
]);

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g;

function extractIdentifiers(query: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of query.matchAll(IDENT_RE)) {
		const ident = m[0];
		if (STOPWORDS.has(ident) || seen.has(ident)) continue;
		seen.add(ident);
		out.push(ident);
	}
	return out;
}

/** Primary identifier the AST/LSP channels anchor on; longest wins. */
export function primarySymbol(query: string): string | undefined {
	const idents = extractIdentifiers(query);
	if (idents.length === 0) return undefined;
	return idents.reduce((a, b) => (b.length > a.length ? b : a));
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function searchBm25(dir: string, query: string): Promise<TrioHit[]> {
	const hits: TrioHit[] = [];
	const symbols = extractIdentifiers(query);
	const terms = new Set<string>(symbols);
	for (const t of query.toLowerCase().split(/\s+/).filter(Boolean)) {
		if (!STOPWORDS.has(t) && !/^[a-z]+$/i.test(t)) terms.add(t);
	}
	if (!terms.size) return hits;
	await walkFiles(dir, 0, (name) => SRC_RE.test(name), async (file) => {
		const content = await readFile(file, "utf8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			const lineLower = line.toLowerCase();
			// Symbol-anchored: once a real identifier is in the query, a line must
			// carry one of them or it is filler-word noise ("definition", "call").
			if (symbols.length && !symbols.some((s) => lineLower.includes(s.toLowerCase()))) continue;
			let matches = 0;
			for (const t of terms) if (lineLower.includes(t)) matches++;
			if (matches > 0) {
				hits.push({ file, line: i + 1, snippet: line.trim(), source: "bm25", score: matches / terms.size });
			}
		}
	});
	return hits.sort((a, b) => b.score - a.score).slice(0, 100);
}

export interface AstResult {
	hits: TrioHit[];
	parseIssues: number;
	stderr: string;
}

/** ast-grep structural search; surfaces parse failures instead of swallowing. */
export async function searchAst(dir: string, pattern: string): Promise<AstResult> {
	const empty: AstResult = { hits: [], parseIssues: 0, stderr: "" };
	const needle = pattern?.trim();
	if (!needle) return empty;
	const res = spawnSync("ast-grep", ["run", "--pattern", needle, "--json", dir], {
		encoding: "utf8",
		maxBuffer: 40 * 1024 * 1024,
	});
	const stderr = (res.stderr ?? "").toString().trim();
	const hits: TrioHit[] = [];
	let parseIssues = 0;
	if (res.stdout && res.stdout.trim()) {
		try {
			const parsed = JSON.parse(res.stdout) as Array<{ file: string; range: { start: { line: number } }; lines: string }>;
			for (const p of parsed) {
				hits.push({ file: p.file, line: p.range.start.line, snippet: p.lines.split("\n")[0]?.trim() ?? "", source: "ast", score: 1.0 });
			}
		} catch {}
	}
	const pm = /(\d+)\s*parse error/i.exec(stderr);
	if (pm) parseIssues = Number(pm[1]);
	else if (/parse error/i.test(stderr)) parseIssues = 1;
	return { hits, parseIssues, stderr: stderr.slice(0, 400) };
}

/** Symbol-reference scan: declaration AND reference lines, word-boundary, with context. */
export async function searchLsp(dir: string, symbol: string): Promise<TrioHit[]> {
	const hits: TrioHit[] = [];
	const needle = symbol?.trim();
	if (!needle) return hits;
	const re = new RegExp(`\\b${escapeRegex(needle.split(".")[0] ?? needle)}\\b`);
	await walkFiles(dir, 0, (name) => CODE_RE.test(name), async (file) => {
		const content = await readFile(file, "utf8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			if (!re.test(line)) continue;
			const context = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).map((l) => l.trim());
			const isDecl = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum|pub\s+fn|pub\s+struct|pub\s+use|def|struct|fn|impl|use)\b/.test(line.trim()) ||
				/^(?:export\s+)?(?:default\s+)?(?:function|class|const)\s+\w*/.test(line.trim()) ||
				/(?:^|\W)(?:import|export)\s+[^(\n]*\b/.test(line) && line.trim().startsWith("import");
			hits.push({ file, line: i + 1, snippet: line.trim(), source: "lsp", score: isDecl ? 1.0 : 0.9, ...(context.length ? { context } : {}) });
		}
	});
	return hits;
}

/** Route-dispatch tracing: mode/action == "key" → handler, across any source. */
export async function searchRoutes(dir: string, mode: string, limit = 25): Promise<TrioHit[]> {
	const hits: TrioHit[] = [];
	const needle = mode.trim();
	if (!needle) return hits;
	const needlePrefix = needle.includes(".") ? `${needle.split(".")[0]}.` : needle;
	await walkFiles(dir, 0, (name) => /\.(py|ts|js|rs)$/.test(name), async (file) => {
		const content = await readFile(file, "utf8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			const lineHasNeedle = line.includes(needle) || (needlePrefix !== needle && line.includes(needlePrefix));
			if (!lineHasNeedle) continue;
			if (/setting_id|setting_default|setting_type|'[^']*'\s*,\s*'setting/.test(line) && !/(?:elif|if)\s+/.test(line)) continue;
			const isDispatch =
				/(?:mode|action|route|method|cmd|op)\s*(?:==|!=|in|not in)\s*['"]/.test(line) ||
				/(?:mode|action)\s*(?:in|not in)\s+\(?\s*'[^']*'/m.test(line) ||
				/['"][^'"]*['"]\s+in\s+(?:mode|action|params|self\.params|plugin)\b/.test(line) ||
				/mode\.(?:startswith|endswith)\s*\(/.test(line) ||
				/^\s*(?:elif|if|case|match)\s+['"]/.test(line) ||
				/^\s*return\s+['"][^'"]*/.test(line) ||
				/['"][^'"]+['"]\s*:\s*(?:['"]|exec|return|def\b|function|=>)/.test(line) ||
				/(\bmode\b|\baction\b|\broute\b).*(?:==|in|:)\s*['"]/.test(line) ||
				/^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+/.test(line) && /(?:req|response|route|handler)/.test(line);
			const isRouteDecl = /routes::|\.route\(|match\s+\w+\.path|path\s*\(\.\.\)|handler/.test(line) && lineHasNeedle;
			if (isDispatch || isRouteDecl) {
				hits.push({ file, line: i + 1, snippet: line.trim().slice(0, 200), source: "route", score: isDispatch ? 1.0 : 0.8 });
			}
		}
	});
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── persistence (untruncated run artifacts) ──────────────────────────────
function persistArtifacts(pairs: { channel: string; hits: TrioHit[] }[]): AuditArtifacts | null {
	try {
		const base = resolve("runs");
		mkdirSync(base, { recursive: true });
		const dir = join(base, `audit-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const files: AuditArtifacts["files"] = [];
		for (const { channel, hits } of pairs) {
			const path = join(dir, `${channel.toLowerCase()}.json`);
			writeFileSync(path, JSON.stringify({ count: hits.length, hits }, null, 2));
			files.push({ channel, path, count: hits.length });
		}
		return { dir, files };
	} catch {
		return null;
	}
}

export async function executeReadTrioAudit(
	query: string,
	targetDir = ".",
	limit = 20,
): Promise<{ hits: FusedTrioHit[]; stats: { ast: number; bm25: number; lsp: number; route: number; astParseIssues: number; elapsedMs: number }; routes: FusedTrioHit[]; symbol: string | null; artifacts: AuditArtifacts | null }> {
	const t0 = performance.now();
	const absDir = resolve(targetDir);
	const symbol = primarySymbol(query) ?? null;
	const astNeedle = symbol ?? query.trim();
	const [astRes, bm25Hits, lspHits, routeHits] = await Promise.all([
		searchAst(absDir, astNeedle),
		searchBm25(absDir, query),
		searchLsp(absDir, astNeedle),
		searchRoutes(absDir, query),
	]);
	const astHits = astRes.hits;
	const K = 60;
	const map = new Map<string, { hit: TrioHit; rrf: number; channels: Set<string> }>();
	function addRanked(list: TrioHit[], channel: string) {
		for (let r = 0; r < list.length; r++) {
			const item = list[r]!;
			const key = `${item.file}:${item.line}`;
			const score = 1 / (K + r + 1);
			const existing = map.get(key);
			if (existing) {
				existing.rrf += score;
				existing.channels.add(channel);
			} else {
				map.set(key, { hit: item, rrf: score, channels: new Set([channel]) });
			}
		}
	}
	addRanked(astHits, "AST");
	addRanked(bm25Hits, "BM25");
	addRanked(lspHits, "LSP");
	addRanked(routeHits, "ROUTE");
	const hits: FusedTrioHit[] = [...map.values()]
		.sort((a, b) => b.rrf - a.rrf)
		.slice(0, limit)
		.map((e) => ({ file: e.hit.file, line: e.hit.line, snippet: e.hit.snippet, rrfScore: Number(e.rrf.toFixed(4)), channels: [...e.channels] }));
	const artifacts = persistArtifacts([
		{ channel: "AST", hits: astHits },
		{ channel: "LSP", hits: lspHits },
		{ channel: "BM25", hits: bm25Hits },
		{ channel: "ROUTE", hits: routeHits },
	]);
	return {
		hits,
		routes: routeHits.map((r) => ({ file: r.file, line: r.line, snippet: r.snippet, rrfScore: Number(r.score.toFixed(4)), channels: ["ROUTE"] })),
		stats: { ast: astHits.length, bm25: bm25Hits.length, lsp: lspHits.length, route: routeHits.length, astParseIssues: astRes.parseIssues, elapsedMs: Number((performance.now() - t0).toFixed(1)) },
		symbol,
		artifacts,
	};
}