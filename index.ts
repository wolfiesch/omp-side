/**
 * omp-side — Codex-desktop-style `/side` for OMP running inside cmux.
 *
 *   /side why would the cache miss here?      fork now, ask in a split beside this pane
 *   /side --model @slow -- second opinion?    fork into a different model
 *   /side --bg --pull -- audit the plan       background split; first answer comes back to me
 *   /side --tab -- long tangent               fork into its own cmux tab instead of a split
 *   alt+s                                     empty fork in a side split, focused
 *
 * The fork is a real `omp --fork <session.jsonl>` process: full transcript up to the
 * current point, its own session file, `parentSession` recorded for lineage. Nothing the
 * side session does can touch this conversation unless you pass `--pull`.
 */

import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

const SPAWN_ENTRY = "omp-side.spawn";
const POLL_MS = 750;
const DISCOVER_LIMIT_MS = 60_000;
const PULL_LIMIT_MS = 30 * 60_000;
const CMUX_TIMEOUT_MS = 15_000;

type Direction = "right" | "left" | "up" | "down";

interface SideRequest {
	focus: boolean;
	tab: boolean;
	pull: boolean;
	direction: Direction;
	ompArgs: string[];
	prompt: string;
}

/** POSIX single-quote escaping; the pane runs the string under `/bin/sh -c`. */
function shQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Quote-aware whitespace split, used only for the flag section before `--`. */
function tokenize(input: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let quoted = false;
	for (const ch of input) {
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			quoted = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current || quoted) {
				out.push(current);
				current = "";
				quoted = false;
			}
			continue;
		}
		current += ch;
	}
	if (current || quoted) out.push(current);
	return out;
}

function parseRequest(raw: string): SideRequest {
	const request: SideRequest = {
		focus: true,
		tab: false,
		pull: false,
		direction: "right",
		ompArgs: [],
		prompt: "",
	};
	const text = raw.trim();
	if (!text) return request;

	// `--` separates flags from the prompt. Without it, a leading `-` means the whole
	// argument string is flags (open an empty fork) and anything else is the prompt.
	const separator = text.search(/(^|\s)--(\s|$)/);
	let head = "";
	if (separator === -1) {
		if (text.startsWith("-")) head = text;
		else request.prompt = text;
	} else {
		head = text.slice(0, separator);
		request.prompt = text.slice(separator).replace(/^\s*--/, "").trim();
	}

	for (const token of tokenize(head)) {
		switch (token) {
			case "--bg":
			case "--no-focus":
				request.focus = false;
				break;
			case "--focus":
				request.focus = true;
				break;
			case "--tab":
				request.tab = true;
				break;
			case "--pull":
				request.pull = true;
				break;
			case "--right":
			case "--left":
			case "--up":
			case "--down":
				request.direction = token.slice(2) as Direction;
				break;
			default:
				request.ompArgs.push(token);
		}
	}
	return request;
}

/** The running binary when it is the omp executable, else the first omp on PATH. */
function resolveOmp(): string {
	for (const candidate of [process.argv[0], process.execPath]) {
		if (candidate && basename(candidate).toLowerCase() === "omp") return candidate;
	}
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, "omp");
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// keep looking
		}
	}
	return "omp";
}

