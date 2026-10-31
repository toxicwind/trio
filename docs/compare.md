# trio compare — algorithmic variant comparison

Three metric layers over N source variants, composed as a Kleisli-style
pipeline (`Result`-valued steps, errors as values, no throws in the hot path):

| layer | function | what it measures | cost |
|---|---|---|---|
| token | `fnv1a`-hashed line shingles → Jaccard | surface vocabulary drift | O(n) |
| ast | `astSignature` (imports, functions, calls, literals) → Jaccard | structural drift, quote/whitespace-normalized | O(n) |
| semantic | Myers-style O(ND) line diff → `2·LCS/(n+m)` | line-level edit distance + **categorized diff** | O(ND) |

## API

```ts
import { compare, comparePair } from "src/compare.ts";

// full matrix for N variants
const report = compare([
  { name: "canon", source: canonSource },
  { name: "fork", source: forkSource },
]);
// → { variants, pairs, identicalGroups, canonicalGuess }
//    canonicalGuess = most-central variant (highest mean semantic ratio)

// single pair with categorized changedLines
const p = comparePair(a, b);
// p.changedLines: { kind: "import-alias" | "type-annotation"
//                 | "modified" | "removed" | "added", a?, b? }[]
```

## Diff guarantees (TDD-pinned, test/compare.test.ts)

- **No phantom del/add pairs**: identical normalized lines are never emitted as
  remove+add around a neighboring edit — del-runs and add-runs between matches
  are paired positionally into one change entry.
- **Classified drift**: path-alias swaps (`#/x` ↔ `@/x`) → `import-alias`;
  lines differing only by a `: type` segment (whitespace-collapsed) →
  `type-annotation`; everything else → `modified`.
- **Truncated variants** (stub files ending mid-token) diverge strongly
  (semantic < 0.7) and never break the walk.
- **Canonical guess**: with one canon + one fork + one far-diverged variant,
  the guess is the canon; with two forks clustering, the guess is the most
  central (verified: central ≠ canon in that shape).

## Performance (code-race bench, src/bench-compare.ts)

best-of-5, shared u32-hashed DP between semantic ratio and diff walk:

| lines | comparePair (3 layers) | semanticRatio | astSignature |
|---|---|---|---|
| 50 | 0.42 ms | 0.08 ms | 0.07 ms |
| 500 | 5.0 ms | 1.7 ms | 0.4 ms |
| 5000 | 94.8 ms | 49.6 ms | 4.7 ms |

Budget: <100 ms at 5k lines (met). Optimizations that landed:
u32 line-hash DP cells (was string-compare), shared DP between the ratio and
the walk, prefix/suffix skip (no effect on uniform drift, kept — free on
real-world clones).

## Wire protocol

`{"op":"compare","variants":[["name","src"],...]}` over trio serve / unix
socket; CLI: `trio compare <fixtures.json>`. Benchmark data consumed by the
agentic-moment-2026 compare page (github.io, opt-in for that product).
