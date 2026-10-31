import { describe, test, expect } from "bun:test";
import { cosine, semanticOverlap, overlapDigest, type EmbedFetcher } from "../src/semantic.ts";

// ── cosine (pure math) ──────────────────────────────────────────────────
describe("cosine similarity", () => {
  test("identical vectors → 1", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBe(1);
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 9);
  });

  test("orthogonal vectors → 0", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  test("opposite vectors → -1", () => {
    expect(cosine([1, 0], [-1, 0])).toBe(-1);
  });

  test("zero vector → 0 (guard)", () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosine([1, 2], [0, 0])).toBe(0);
  });

  test("mismatched lengths → 0", () => {
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
  });

  test("scaled vector is cosine-similar", () => {
    // (1,2,3) · (10,20,30) → cosine 1 (colinear)
    expect(cosine([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 9);
  });
});

// ── semanticOverlap (fake embedder, deterministic) ─────────────────────
function dim(number: number): EmbedFetcher {
  // Injects a deterministic embedding per index; the SAME index number across
  // corpora maps to a colinear vector, different numbers to orthogonal.
  return async (texts: string[]) =>
    texts.map((_, i) => {
      const v = new Array(number).fill(0);
      v[i % number] = 1; // one-hot by position → identical positions are colinear
      return v;
    });
}

describe("semanticOverlap", () => {
  test("identical-position files rank highest under one-hot embedding", async () => {
    const a = [
      { path: "x/alpha.ts", text: "aaa" },
      { path: "x/beta.ts", text: "bbb" },
    ];
    const b = [
      { path: "y/alpha.ts", text: "aaa" },
      { path: "y/gamma.ts", text: "ggg" },
    ];
    const o = await semanticOverlap(a, b, { embedFn: dim(2), maxPerSide: 2, maxPairs: 4 });
    // pair a=x/alpha.ts ↔ b=y/alpha.ts (both one-hot col 0) must top-rank
    expect(o.pairs[0].a).toBe("x/alpha.ts");
    expect(o.pairs[0].b).toBe("y/alpha.ts");
    expect(o.pairs[0].cosine).toBe(1);
    expect(o.corpusOverlap).toBeGreaterThan(0);
    expect(o.aCount).toBe(2);
    expect(o.bCount).toBe(2);
  });

  test("empty corpus → zero overlap, no crash", async () => {
    const o = await semanticOverlap([], [{ path: "a", text: "x" }], { embedFn: dim(2) });
    expect(o.pairs).toEqual([]);
    expect(o.corpusOverlap).toBe(0);
  });

  test("maxPerSide bounds the embedded window (stable, path-ordered)", async () => {
    const mk = (n: number, side: string) =>
      Array.from({ length: n }, (_, i) => ({ path: `${side}/${String(i).padStart(3, "0")}.ts`, text: `content ${i}` }));
    const o = await semanticOverlap(mk(10, "a"), mk(10, "b"), { embedFn: dim(3), maxPerSide: 3, maxPairs: 3 });
    // only 3×3 = 9 raw pairs → ≤3 kept
    expect(o.pairs.length).toBeLessThanOrEqual(3);
    // deterministic: first file of each side wins (both idx 0 colinear)
    expect(o.pairs[0].a).toBe("a/000.ts");
    expect(o.pairs[0].b).toBe("b/000.ts");
  });
});

// ── overlapDigest (prose prompt input) ──────────────────────────────────
describe("overlapDigest", () => {
  test("renders digest with overlap % and ranked pairs", () => {
    const o = { pairs: [{ a: "a.ts", b: "b.ts", cosine: 0.9 }], corpusOverlap: 0.9, topK: 1, aCount: 2, bCount: 2 };
    const d = overlapDigest(o);
    expect(d).toContain("90.0%");
    expect(d).toContain("a.ts");
    expect(d).toContain("b.ts");
    expect(d).toContain("↔");
  });

  test("empty overlap → digest shows 0%", () => {
    const d = overlapDigest({ pairs: [], corpusOverlap: 0, topK: 0, aCount: 0, bCount: 0 });
    expect(d).toContain("0.0%");
  });
});

// ── live roundtrip (needs key + network; skip gracefully without) ──────
describe("live bge-m3 embed", () => {
  test("freeinference embed returns same-dim vectors", async () => {
    if (!process.env.FREEINFERENCE_API_KEY && !process.env.XERJ_TEST_SKIP_LIVE) {
      // try keyring; if unavailable, skip quietly
      const { existsSync } = await import("node:fs");
      if (!existsSync("/home/toxic/.local/bin/secretsmith")) return;
    }
    const { embedBgeM3 } = await import("../src/semantic.ts");
    const vs = await embedBgeM3(["one", "two"]);
    expect(vs.length).toBe(2);
    expect(vs[0].length).toBeGreaterThan(100); // bge-m3 is 1024-d
    expect(vs[0].length).toBe(vs[1].length);
  }, 30000);
});