async function cmux(pi: ExtensionAPI, args: string[]): Promise<string> {
	const result = await pi.exec("cmux", args, { timeout: CMUX_TIMEOUT_MS });
	if (result.code !== 0) {
		throw new Error(`cmux ${args[0]}: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
	}
	return result.stdout.trim();
}

function paneTitle(prompt: string): string {
	const flat = prompt.replace(/\s+/g, " ").trim();
	if (!flat) return "⑂ side";
	return `⑂ ${flat.length <= 40 ? flat : `${flat.slice(0, 39)}…`}`;
}

function assistantText(line: string): string | null {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return null;
	}
	if (!entry || typeof entry !== "object") return null;
	const record = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
	if (record.type !== "message" || record.message?.role !== "assistant") return null;
	const content = record.message.content;
	if (typeof content === "string") return content.trim() || null;
	if (!Array.isArray(content)) return null;
	const text = content
		.filter((part): part is { type: string; text: string } => {
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate?.type === "text" && typeof candidate.text === "string";
		})
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text || null;
}

/**
 * Watch for the fork this spawn created and hand its first answer back as hidden
 * next-turn context. One-shot: the watcher stops after the first delivery.
 */
function watchFork(pi: ExtensionAPI, ctx: ExtensionContext, parentFile: string): void {
	const parentId = ctx.sessionManager.getSessionId();
	const dir = dirname(parentFile);
	const startedAt = Date.now();
	// Session files are never renamed, so "a name that did not exist when we spawned"
	// identifies our fork exactly. mtime cannot: a sibling fork shutting down rewrites its own.
	let known: Set<string>;
	try {
		known = new Set(readdirSync(dir));
	} catch {
		return;
	}
	let forkFile: string | null = null;
	let offset = 0;
	let busy = false;

	const timer = ctx.setInterval(() => {
		if (busy) return;
		busy = true;
		void (async () => {
			try {
				if (!forkFile) {
					if (Date.now() - startedAt > DISCOVER_LIMIT_MS) {
						ctx.clearTimer(timer);
						return;
					}
					forkFile = await findFork(dir, known, parentId);
					if (!forkFile) return;
					offset = await lastNewlineOffset(forkFile);
					return;
				}
				if (Date.now() - startedAt > PULL_LIMIT_MS) {
					ctx.clearTimer(timer);
					return;
				}
				const { text, next } = await readNewAssistantText(forkFile, offset);
				offset = next;
				if (!text) return;
				ctx.clearTimer(timer);
				pi.sendMessage(`Side session ${basename(forkFile)} answered:\n\n${text}`, {
					deliverAs: "nextTurn",
				});
				ctx.ui.notify("side session reported back (attached to your next message)", "info");
			} catch (error) {
				ctx.clearTimer(timer);
				ctx.ui.notify(
					`/side --pull stopped watching: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			} finally {
				busy = false;
			}
		})();
	}, POLL_MS);
}

async function findFork(dir: string, known: Set<string>, parentId: string): Promise<string | null> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return null;
	}
	for (const name of names) {
		if (!name.endsWith(".jsonl") || known.has(name)) continue;
		const candidate = join(dir, name);
		if (!(await isForkOf(candidate, parentId))) {
			// Someone else's new session: never look at it again.
			known.add(name);
			continue;
		}
		return candidate;
	}
	return null;
}

async function isForkOf(file: string, parentId: string): Promise<boolean> {
	let handle: FileHandle | null = null;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.alloc(4096);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).toString("utf8").includes(`"parentSession":"${parentId}"`);
	} catch {
		return false;
	} finally {
		await handle?.close();
	}
}

/** Byte offset just past the final complete line, so partial writes are never consumed. */
async function lastNewlineOffset(file: string): Promise<number> {
	const size = (await stat(file)).size;
	if (size === 0) return 0;
	const window = Math.min(size, 65_536);
	let handle: FileHandle | null = null;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.alloc(window);
		const { bytesRead } = await handle.read(buffer, 0, window, size - window);
		const index = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
		return index === -1 ? 0 : size - bytesRead + index + 1;
	} catch {
		return size;
	} finally {
		await handle?.close();
	}
}

async function readNewAssistantText(
	file: string,
	offset: number,
): Promise<{ text: string | null; next: number }> {
	let size: number;
	try {
		size = (await stat(file)).size;
	} catch {
		return { text: null, next: offset };
	}
	if (size <= offset) return { text: null, next: offset };
	let handle: FileHandle | null = null;
	try {
		handle = await open(file, "r");
		const length = size - offset;
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, offset);
		const chunk = buffer.subarray(0, bytesRead).toString("utf8");
		const lastBreak = chunk.lastIndexOf("\n");
		if (lastBreak === -1) return { text: null, next: offset };
		const complete = chunk.slice(0, lastBreak);
		const consumed = offset + Buffer.byteLength(complete, "utf8") + 1;
		for (const line of complete.split("\n")) {
			const text = assistantText(line);
			if (text) return { text, next: consumed };
		}
		return { text: null, next: consumed };
	} catch {
		return { text: null, next: offset };
	} finally {
		await handle?.close();
	}
}

