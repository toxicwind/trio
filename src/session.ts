import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { TrioStatus } from "./kernel.ts";
import type { StdioRequest, StdioResponse } from "./server.ts";

const TRIO_CACHE_DIR = path.join(os.homedir(), ".cache", "trio");

function socketPath(name: string): string {
	return path.join(TRIO_CACHE_DIR, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.sock`);
}

function safeName(name: string): string {
	return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Spawn the session daemon (a `serve` process whose kernel listens on a unix
 * socket) and wait until it is accepting connections. Detached so it survives
 * the CLI invocation that created it.
 */
async function spawnSessionDaemon(name: string): Promise<void> {
	const sock = socketPath(name);
	fs.mkdirSync(TRIO_CACHE_DIR, { recursive: true });
	try {
		fs.rmSync(sock, { force: true });
	} catch {
		// stale socket missing anyway
	}
	const child = spawn(
		process.execPath,
		[path.join(import.meta.dir, "..", "bin", "trio.ts"), "--session", safeName(name), "serve"],
		{
			detached: true,
			stdio: "ignore",
			env: { ...process.env, TRIO_SOCKET: sock },
		},
	);
	child.unref();
	// Wait for the socket to accept (deadline 3s).
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (fs.existsSync(sock)) {
			const probe = await tryConnectOnce(sock);
			if (probe) return;
		}
		await new Promise<void>(resolve => setTimeout(resolve, 25));
	}
	throw new Error(`trio session ${name} did not start (socket ${sock})`);
}

function tryConnectOnce(sock: string): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.connect(sock);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

/** One JSON-line request over the session socket; resolves with the reply. */
function requestOnce(sock: string, payload: StdioRequest): Promise<StdioResponse> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(sock);
		let buffer = "";
		const done = (fn: () => void) => {
			socket.destroy();
			fn();
		};
		socket.setTimeout(60_000);
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("data", chunk => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			try {
				const parsed = JSON.parse(line) as StdioResponse;
				done(() => resolve(parsed));
			} catch {
				done(() => reject(new Error(`invalid response from trio session: ${line.slice(0, 200)}`)));
			}
		});
		socket.on("error", error => done(() => reject(error)));
		socket.on("timeout", () => done(() => reject(new Error("trio session request timed out"))));
	});
}

async function sessionRequest(name: string, payload: StdioRequest): Promise<StdioResponse> {
	const sock = socketPath(safeName(name));
	const alive = await tryConnectOnce(sock);
	if (!alive) await spawnSessionDaemon(safeName(name));
	return await requestOnce(sock, payload);
}

export interface SessionCliResult {
	ok: boolean;
	value?: unknown;
	text?: string;
	error?: string;
}

export async function sessionRun(name: string, code: string): Promise<SessionCliResult> {
	const result = await sessionRequest(name, { op: "run", code });
	return { ok: result.ok, value: result.value, text: result.text, error: result.error };
}

export async function sessionReset(name: string): Promise<SessionCliResult> {
	const result = await sessionRequest(name, { op: "reset" });
	return { ok: result.ok, error: result.error };
}

export async function sessionStatus(name: string): Promise<SessionCliResult & { status?: TrioStatus }> {
	const result = await sessionRequest(name, { op: "status" });
	return { ok: result.ok, status: result.value as TrioStatus | undefined };
}