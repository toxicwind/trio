import { createInterface } from "node:readline";
import * as net from "node:net";
import * as fs from "node:fs";
import { TrioKernel } from "./kernel.ts";
import { compare, type Variant } from "./compare.ts";

export interface StdioRequest {
	id?: unknown;
	op: string;
	code?: string;
	variants?: Array<{ name: string; source: string }>;
}

export interface StdioResponse {
	id?: unknown;
	ok: boolean;
	value?: unknown;
	text?: string;
	error?: string;
}

async function handleRequest(kernel: TrioKernel, request: StdioRequest): Promise<StdioResponse> {
	if (request.op === "run" && typeof request.code === "string") {
		const result = await kernel.run(request.code);
		return {
			id: request.id,
			ok: result.ok,
			value: result.value,
			text: result.text,
			...(result.error !== undefined ? { error: result.error } : {}),
		};
	}
	if (request.op === "reset") {
		const result = await kernel.reset();
		return { id: request.id, ok: result.ok, error: result.error };
	}
	if (request.op === "status") {
		return { id: request.id, ok: true, value: kernel.status() };
	}
	if (request.op === "compare" && Array.isArray(request.variants)) {
		try {
			const report = compare(request.variants as Variant[]);
			return { id: request.id, ok: true, value: report };
		} catch (e) {
			return { id: request.id, ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}
	return { id: request.id, ok: false, error: `unknown op: ${request.op}` };
}

function writeLine(stream: NodeJS.WritableStream, response: StdioResponse): void {
	stream.write(`${JSON.stringify(response)}\n`);
}

/**
 * Serve one kernel over newline-delimited JSON. With `TRIO_SOCKET` set the
 * server listens on that unix socket (one connection at a time, sequential
 * handling so kernel state is never raced); otherwise it serves stdin/stdout.
 */
export async function runStdioServer(kernel: TrioKernel): Promise<void> {
	const socketPath = process.env.TRIO_SOCKET;
	if (socketPath) {
		fs.rmSync(socketPath, { force: true });
		const server = net.createServer(socket => {
			const rl = createInterface({ input: socket, crlfDelay: Infinity });
			void (async () => {
				for await (const line of rl) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					let request: StdioRequest;
					try {
						request = JSON.parse(trimmed) as StdioRequest;
					} catch {
						writeLine(socket, { ok: false, error: "invalid JSON" });
						continue;
					}
					writeLine(socket, await handleRequest(kernel, request));
				}
				socket.end();
			})();
		});
		server.listen(socketPath);
		await new Promise<void>(resolve => server.once("close", resolve));
		return;
	}

	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let request: StdioRequest;
		try {
			request = JSON.parse(trimmed) as StdioRequest;
		} catch {
			writeLine(process.stdout, { ok: false, error: "invalid JSON" });
			continue;
		}
		writeLine(process.stdout, await handleRequest(kernel, request));
	}
}