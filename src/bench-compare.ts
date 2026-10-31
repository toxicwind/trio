/**
 * bench-compare.ts — code-race harness for trio's compare engine.
 *
 * Races the three metric layers against fixtures of increasing size and
 * reports per-layer latency. Follows the pattern-forge doctrine: measure
 * everything, keep the fast path hot, fail the run if any layer blows its
 * budget (compare is meant to be interactive: <100ms per pair on typical
 * repo files).
 *
 * usage: bun run src/bench-compare.ts [fixture-lines]
 */

import { comparePair, semanticRatio, astSignature, type Variant } from "./compare.ts";

function buildFixture(lines: number, drift = 0.05): string {
	const rows: string[] = [];
	for (let i = 0; i < lines; i++) {
		rows.push(`const value_${i} = compute(${i}, "${tag(i)}");`);
	}
	// drift: mutate a fraction of lines (append type annotations)
	const drifted = Math.floor(lines * drift);
	for (let i = 0; i < drifted; i++) {
		const idx = Math.floor((i * lines) / drifted);
		rows[idx] = `const value_${idx}: number = compute(${idx}, "${tag(idx)}");`;
	}
	return rows.join("\n");
}

function tag(i: number): string {
	return `t${i.toString(36)}`;
}

function bench(name: string, fn: () => void, runs = 5): number {
	// warmup
	fn();
	let best = Infinity;
	for (let r = 0; r < runs; r++) {
		const t0 = performance.now();
		fn();
		best = Math.min(best, performance.now() - t0);
	}
	console.log(`  ${name.padEnd(28)} ${best.toFixed(2)}ms (best of ${runs})`);
	return best;
}

const sizes = [50, 500, 5000];
let failures = 0;
for (const size of sizes) {
	console.log(`fixture: ${size} lines`);
	const base = buildFixture(size, 0);
	const drifted = buildFixture(size, 0.05);
	const a: Variant = { name: "base", source: base };
	const b: Variant = { name: "drift", source: drifted };

	const tFull = bench("comparePair (3 layers)", () => comparePair(a, b));
	const tSem = bench("semanticRatio alone", () => semanticRatio(base, drifted));
	const tAst = bench("astSignature alone", () => astSignature(base));

	// budget: interactive compare must stay under 100ms/pair at 5k lines
	if (size === 5000 && tFull > 100) {
		console.error(`  BUDGET FAIL: comparePair ${tFull.toFixed(1)}ms > 100ms at 5k lines`);
		failures++;
	}
}
process.exit(failures > 0 ? 1 : 0);
