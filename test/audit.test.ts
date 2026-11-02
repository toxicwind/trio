import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeReadTrioAudit, primarySymbol, searchAst, searchLsp, searchBm25 } from "../src/audit.ts";

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "trio-audit-"));
	// Reference + declaration of the same symbol across two files so the ref
	// channel must return BOTH, and filler words in a padded query must not
	// dominate the result.
	writeFileSync(
		join(dir, "engine.ts"),
		[
			`export function startBunStdinPump(onChunk: (c: Buffer) => void) {`,
			`  return { stop() {} };`,
			`}`,
			``,
		].join("\n"),
	);
	writeFileSync(
		join(dir, "app.ts"),
		[
			`import { startBunStdinPump } from "./engine";`,
			`const pump = startBunStdinPump(() => {}); // reference use-site`,
			`export { pump };`,
			``,
		].join("\n"),
	);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("primarySymbol", () => {
	test("extracts the longest real identifier from a padded query", () => {
		expect(primarySymbol("startBunStdinPump definition and call sites")).toBe("startBunStdinPump");
	});
	test("returns undefined for a pure-stopword query", () => {
		expect(primarySymbol("definition and call sites")).toBeUndefined();
	});
});

describe("searchLsp", () => {
	test("returns declaration AND reference lines (not decl-only)", async () => {
		const hits = await searchLsp(dir, "startBunStdinPump");
		const decl = hits.find((h) => h.snippet.includes("export function"));
		const ref = hits.find((h) => h.snippet.includes("const pump ="));
		expect(decl).toBeTruthy();
		expect(ref).toBeTruthy();
	});
	test("attaches a 3-line context band", async () => {
		const hits = await searchLsp(dir, "startBunStdinPump");
		expect(hits.some((h) => h.context && h.context.length >= 1)).toBe(true);
	});
});

describe("searchBm25", () => {
	test("symbol-anchors: filler words do not surface unrelated lines", async () => {
		writeFileSync(join(dir, "noise.md"), "definitions and calls are documented sites\n");
		const hits = await searchBm25(dir, "startBunStdinPump definition and call sites");
		expect(hits.every((h) => h.snippet.includes("startBunStdinPump"))).toBe(true);
	});
});

describe("executeReadTrioAudit", () => {
	test("anchors the needle on the symbol and persists untruncated artifacts", async () => {
		const result = await executeReadTrioAudit("startBunStdinPump definition and call sites", dir, 20);
		expect(result.symbol).toBe("startBunStdinPump");
		expect(result.stats.lsp).toBeGreaterThanOrEqual(2); // decl + ref
		expect(result.artifacts).not.toBeNull();
		expect(existsSync(result.artifacts!.files[0].path)).toBe(true);
		const persisted = JSON.parse(readFileSync(result.artifacts!.files[1].path, "utf8"));
		expect(persisted.count).toBe(result.stats.lsp);
	});
});
