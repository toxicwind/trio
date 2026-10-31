/**
 * semantic — cross-corpus semantic overlap via freeinference bge-m3 embeddings.
 *
 * Pure math + one async `embedTexts` boundary (inject a fetcher for tests).
 * Produces:
 *   - per-file vectors (bge-m3)
 *   - cosine similarity matrix (pairwise, bounded)
 *   - a corpus-level overlap score (mean of top-k cross-pair similarities)
 *   - a stable top-overlap ranking for the prose layer
 */
export interface OverlapFile {
	path: string;
	text: string;
}

export interface OverlapPair {
	a: string;          // file path in corpus A
	b: string;          // file path in corpus B
	cosine: number;     // 0..1
}

export interface SemanticOverlap {
	pairs: OverlapPair[];       // sorted desc by cosine, capped
	corpusOverlap: number;      // 0..1 mean of top-k cross pairs
	topK: number;
	aCount: number;
	bCount: number;
}

export type EmbedFetcher = (texts: string[]) => Promise<number[][]>;

/** Cosine similarity between two vectors (0..1). Handles zero vectors. */
export function cosine(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Compute a bounded semantic-overlap between two file corpora.
 *
 * Embeds high-signal files (path/everything under a size cap), pairs each of
 * the `maxPerSide` most-significant vectors against the other corpus, and
 * returns the top `maxPairs` cross-similarities plus a mean overlap.
 */
export async function semanticOverlap(
	a: OverlapFile[],
	b: OverlapFile[],
	opts: {
		embedFn?: EmbedFetcher;
		maxPerSide?: number;
		maxPairs?: number;
		maxChars?: number;
	} = {},
): Promise<SemanticOverlap> {
	const maxPerSide = opts.maxPerSide ?? 40;
	const maxPairs = opts.maxPairs ?? 10;
	const maxChars = opts.maxChars ?? 2000;
	const embed = opts.embedFn ?? embedBgeM3;

	// Deterministic slice: stable sort by path, take head window (no RNG).
	const pick = (files: OverlapFile[]) =>
		[...files]
			.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
			.slice(0, maxPerSide)
			.map(f => ({ path: f.path, text: f.text.slice(0, maxChars) }));

	const sliceA = pick(a);
	const sliceB = pick(b);

	if (sliceA.length === 0 || sliceB.length === 0) {
		return { pairs: [], corpusOverlap: 0, topK: 0, aCount: a.length, bCount: b.length };
	}

	const [vecA, vecB] = await Promise.all([
		embed(sliceA.map(f => f.text)),
		embed(sliceB.map(f => f.text)),
	]);

	const pairs: OverlapPair[] = [];
	for (let i = 0; i < vecA.length; i++) {
		for (let j = 0; j < vecB.length; j++) {
			const c = cosine(vecA[i], vecB[j]);
			pairs.push({ a: sliceA[i].path, b: sliceB[j].path, cosine: c });
		}
	}
	pairs.sort((x, y) => y.cosine - x.cosine);

	const top = pairs.slice(0, maxPairs);
	const corpusOverlap = top.length
		? top.reduce((s, p) => s + p.cosine, 0) / top.length
		: 0;

	return { pairs: top, corpusOverlap, topK: top.length, aCount: a.length, bCount: b.length };
}

/** Default embedder: freeinference /v1/embeddings with bge-m3. Key from keyring. */
export async function embedBgeM3(texts: string[]): Promise<number[][]> {
	if (texts.length === 0) return [];
	const key = await readKeyenv();
	const res = await fetch("https://freeinference.org/v1/embeddings", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(key ? { authorization: `Bearer ${key}` } : {}),
		},
		body: JSON.stringify({ model: "bge-m3", input: texts }),
	});
	if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const j = (await res.json()) as { data: Array<{ embedding: number[] }> };
	return j.data.map(d => d.embedding);
}

/** Resolve the FREEINFERENCE_API_KEY from keyring via secretsmith (SSOT). */
async function readKeyenv(): Promise<string | undefined> {
	if (process.env.FREEINFERENCE_API_KEY) return process.env.FREEINFERENCE_API_KEY;
	try {
		const { execFile } = await import("node:child_process");
		const out = await new Promise<string>((resolve, reject) => {
			execFile("/home/toxic/.local/bin/secretsmith", ["get", "--label", "FREEINFERENCE_API_KEY", "--show"], { timeout: 10000 }, (err, stdout) =>
				err ? reject(err) : resolve(stdout),
			);
		});
		const m = out.match(/secret:\s*(\S+)/);
		return m ? m[1] : undefined;
	} catch {
		return undefined;
	}
}

/** Condense a flat overlap report into a terse, model-promptable digest. */
export function overlapDigest(o: SemanticOverlap): string {
	const lines = [
		`corpus overlap: ${(o.corpusOverlap * 100).toFixed(1)}% over top-${o.topK} pairs (${o.aCount}×${o.bCount} files)`,
	];
	for (const p of o.pairs) {
		lines.push(`  ${(p.cosine * 100).toFixed(1)}%  ${p.a}  ↔  ${p.b}`);
	}
	return lines.join("\n");
}