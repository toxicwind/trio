/**
 * compare.ts — algorithmic repo/variant comparison for trio.
 *
 * Three metric layers over N source variants:
 *   1. token:     normalized-line shingles → Jaccard similarity
 *   2. ast:       structural signature (imports, declarations, calls, strings)
 *                 → signature Jaccard, invariant to quote/whitespace style
 *   3. semantic:  LCS over normalized lines → ratio (2·LCS / (n+m))
 *
 * Per-pair changedLines categorizes edits: import-alias, type-annotation,
 * modified, removed, added. Type-annotation detection compares the two lines
 * with ALL whitespace removed after stripping the `: type` segment — the strip
 * regex can eat boundary spaces, so whitespace-sensitive comparison
 * false-negatives (the 2026-10-30 TDD round-trip proved this three ways).
 *
 * Pure functions, no I/O — callers pass file contents in.
 */

export interface Variant {
	name: string;
	source: string;
}

export interface ChangedLine {
	kind: "import-alias" | "type-annotation" | "modified" | "removed" | "added";
	a?: string;
	b?: string;
}

export interface PairMetric {
	a: string;
	b: string;
	tokenJaccard: number;
	astJaccard: number;
	semanticRatio: number;
	changedLines: ChangedLine[];
	bytesA: number;
	bytesB: number;
}

export interface CompareReport {
	variants: Array<{ name: string; bytes: number; lines: number; hash: string }>;
	pairs: PairMetric[];
	identicalGroups: string[][];
	canonicalGuess: string | null;
}

