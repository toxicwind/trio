import { expect, test } from "bun:test";
import { TrioKernel } from "../src/kernel.ts";

/**
 * Regression: the kernel VM context only exposed `{ console, process }`, so
 * `Bun`, `require`, and static ESM `import` all failed at runtime. Top-level
 * `import` now goes through the async IIFE as a published `await import(...)`.
 */

test("exposes Bun", async () => {
	const k = new TrioKernel({ name: "bun" });
	const r = await k.run("typeof Bun === 'object' && typeof Bun.file === 'function'");
	expect(r.ok).toBe(true);
	expect(r.value).toBe(true);
});

test("exposes require", async () => {
	const k = new TrioKernel({ name: "require" });
	const r = await k.run("const f = require('node:fs'); typeof f.readFileSync === 'function'");
	expect(r.ok).toBe(true);
	expect(r.value).toBe(true);
});

test("static ESM named import works", async () => {
	const k = new TrioKernel({ name: "esm-named" });
	const r = await k.run('import { join } from "node:path"; join("a", "b")');
	expect(r.ok).toBe(true);
	expect(r.value).toBe("a/b");
});

test("imported binding persists across cells", async () => {
	const k = new TrioKernel({ name: "esm-persist" });
	const first = await k.run('import { join } from "node:path"; typeof join');
	expect(first.ok).toBe(true);
	const second = await k.run("typeof join");
	expect(second.ok).toBe(true);
	expect(second.value).toBe("function");
});

test("default and namespace imports work", async () => {
	const k = new TrioKernel({ name: "esm-forms" });
	const d = await k.run('import path from "node:path"; typeof path.join');
	expect(d.value).toBe("function");
	const n = await k.run('import * as os from "node:os"; typeof os.platform');
	expect(n.value).toBe("function");
});

test("side-effect-only import does not throw", async () => {
	const k = new TrioKernel({ name: "esm-sideeffect" });
	const r = await k.run('import "node:path"; 1 + 1');
	expect(r.ok).toBe(true);
	expect(r.value).toBe(2);
});