import { describe, test, expect } from "bun:test";
import { compare, comparePair, astSignature, semanticRatio, fnv1a } from "../src/compare.ts";

const CANON = `import { createFileRoute } from '@tanstack/react-router'
import { chat, maxIterations, toServerSentEventsResponse } from '@tanstack/ai'
import { geminiText } from '@tanstack/ai-gemini'
import { ollamaText } from '@tanstack/ai-ollama'
import {
  getSpeakerBySlug,
} from '#/lib/conference-tools'

export const Route = createFileRoute('/api/remy-chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const requestSignal = request.signal
        let provider = 'ollama'
        let model = 'mistral:7b'
        return new Response(null)
      },
    },
  },
})
`;

const FORK = CANON.replace("#/lib/conference-tools", "@/lib/conference-tools")
	.replace("let provider = 'ollama'", "let provider: string = 'ollama'")
	.replace("let model = 'mistral:7b'", "let model: string = 'mistral:7b'");

describe("compare", () => {
	test("identical sources → all metrics 1", () => {
		const r = compare([
			{ name: "a", source: CANON },
			{ name: "b", source: CANON },
		]);
		expect(r.pairs[0].tokenJaccard).toBe(1);
		expect(r.pairs[0].astJaccard).toBe(1);
		expect(r.pairs[0].semanticRatio).toBe(1);
		expect(r.identicalGroups).toEqual([["a", "b"]]);
	});

	test("import-alias + type-annotation drift detected and classified", () => {
		const p = comparePair({ name: "canon", source: CANON }, { name: "fork", source: FORK });
		// Truth (side-by-side verified): 3 changed lines — 1 import-alias, 2
		// type-annotations. Diff must not emit phantoms around them.
		expect(p.semanticRatio).toBeGreaterThan(0.8);
		expect(p.changedLines.length).toBe(3);
		const kinds = p.changedLines.map(c => c.kind);
		expect(kinds.filter(k => k === "import-alias").length).toBe(1);
		expect(kinds.filter(k => k === "type-annotation").length).toBe(2);
	});

	test("empty source handles gracefully", () => {
		expect(semanticRatio("", "")).toBe(1);
		expect(astSignature("").size).toBe(0);
		expect(fnv1a("")).toBe("811c9dc5");
	});

	test("canonical guess picks most-central variant", () => {
		const r = compare([
			{ name: "c", source: CANON },
			{ name: "f1", source: FORK },
			{ name: "far", source: CANON.replace(/.+/g, "// diverged") },
		]);
		// most-central = highest mean semantic ratio to all others
		expect(r.canonicalGuess).toBe("c");
	});

	test("stub (truncated) variant diverges strongly", () => {
		const stub = CANON.slice(0, 200);
		const p = comparePair({ name: "full", source: CANON }, { name: "stub", source: stub });
		expect(p.semanticRatio).toBeLessThan(0.6);
		expect(p.tokenJaccard).toBeLessThan(0.4);
	});
});