/** FNV-1a hash for stable identity without crypto. */
export function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** Normalize a line: trim, unify quotes, collapse whitespace runs. */
export function normLine(l: string): string {
	return l.trim().replace(/['"`]/g, '"').replace(/\s+/g, " ");
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 1 : inter / union;
}

function lineTokens(source: string): Set<string> {
	return new Set(source.split("\n").map(normLine).filter(l => l.length > 0));
}

/** Extract dependency specifiers from import/export-from/require/dynamic-import statements. */
export function extractDeps(source: string): string[] {
	const deps = new Set<string>();
	for (const raw of source.split("\n")) {
		const l = normLine(raw);
		const stat = l.match(/(?:^|\})\s*(?:import\s+[^"']*?\s*from\s*|import\s*|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/);
		if (stat) deps.add(stat[1]);
		else {
			const dyn = l.match(/import\s*\(\s*["']([^"']+)["']\s*\)/);
			if (dyn) deps.add(dyn[1]);
		}
	}
	return [...deps];
}

/**
 * AST-ish signature: structural tokens (imports, declarations, calls, strings)
 * PLUS dep edges — each dependency specifier becomes a `dep <specifier>` token
 * with the imported names folded in (`dep react:useEffect`), so two files that
 * import different names from the same package diverge in the signature.
 */
export function astSignature(source: string): Set<string> {
	const sig = new Set<string>();
	for (const dep of extractDeps(source)) {
		const m = dep.match(/["']?([\w./@-]+)["']?$/); // base specifier
		const base = m ? m[1] : dep;
		// named imports on their own line fold into the dep token
		const names = new Set<string>();
		for (const raw of source.split("\n")) {
			const l = normLine(raw);
			const nm = l.match(/import\s*{([^}]*)}\s*from/);
			if (nm && l.includes(base)) {
				for (const piece of nm[1].split(",")) {
					const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
					if (name) names.add(name);
				}
			}
		}
		if (names.size > 0) for (const n of names) sig.add(`dep ${base}:${n}`);
		else sig.add(`dep ${base}`);
	}
	for (const raw of source.split("\n")) {
		const l = normLine(raw);
		if (!l) continue;
		if (l.startsWith("import ") || l.startsWith("} from")) sig.add(`import ${l}`);
		const decl = l.match(/(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/);
		if (decl) sig.add(`decl ${decl[1]}`);
		for (const m of l.matchAll(/([A-Za-z_$][\w$]*)\(/g)) sig.add(`call ${m[1]}`);
		for (const m of raw.matchAll(/"([^"]{2,})"/g)) sig.add(`str ${normLine(m[1])}`);
	}
	return sig;
}

/**
 * type-annotation test: strip `: type` segments, then compare with ALL
 * whitespace removed. The strip regex greedily includes trailing whitespace
 * (`provider: string =` → `provider=` vs plain `provider =`), so any
 * whitespace-preserving comparison false-negatives.
 */
function isTypeAnnotation(A: string, B: string): boolean {
	const strip = (s: string) => s.replace(/:\s*[\w[\]<>,.\s{}|]+/g, "").replace(/\s+/g, "");
	return strip(A) === strip(B);
}

/** Categorize one paired change. */
function classifyPair(a: string, b: string): ChangedLine["kind"] {
	const A = normLine(a), B = normLine(b);
	if (A === B) return "modified"; // identical pair: positional-merge artifact
	const aliasFree = (s: string) => s.replace(/@\/|#\//g, "P/");
	if (aliasFree(A) === aliasFree(B) && (A.includes("@/") || A.includes("#/"))) return "import-alias";
	if (isTypeAnnotation(A, B)) return "type-annotation";
	return "modified";
}

/** Semantic ratio: 2·LCS / (n+m) over normalized non-empty lines. */
export function semanticRatio(a: string, b: string): number {
	const A = a.split("\n").map(normLine).filter(Boolean);
	const B = b.split("\n").map(normLine).filter(Boolean);
	const denom = A.length + B.length;
	if (denom === 0) return 1;
	// fast path: identical prefix/suffix skip (common in drifted variants) —
	// only the divergent middle band pays the O(n*m) DP cost
	let pre = 0;
	while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
	let suf = 0;
	while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
	const midA = A.slice(pre, A.length - suf);
	const midB = B.slice(pre, B.length - suf);
	const lcsCommon = pre + suf;
	if (midA.length === 0 || midB.length === 0) return (2 * lcsCommon) / denom;
	// hash lines to u32 once (O(n+m)) — DP then compares ints, not strings
	const hashLine = (s: string): number => {
		let h = 0x811c9dc5;
		for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); }
		return h >>> 0;
	};
	const HA = Int32Array.from(midA, hashLine);
	const HB = Int32Array.from(midB, hashLine);
	const n = midA.length, m = midB.length;
	const dp = new Uint32Array((n + 1) * (m + 1));
	const at = (i: number, j: number) => i * (m + 1) + j;
	for (let i = n - 1; i >= 0; i--) {
		const rowA = HA[i];
		const base = i * (m + 1);
		const below = (i + 1) * (m + 1);
		for (let j = m - 1; j >= 0; j--) {
			dp[base + j] = rowA === HB[j]
				? dp[below + j + 1] + 1
				: Math.max(dp[below + j], dp[base + j + 1]);
		}
	}
	return (2 * (lcsCommon + dp[0])) / denom;
}

/**
 * Compare a pair. The greedy LCS walk groups dels and adds into runs between
 * matches; each del-run/add-run pair is merged positionally (del[k] ↔ add[k])
 * as categorized changes. Surplus entries remain real removed/added lines.
 */
export function comparePair(a: Variant, b: Variant): PairMetric {
	const rawA = a.source.split("\n");
	const rawB = b.source.split("\n");
	const NA = rawA.map(normLine).filter(Boolean);
	const NB = rawB.map(normLine).filter(Boolean);
	const OA = rawA.filter(l => normLine(l).length > 0);
	const OB = rawB.filter(l => normLine(l).length > 0);
	const nAll = NA.length, mAll = NB.length;

	// shared fast path: strip common prefix/suffix once; the middle band pays
	// for both the DP and the walk
	let pre = 0;
	while (pre < nAll && pre < mAll && NA[pre] === NB[pre]) pre++;
	let suf = 0;
	while (suf < nAll - pre && suf < mAll - pre && NA[nAll - 1 - suf] === NB[mAll - 1 - suf]) suf++;

	const midNA = NA.slice(pre, nAll - suf);
	const midNB = NB.slice(pre, mAll - suf);
	const midOA = OA.slice(pre, nAll - suf);
	const midOB = OB.slice(pre, mAll - suf);
	const n = midNA.length, m = midNB.length;

	const hashLine = (s: string): number => {
		let h = 0x811c9dc5;
		for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); }
		return h >>> 0;
	};
	const HA = Int32Array.from(midNA, hashLine);
	const HB = Int32Array.from(midNB, hashLine);

	const changedLines: ChangedLine[] = [];
	let lcs = pre + suf;

	if (n === 0 || m === 0) {
		for (const l of midOA) changedLines.push({ kind: "removed", a: l });
		for (const l of midOB) changedLines.push({ kind: "added", b: l });
	} else {
		const dp = new Uint32Array((n + 1) * (m + 1));
		const base0 = n * (m + 1);
		for (let i = n - 1; i >= 0; i--) {
			const rowA = HA[i];
			const base = i * (m + 1);
			const below = (i + 1) * (m + 1);
			for (let j = m - 1; j >= 0; j--) {
				dp[base + j] = rowA === HB[j]
					? dp[below + j + 1] + 1
					: Math.max(dp[below + j], dp[base + j + 1]);
			}
		}
		lcs += dp[0];

		let delRun: string[] = [];
		let addRun: string[] = [];
		const flushRun = () => {
			const k = Math.min(delRun.length, addRun.length);
			for (let q = 0; q < k; q++)
				changedLines.push({ kind: classifyPair(delRun[q], addRun[q]), a: delRun[q], b: addRun[q] });
			for (let q = k; q < delRun.length; q++) changedLines.push({ kind: "removed", a: delRun[q] });
			for (let q = k; q < addRun.length; q++) changedLines.push({ kind: "added", b: addRun[q] });
			delRun = [];
			addRun = [];
		};
		let i = 0, j = 0;
		while (i < n && j < m) {
			if (HA[i] === HB[j]) { flushRun(); i++; j++; continue; }
			if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { delRun.push(midOA[i]); i++; }
			else { addRun.push(midOB[j]); j++; }
		}
		while (i < n) { delRun.push(midOA[i]); i++; }
		while (j < m) { addRun.push(midOB[j]); j++; }
		flushRun();
	}

	const denom = nAll + mAll;
	return {
		a: a.name,
		b: b.name,
		tokenJaccard: jaccard(lineTokens(a.source), lineTokens(b.source)),
		astJaccard: jaccard(astSignature(a.source), astSignature(b.source)),
		semanticRatio: denom === 0 ? 1 : (2 * lcs) / denom,
		changedLines: changedLines.slice(0, 50),
		bytesA: a.source.length,
		bytesB: b.source.length,
	};
}

/** Full report: distance matrix + identical groups + canonical guess. */
export function compare(variants: Variant[]): CompareReport {
	const hashes = variants.map(v => fnv1a(v.source));
	const pairs: PairMetric[] = [];
	for (let i = 0; i < variants.length; i++)
		for (let j = i + 1; j < variants.length; j++)
			pairs.push(comparePair(variants[i], variants[j]));

	const byHash = new Map<string, string[]>();
	variants.forEach((v, k) => byHash.set(hashes[k], [...(byHash.get(hashes[k]) ?? []), v.name]));
	const identicalGroups = [...byHash.values()].filter(g => g.length > 1);

	let canonicalGuess: string | null = null;
	let best = -1;
	for (const v of variants) {
		const rel = pairs.filter(p => p.a === v.name || p.b === v.name);
		if (rel.length === 0) continue;
		const mean = rel.reduce((s, p) => s + p.semanticRatio, 0) / rel.length;
		if (mean > best) { best = mean; canonicalGuess = v.name; }
	}

	return {
		variants: variants.map((v, k) => ({
			name: v.name, bytes: v.source.length,
			lines: v.source.split("\n").length, hash: hashes[k],
		})),
		pairs,
		identicalGroups,
		canonicalGuess,
	};
}

// ─── tree mode: two file trees, paired by relative path ──────────────────
// (pure — filesystem walking lives in tree.ts; callers pass entries in)

export interface TreeFileEntry {
	path: string;      // relative path, POSIX separators
	source: string;
}

export interface TreePairMetric extends PairMetric {
	path: string;
	relation: "both" | "only-a" | "only-b";
}

export interface TreeCompareReport {
	rollup: {
		filesA: number;
		filesB: number;
		paired: number;
		onlyA: number;
		onlyB: number;
		identical: number;         // byte-identical pairs
		semanticDrift: number;     // mean semanticRatio over paired, <1 only
		meanToken: number;
		meanAst: number;
	};
	files: TreePairMetric[];      // sorted: drift ascending (most drifted first), only-* at end
}

/**
 * Compare two file trees paired by relative path. Files present in only one
 * tree get a synthetic pair (vs empty) with relation only-a/only-b. Rollup
 * aggregates over paired files only.
 */
export function compareTrees(a: TreeFileEntry[], b: TreeFileEntry[]): TreeCompareReport {
	const byPathA = new Map(a.map(f => [f.path, f.source]));
	const byPathB = new Map(b.map(f => [f.path, f.source]));
	const paths = [...new Set([...byPathA.keys(), ...byPathB.keys()])].sort();

	const files: TreePairMetric[] = [];
	for (const p of paths) {
		const sa = byPathA.get(p), sb = byPathB.get(p);
		const relation = sa !== undefined && sb !== undefined ? "both" : sa !== undefined ? "only-a" : "only-b";
		const m = comparePair({ name: `${p}:a`, source: sa ?? "" }, { name: `${p}:b`, source: sb ?? "" });
		files.push({ ...m, path: p, relation });
	}

	const both = files.filter(f => f.relation === "both");
	const identical = both.filter(f => f.tokenJaccard === 1 && f.semanticRatio === 1).length;
	const drifted = both.filter(f => f.semanticRatio < 1);
	const mean = (xs: number[]) => (xs.length === 0 ? 1 : xs.reduce((s, x) => s + x, 0) / xs.length);
	files.sort((f, g) => {
		const ra = f.relation === "both" ? 0 : 1, rb = g.relation === "both" ? 0 : 1;
		if (ra !== rb) return ra - rb;
		if (ra === 1) return f.path.localeCompare(g.path);
		return f.semanticRatio - g.semanticRatio; // most drifted first
	});
	return {
		rollup: {
			filesA: a.length,
			filesB: b.length,
			paired: both.length,
			onlyA: files.filter(f => f.relation === "only-a").length,
			onlyB: files.filter(f => f.relation === "only-b").length,
			identical,
			semanticDrift: mean(drifted.map(f => f.semanticRatio)),
			meanToken: mean(both.map(f => f.tokenJaccard)),
			meanAst: mean(both.map(f => f.astJaccard)),
		},
		files,
	};
}
