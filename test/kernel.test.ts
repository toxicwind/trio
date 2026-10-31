import { describe, expect, test } from "bun:test";
import { TrioKernel } from "../src/kernel";
import type { TrioRunResult } from "../src/kernel";

/** All tests share one kernel per suite to prove cross-cell persistence. */
function freshKernel() {
  return new TrioKernel({ name: "test" });
}

describe("TrioKernel.run", () => {
  test("returns the final expression value", async () => {
    const kernel = freshKernel();
    const result = await kernel.run("1 + 1");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(2);
  });

  test("persists top-level let bindings across cells", async () => {
    const kernel = freshKernel();
    await kernel.run("let counter = 10");
    const result = await kernel.run("counter + 5");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(15);
  });

  test("persists top-level const and function declarations", async () => {
    const kernel = freshKernel();
    await kernel.run('const greet = (name) => `hi ${name}`; function double(n) { return n * 2; }');
    expect((await kernel.run('greet("tau")')).value).toBe("hi tau");
    expect((await kernel.run("double(21)")).value).toBe(42);
  });

  test("supports top-level await", async () => {
    const kernel = freshKernel();
    const result = await kernel.run("await Promise.resolve(7) * 6");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  test("captures console.log output to text", async () => {
    const kernel = freshKernel();
    const result = await kernel.run("console.log('hello'); 1");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("hello");
  });

  test("returns ok:false with error message on sync throw and survives", async () => {
    const kernel = freshKernel();
    await kernel.run("let survived = true");
    const result = await kernel.run("throw new Error('boom')");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
    // Kernel still usable; earlier binding intact.
    expect((await kernel.run("survived")).value).toBe(true);
  });

  test("returns ok:false on rejected promise", async () => {
    const kernel = freshKernel();
    const result = await kernel.run("await Promise.reject(new Error('nope'))");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nope");
  });

  test("keeps bindings from cells after an error cell", async () => {
    const kernel = freshKernel();
    await kernel.run("const before = 'kept'");
    await kernel.run("throw new Error('x')");
    expect((await kernel.run("before")).value).toBe("kept");
  });
});

describe("TrioKernel.reset", () => {
  test("drops user bindings, keeps kernel usable", async () => {
    const kernel = freshKernel();
    await kernel.run("let state = 'stale'");
    const reset = await kernel.reset();
    expect(reset.ok).toBe(true);
    const result = await kernel.run("typeof state");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("undefined");
  });
});

describe("TrioKernel.status", () => {
  test("tracks cells run and failures", async () => {
    const kernel = freshKernel();
    await kernel.run("1");
    await kernel.run("throw new Error('x')");
    await kernel.run("2");
    const status = kernel.status();
    expect(status.cells).toBe(3);
    expect(status.failures).toBe(1);
    expect(status.name).toBe("test");
  });
});

describe("TrioKernel output helper equal to display", () => {
  test("final expression of a multi-statement cell returns last value", async () => {
    const kernel = freshKernel();
    const result = await kernel.run("const a = 2; const b = 3; a * b");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(6);
  });

  test("undefined final expression yields value undefined and ok true", async () => {
    const kernel = freshKernel();
    const result = await kernel.run("let x = 1");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(undefined);
  });

	describe("host integration (TDD 2026-10-30)", () => {
		test("supports dynamic import inside cells (node: modules)", async () => {
			const kernel = new TrioKernel({ name: "dynimport" });
			const r = await kernel.run("const os = await import('node:os'); os.platform().length > 0 ? 'platform-ok' : 'none'");
			expect(r.ok, r.error ?? r.text).toBe(true);
			expect(r.value).toBe("platform-ok");
			const r2 = await kernel.run("typeof os.EOL") // EOL survives? no: block scope — but import fn check
				;
			expect(r2.ok, r2.error ?? r2.text).toBe(true);
		});

		test("supports top-level interplay: dynamic import result persists to next cell", async () => {
			const kernel = new TrioKernel({ name: "dynpersist" });
			const r1 = await kernel.run("const { tmpdir } = await import('node:os'); tmpdir().length > 0");
			expect(r1.ok, r1.error ?? r1.text).toBe(true);
			expect(r1.value).toBe(true);
			const r2 = await kernel.run("typeof tmpdir");
			expect(r2.ok, r2.error ?? r2.text).toBe(true);
			expect(r2.value).toBe("function");
		});

		test("exposes process for env/cwd introspection", async () => {
			const kernel = new TrioKernel({ name: "process" });
			const r = await kernel.run("typeof process === 'object' && typeof process.cwd === 'function'");
			expect(r.ok, r.error ?? r.text).toBe(true);
			expect(r.value).toBe(true);
		});
	});

});