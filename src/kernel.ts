import * as vm from "node:vm";
import { Writable } from "node:stream";
import { Console } from "node:console";
import type { ParserPlugin } from "@babel/parser";

let babelParser: typeof import("@babel/parser") | undefined;

async function loadBabelParser(): Promise<typeof import("@babel/parser")> {
	if (!babelParser) {
		babelParser = await import("@babel/parser");
	}
	return babelParser;
}

const PARSE_PLUGINS: ParserPlugin[] = ["typescript"];

interface ParsedProgram {
	body: ReadonlyArray<Record<string, any>>;
}

async function parseProgram(code: string): Promise<ParsedProgram | null> {
	const { parse } = await loadBabelParser();
	try {
		const ast = parse(code, {
			sourceType: "script",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			errorRecovery: true,
			plugins: PARSE_PLUGINS,
		}) as unknown as { program: ParsedProgram };
		return ast.program;
	} catch {
		return null;
	}
}

function isExecutionBoundary(type: string): boolean {
	return (
		type === "FunctionDeclaration" ||
		type === "FunctionExpression" ||
		type === "ArrowFunctionExpression" ||
		type === "ObjectMethod" ||
		type === "ClassMethod" ||
		type === "ClassPrivateMethod" ||
		type === "PrivateMethod"
	);
}

/** Top-level `await`, top-level `return`, or `for await` forces the async wrapper. */
function containsAsyncWrapperSyntax(node: unknown): boolean {
	if (!node || typeof node !== "object") return false;
	if (Array.isArray(node)) return node.some(containsAsyncWrapperSyntax);
	const record = node as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : "";
	if (type === "ReturnStatement" || type === "AwaitExpression") return true;
	if (type === "ForOfStatement" && record.await === true) return true;
	if (typeof type === "string" && isExecutionBoundary(type)) return false;
	for (const key in record) {
		if (key === "loc" || key === "extra" || key === "range") continue;
		if (containsAsyncWrapperSyntax(record[key])) return true;
	}
	return false;
}

/**
 * Rewrite top-level declarations so they survive the async IIFE. The wrapper
 * has its own function scope, so `let`/`const`/`class` inside it would die with
 * the cell and bare references in later cells would fail. Publishing them as
 * assignments to the worker global object (`this[name] = ...`) keeps the
 * binding live: the vm context's global object is in the scope chain of every
 * subsequent script, so bare `name` references resolve it.
 *
 * Function declarations are installed at wrapper entry to preserve hoisting;
 * assignments run in source order. Pattern declarators use the plain
 * assignment form (sloppy-mode global assignment), mirroring tau's rewrite.
 */
function globalizeTopLevelDeclarations(code: string, body: ReadonlyArray<Record<string, any>>): string {
	const functions: string[] = [];
	const edits: Array<{ start: number; end: number; replacement: string }> = [];
	for (const node of body) {
		const type = node.type;
		if (type === "VariableDeclaration") {
			const statements: string[] = [];
			for (const declaration of node.declarations ?? []) {
				if (!declaration.init) continue;
				const id = code.slice(declaration.id.start, declaration.id.end);
				const value = code.slice(declaration.init.start, declaration.init.end);
				if (declaration.id.type === "Identifier" && typeof declaration.id.name === "string") {
					statements.push(`this[${JSON.stringify(declaration.id.name)}] = (${value});`);
				} else {
					statements.push(`(${id} = (${value}));`);
				}
			}
			edits.push({ start: node.start, end: node.end, replacement: statements.join("\n") });
			continue;
		}
		if (type === "FunctionDeclaration" && node.id) {
			const idStart = node.id.start - node.start;
			const idEnd = node.id.end - node.start;
			const segment = code.slice(node.start, node.end);
			const expression = segment.slice(0, idStart) + segment.slice(idEnd);
			functions.push(`this[${JSON.stringify(node.id.name)}] = (${expression});`);
			edits.push({ start: node.start, end: node.end, replacement: "" });
			continue;
		}
		if (type === "ClassDeclaration" && node.id) {
			const segment = code.slice(node.start, node.end);
			edits.push({
				start: node.start,
				end: node.end,
				replacement: `this[${JSON.stringify(node.id.name)}] = (${segment});`,
			});
		}
	}

	// Apply the final-expression rewrite as a same-basis edit: `code` must stay
	// the ORIGINAL cell source here so every offset in `body` stays valid across
	// both transforms. Any string mutation before this point would shift them.
	const lastIndex = (() => {
		let index = body.length - 1;
		while (index >= 0 && body[index]?.type === "EmptyStatement") index--;
		return index;
	})();
	const last = lastIndex >= 0 ? body[lastIndex] : undefined;
	if (last?.type === "ExpressionStatement") {
		const statement = code.slice(last.start, last.end);
		const semicolonMatch = statement.match(/;\s*$/);
		const trimmed =
			semicolonMatch && semicolonMatch.index !== undefined
				? statement.slice(0, semicolonMatch.index)
				: statement;
		edits.push({ start: last.start, end: last.end, replacement: `return (${trimmed});` });
	}

	edits.sort((left, right) => right.start - left.start);
	let result = code;
	for (const edit of edits) {
		result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
	}
	return `${functions.join("\n")}\n${result}`;
}

