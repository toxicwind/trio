/**
 * trio audit engine — federated parallel AST + BM25 + LSP + ROUTE code
 * intelligence, consolidated from the retired `@geode/triphylite` product
 * (2026-10-31). Same RRF fusion, widened to Rust/Go/Python/TS source so it
 * route-traces estate routers (rhodochrosite proxy is Rust).
 */
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Source extensions we scan for lexical/route hits. */
const SRC_RE = /\.(ts|tsx|js|jsx|json|md|py|go|rs)$/;

export interface TrioHit {
	file: string;
	line: number;
	snippet: string;
	source: "ast" | "bm25" | "lsp" | "route";
	score: number;
}

export interface FusedTrioHit {
	file: string;
	line: number;
	snippet: string;
	rrfScore: number;
	channels: string[];
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

export async function searchBm25(dir: string, query: string): Promise<TrioHit[]> {
	const hits: TrioHit[] = [];
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return hits;
	await walkFiles(dir, 0, (name) => SRC_RE.test(name), async (file) => {
		const content = await readFile(file, "utf8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const lineLower = (lines[i] ?? "").toLowerCase();
			let matches = 0;
			for (const t of terms) if (lineLower.includes(t)) matches++;
			if (matches > 0) {
				hits.push({ file, line: i + 1, snippet: (lines[i] ?? "").trim(), source: "bm25", score: matches / terms.length });
			}
		}
	});
	return hits.sort((a, b) => b.score - a.score).slice(0, 50);
}

/** ast-grep structural search over any language ast-grep knows. */
export async function searchAst(dir: string, pattern: string): Promise<TrioHit[]> {
	const hits: TrioHit[] = [];
	const res = spawnSync("ast-grep", ["run", "--pattern", pattern, "--json", dir], {
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
	});
	if (res.status === 0 && res.stdout.trim()) {
		try {
			const parsed = JSON.parse(res.stdout) as Array<{ file: string; range: { start: { line: number } }; lines: string }>;
			for (const p of parsed) {
				hits.push({ file: p.file, line: p.range.start.line, snippet: p.lines.split("\n")[0]?.trim() ?? "", source: "ast", score: 1.0 });
			}
		} catch {}
	}
	return hits;
}

/** Symbol/declaration lexical scan (TS emphasis, but matches any identifier-ish needle). */
export async function searchLsp(dir: string, symbol: string): Promise<TrioHit[]> {
	const hits: TrioHit[] = [];
	const needle = symbol.trim();
	if (!needle) return hits;
	const script = `
	import { readdir, readFile } from "node:fs/promises";
	import { join } from "node:path";
	const SKIP = new Set(["node_modules",".git","dist",".cache","target","vendor","archive"]);
	async function scan(cur){
		try{ const es=await readdir(cur,{withFileTypes:true});
		for(const e of es){ if(e.isDirectory()){ if(!SKIP.has(e.name)) await scan(join(cur,e.name)); }
		else if(e.isFile() && /\\.(ts|tsx|rs|py|go|js)$/.test(e.name)){ const p=join(cur,e.name);
		try{ const code=await readFile(p,"utf8"); const lines=code.split("\\n");
		lines.forEach((l,idx)=>{ if(l.includes(${JSON.stringify(needle)}) && /function|class|const|let|export|import|pub |def |struct |fn /.test(l)){ console.log(JSON.stringify({file:p,line:idx+1,snippet:l.trim()}));} });
		}catch{} }} }catch{} }
	await scan(${JSON.stringify(dir)});
	`;
	const res = spawnSync("bun", ["-e", script], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
	if (res.status === 0 && res.stdout.trim()) {
		for (const line of res.stdout.trim().split("\n")) {
			try {
				const p = JSON.parse(line);
				hits.push({ file: p.file, line: p.line, snippet: p.snippet, source: "lsp", score: 0.95 });
			} catch {}
		}
	}
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
			} else if (/(?:elif|if|case|match)\s+/.test(line)) {
				hits.push({ file, line: i + 1, snippet: line.trim().slice(0, 200), source: "route", score: 0.7 });
			}
		}
	});
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function executeReadTrioAudit(
	query: string,
	targetDir = ".",
	limit = 20,
): Promise<{ hits: FusedTrioHit[]; stats: { ast: number; bm25: number; lsp: number; route: number; elapsedMs: number }; routes: FusedTrioHit[] }> {
	const t0 = performance.now();
	const absDir = resolve(targetDir);
	const [astHits, bm25Hits, lspHits, routeHits] = await Promise.all([
		searchAst(absDir, query),
		searchBm25(absDir, query),
		searchLsp(absDir, query),
		searchRoutes(absDir, query),
	]);
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
	return {
		hits,
		routes: routeHits.map((r) => ({ file: r.file, line: r.line, snippet: r.snippet, rrfScore: Number(r.score.toFixed(4)), channels: ["ROUTE"] })),
		stats: { ast: astHits.length, bm25: bm25Hits.length, lsp: lspHits.length, route: routeHits.length, elapsedMs: Number((performance.now() - t0).toFixed(1)) },
	};
}