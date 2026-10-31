import * as fs from "node:fs";
import * as path from "node:path";
import type { TreeFileEntry } from "./compare.ts";

const SKIP_DIRS = new Set([
	"node_modules", ".git", "target", "dist", "build",
	"bazel-out", "bazel-bin", "bazel-tau", ".cache",
]);
const MAX_BYTES = 512 * 1024;
const MAX_DEPTH = 6;

/**
 * Walk a directory collecting text files as {path, source}. Bounded:
 * skips VCS/build/vendor dirs, dotfiles (except .github), blobs >512KB,
 * and binary content (NUL byte in the first 1KB). Pure stdlib deps.
 */
export function walkTree(root: string): TreeFileEntry[] {
	const out: TreeFileEntry[] = [];
	const visit = (dir: string, rel: string, depth: number): void => {
		if (depth > MAX_DEPTH) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (e.name.startsWith(".") && e.name !== ".github") continue;
			if (SKIP_DIRS.has(e.name)) continue;
			const full = path.join(dir, e.name);
			const relPath = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				visit(full, relPath, depth + 1);
			} else if (e.isFile() && collectable(full)) {
				try {
					out.push({ path: relPath, source: fs.readFileSync(full, "utf8") });
				} catch { /* unreadable: skip */ }
			}
		}
	};
	visit(root, "", 0);
	return out;
}

function collectable(full: string): boolean {
	try {
		const st = fs.statSync(full);
		if (st.size > MAX_BYTES || st.size === 0) return false;
		const fd = fs.openSync(full, "r");
		try {
			const head = Buffer.alloc(1024);
			const read = fs.readSync(fd, head, 0, 1024, 0);
			return !head.subarray(0, read).includes(0);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}