export interface TrioRunResult {
	ok: boolean;
	value: unknown;
	text: string;
	error?: string;
}

export interface TrioStatus {
	name: string;
	cells: number;
	failures: number;
}

export interface TrioKernelOptions {
	/** Session name; purely a label surfaced by `status()`. */
	name?: string;
}

/**
 * Persistent Bun notebook kernel. Each `run()` cell executes against the same
 * vm context, so top-level `let`/`const`/`class`/`function` bindings persist
 * across cells inside a session. Top-level `await` cells run through an async
 * IIFE whose declarations are published onto the global object first.
 */
export class TrioKernel {
	readonly name: string;
	#context: vm.Context;
	#cells = 0;
	#failures = 0;
	#buffer: string[] = [];
	#console: Console;

	constructor(options: TrioKernelOptions = {}) {
		this.name = options.name ?? "trio";
		const sink = new Writable({
			write: (chunk, _enc, callback) => {
				this.#buffer.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
				callback();
			},
		});
		this.#console = new Console({ stdout: sink, stderr: sink, colorMode: false });
		this.#context = this.#freshContext();
	}

	#freshContext(): vm.Context {
		return vm.createContext({ console: this.#console, process });
	}

	async run(code: string): Promise<TrioRunResult> {
		this.#cells++;
		this.#buffer = [];
		try {
			const wrapped = await this.#wrap(code);
			let value: unknown = vm.runInContext(wrapped.source, this.#context, {
				filename: `cell-${this.#cells}.js`,
				// Host dynamic imports: cells may `await import('node:os')` etc.
				// without a callback the vm throws "A dynamic import callback was not
				// specified". Resolve through import() so node: builtins and any
				// package reachable from the kernel's own graph both work.
				importModuleDynamically: (specifier: string) => import(specifier),
			});
			value = await value; // completion value, or the async wrapper's promise
			return { ok: true, value, text: this.#buffer.join("") };
		} catch (error) {
			this.#failures++;
			const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
			return { ok: false, value: undefined, text: this.#buffer.join(""), error: message };
		}
	}

	async #wrap(code: string): Promise<{ source: string }> {
		const program = await parseProgram(code);
		if (!program) {
			// Parser bailed (unrecoverable syntax) — the vm surfaces the real error.
			return { source: code };
		}
		const body = program.body;
		// Without top-level await/return the vm context already persists lexical
		// bindings across runInContext calls, so pass the source through untouched.
		if (!body.some(containsAsyncWrapperSyntax)) {
			return { source: code };
		}
		const globalized = globalizeTopLevelDeclarations(code, body);
		return { source: `(async () => {\n${globalized}\n})()` };
	}

	async reset(): Promise<{ ok: boolean; error?: string }> {
		try {
			this.#context = this.#freshContext();
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	status(): TrioStatus {
		return { name: this.name, cells: this.#cells, failures: this.#failures };
	}
}