async function openSide(pi: ExtensionAPI, ctx: ExtensionCommandContext, request: SideRequest): Promise<void> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		ctx.ui.notify("/side needs a persisted session (this one runs with --no-session).", "error");
		return;
	}
	// A session with no durable entries yet has a path but no file; `omp --fork` would
	// silently degrade to a plain new session, so say so instead of pretending.
	if (!existsSync(sessionFile)) {
		ctx.ui.notify("/side has nothing to fork yet — this session has not written any entries.", "error");
		return;
	}
	const workspace = process.env.CMUX_WORKSPACE_ID;
	if (!workspace) {
		ctx.ui.notify("/side needs cmux: CMUX_WORKSPACE_ID is not set in this terminal.", "error");
		return;
	}
	const surface = process.env.CMUX_SURFACE_ID;
	const cwd = ctx.sessionManager.getCwd();
	// Spawning a pane steals focus, so remember where focus was for `--bg`.
	let restore: { pane: string; window: string } | null = null;
	if (!request.focus) {
		try {
			const identity = JSON.parse(await cmux(pi, ["identify", "--no-caller"])) as {
				focused?: { pane_ref?: string; window_ref?: string };
			};
			const pane = identity.focused?.pane_ref;
			const window = identity.focused?.window_ref;
			if (pane && window) restore = { pane, window };
		} catch {
			restore = null;
		}
	}
	const command = [
		"exec",
		shQuote(resolveOmp()),
		"--cwd",
		shQuote(cwd),
		"--fork",
		shQuote(sessionFile),
		...request.ompArgs.map(shQuote),
		...(request.prompt ? [shQuote(request.prompt)] : []),
	].join(" ");
	const title = paneTitle(request.prompt);

	let target: string;
	if (request.tab) {
		await cmux(pi, [
			"new-workspace",
			"--name",
			title,
			"--cwd",
			cwd,
			"--command",
			command,
			"--focus",
			String(request.focus),
		]);
		target = title;
	} else {
		const created = await cmux(pi, [
			"new-split",
			request.direction,
			"--workspace",
			workspace,
			...(surface ? ["--surface", surface] : []),
			"--focus",
			String(request.focus),
		]);
		const ref = /surface:\d+/.exec(created)?.[0];
		if (!ref) throw new Error(`unexpected cmux new-split output: ${created}`);
		await cmux(pi, ["rename-tab", "--surface", ref, title]);
		await cmux(pi, ["respawn-pane", "--surface", ref, "--command", command]);
		target = ref;
	}
	if (restore) {
		try {
			await cmux(pi, ["focus-pane", "--pane", restore.pane, "--window", restore.window]);
		} catch {
			// best effort: a closed or moved pane just means focus stays where it landed
		}
	}

	pi.appendEntry(SPAWN_ENTRY, {
		parentSessionFile: sessionFile,
		target,
		prompt: request.prompt,
		ompArgs: request.ompArgs,
		pull: request.pull,
		at: new Date().toISOString(),
	});
	ctx.ui.notify(
		`side session forked into ${target}${request.pull ? " — its first answer will come back to me" : ""}`,
		"info",
	);
	if (request.pull) watchFork(pi, ctx, sessionFile);
}

export default function ompSide(pi: ExtensionAPI) {
	pi.registerCommand("side", {
		description: "Fork this session into a cmux side pane: /side [--bg|--tab|--pull|--model X --] <prompt>",
		handler: async (args, ctx) => {
			try {
				await openSide(pi, ctx, parseRequest(args));
			} catch (error) {
				ctx.ui.notify(`/side failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerShortcut("alt+s", {
		description: "Fork this session into a cmux side pane",
		handler: async (ctx) => {
			try {
				await openSide(pi, ctx as ExtensionCommandContext, {
					focus: true,
					tab: false,
					pull: false,
					direction: "right",
					ompArgs: [],
					prompt: "",
				});
			} catch (error) {
				ctx.ui.notify(`/side failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
