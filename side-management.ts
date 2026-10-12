/**
 * Management of side forks recorded by omp-side: `/side list`, `/side focus N`, `/side close N`.
 *
 * Safety model. A fork may only be focused or closed when every check below passes, and the
 * checks run again after the user confirms a close:
 *   1. the spawn record carries a routing scope and the child session file (older records do not);
 *   2. the current terminal is the one that launched the fork, and its routing scope matches;
 *   3. the recorded target is not the pane running this session;
 *   4. the backend's own inventory, read just now, still contains the exact recorded target;
 *   5. where the backend exposes process data, that pane still runs the recorded child session.
 * Backend failures are thrown, never reported as a missing pane.
 *
 * Runtime imports are node builtins only so the module stays loadable without OMP.
 */
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

export const SPAWN_ENTRY_TYPE = "omp-side.spawn";
export const CLOSED_ENTRY_TYPE = "omp-side.closed";

export type TerminalKind = "cmux" | "tmux" | "tern" | "wezterm" | "kitty" | "ghostty";

export interface ExecOutput {
	code: number;
	stdout: string;
	stderr: string;
}

export type Runner = (command: string, args: string[]) => Promise<ExecOutput>;

export interface ForkData {
	parentSessionFile: string;
	childSessionFile?: string;
	terminal: TerminalKind;
	/** The pane the fork was placed in, in the representation the launcher returned. */
	target: string;
	placement: "split" | "tab" | "window";
	prompt: string;
	at: string;
	/** Opaque routing identity from `terminalScope`; absent on records from older versions. */
	scope?: string;
	/** The parent session's own pane, in the same representation as `target`. */
	source?: string;
	/** True when the fork was placed without explicit placement flags. */
	automatic?: boolean;
}

export interface ManagedFork {
	/** 1-based, in spawn order within the current session. */
	number: number;
	/** Id of the spawn entry; the key of the close record. */
	entryId: string;
	closed: boolean;
	data: ForkData;
}

export interface ManagementCommand {
	action: "list" | "focus" | "close";
	number?: number;
}

export interface ManageOptions {
	run: Runner;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	confirm: (title: string, message: string) => Promise<boolean>;
	notify: (message: string, level: "info" | "warning" | "error") => void;
	recordClose: (spawnEntryId: string) => void;
}

const TERMINALS: readonly string[] = ["cmux", "tmux", "tern", "wezterm", "kitty", "ghostty"];
const PLACEMENTS: readonly string[] = ["split", "tab", "window"];
const TERN_APP_BINARY = "/Applications/Tern.app/Contents/MacOS/tern";

const ESCAPE_HINT = 'To ask a question that starts with one of these words, write it as: /side -- list ...';

/**
 * Parses the management words. Only a leading `list`, `focus` or `close` is a command, and a
 * command must be well formed: anything else after it is an error rather than a prompt, so a
 * typo can never fork a session or hit the wrong pane. Everything that is not a command,
 * including `-- list ...`, returns null and remains an ordinary prompt.
 */
export function parseManagementCommand(args: string): ManagementCommand | null {
	const words = args.trim().split(/\s+/);
	const word = words[0];
	if (word !== "list" && word !== "focus" && word !== "close") return null;
	if (word === "list") {
		if (words.length !== 1) throw new Error(`/side list takes no arguments. ${ESCAPE_HINT}`);
		return { action: "list" };
	}
	if (words.length !== 2) {
		throw new Error(`/side ${word} takes exactly one fork number, for example /side ${word} 2. ${ESCAPE_HINT}`);
	}
	if (!/^[1-9]\d*$/.test(words[1]) || !Number.isSafeInteger(Number(words[1]))) {
		throw new Error(`/side ${word} needs a positive whole number, got "${words[1]}". ${ESCAPE_HINT}`);
	}
	return { action: word, number: Number(words[1]) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function readSpawn(data: unknown, parentSessionFile: string): ForkData | null {
	if (!isRecord(data)) return null;
	const { parentSessionFile: parent, target, terminal, placement, prompt, at } = data;
	if (parent !== parentSessionFile) return null;
	if (typeof target !== "string" || typeof terminal !== "string" || !TERMINALS.includes(terminal)) return null;
	if (typeof placement !== "string" || !PLACEMENTS.includes(placement)) return null;
	const fork: ForkData = {
		parentSessionFile: parent,
		terminal: terminal as TerminalKind,
		target,
		placement: placement as ForkData["placement"],
		prompt: typeof prompt === "string" ? prompt : "",
		at: typeof at === "string" ? at : "",
	};
	const childSessionFile = optionalString(data.childSessionFile);
	const scope = optionalString(data.scope);
	const source = optionalString(data.source);
	if (childSessionFile) fork.childSessionFile = childSessionFile;
	if (scope) fork.scope = scope;
	if (source) fork.source = source;
	if (typeof data.automatic === "boolean") fork.automatic = data.automatic;
	return fork;
}

/**
 * Forks recorded by `parentSessionFile`, numbered in creation order. A forked session inherits
 * its parent's entries, so spawn and close records are accepted only when their
 * `parentSessionFile` is exactly the current persisted session file.
 */
export function collectForks(entries: readonly unknown[], parentSessionFile: string): ManagedFork[] {
	const forks: ManagedFork[] = [];
	const closed = new Set<string>();
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom") continue;
		if (entry.customType === SPAWN_ENTRY_TYPE) {
			const data = readSpawn(entry.data, parentSessionFile);
			if (!data || typeof entry.id !== "string" || entry.id === "") continue;
			forks.push({ number: forks.length + 1, entryId: entry.id, closed: false, data });
		} else if (entry.customType === CLOSED_ENTRY_TYPE) {
			const data = entry.data;
			if (isRecord(data) && data.parentSessionFile === parentSessionFile && typeof data.spawnEntryId === "string") {
				closed.add(data.spawnEntryId);
			}
		}
	}
	for (const fork of forks) fork.closed = closed.has(fork.entryId);
	return forks;
}

export function detectTerminal(env: NodeJS.ProcessEnv): TerminalKind | null {
	if (env.CMUX_WORKSPACE_ID) return "cmux";
	if (env.TMUX) return "tmux";
	if (env.TERM_PROGRAM?.toLowerCase() === "tern" && env.TERN_PANE) return "tern";
	if (env.WEZTERM_PANE) return "wezterm";
	if (env.KITTY_WINDOW_ID) return "kitty";
	if (env.TERM_PROGRAM?.toLowerCase() === "ghostty" || env.GHOSTTY_RESOURCES_DIR) return "ghostty";
	return null;
}

/**
 * A deterministic identity of the terminal server or window whose pane ids are meaningful
 * here. It is built from what the pane ids are relative to (a socket, a daemon and window),
 * never from a client pid, and hashed so the record holds no socket paths.
 */
export function terminalScope(terminal: TerminalKind, env: NodeJS.ProcessEnv): string {
	let parts: (string | undefined)[];
	switch (terminal) {
		case "tmux":
			// TMUX is "socket-path,server-pid,session-index": the session index changes per client.
			parts = (env.TMUX ?? "").split(",").slice(0, 2);
			break;
		case "tern":
			parts = [env.TERN_DAEMON_SOCKET, env.TERN_WINDOW_KEY];
			break;
		case "cmux":
			parts = [env.CMUX_SOCKET_PATH, env.CMUX_WORKSPACE_ID];
			break;
		case "kitty":
			parts = [env.KITTY_LISTEN_ON ?? (env.KITTY_PID ? `pid:${env.KITTY_PID}` : undefined)];
			break;
		case "wezterm":
			parts = [env.WEZTERM_UNIX_SOCKET];
			break;
		case "ghostty":
			parts = [];
			break;
	}
	const digest = createHash("sha256")
		.update(parts.map((part) => part ?? "").join("\0"))
		.digest("hex");
	return `${terminal}:${digest.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------------------------

interface Context {
	run: Runner;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
}

/** What one backend inventory says about a pane that exists. */
interface PaneFacts {
	/** Whether the pane's process data names the child session; null when the backend cannot say. */
	runsChild: boolean | null;
	/** Whether this is the pane the current session runs in. */
	current: boolean;
}

/** Looks one pane up in an inventory read once; null means the pane is not there. */
type Lookup = (target: string, childSessionFile: string) => Promise<PaneFacts | null>;

interface Backend {
	/** The canonical form of a recorded target, or null if it is not one this backend produces. */
	target(raw: string): string | null;
	snapshot(ctx: Context): Promise<Lookup>;
	focus(ctx: Context, target: string): [string, string[]][];
	close(ctx: Context, target: string): [string, string[]][];
}

export async function checked(run: Runner, command: string, args: string[]): Promise<string> {
	const result = await run(command, args);
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
		throw new Error(`${basename(command)} ${args[0] ?? ""}: ${detail}`.trim());
	}
	return result.stdout.trim();
}

async function checkedJson(run: Runner, command: string, args: string[]): Promise<unknown> {
	const output = await checked(run, command, args);
	try {
		return JSON.parse(output);
	} catch {
		throw new Error(`${basename(command)} ${args[0] ?? ""}: unexpected non-JSON output`);
	}
}

export function resolveOnPath(names: string[], path = process.env.PATH ?? ""): string {
	for (const name of names) {
		for (const dir of path.split(delimiter)) {
			if (!dir) continue;
			const candidate = join(dir, name);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// keep looking
			}
		}
	}
	return names[0];
}

export function resolveTern(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	const onPath = resolveOnPath(["tern"], env.PATH);
	if (onPath !== "tern" || platform !== "darwin") return onPath;
	return existsSync(TERN_APP_BINARY) ? TERN_APP_BINARY : onPath;
}

/** Quote-aware tokenization for /side options and terminal launch-command identity checks. */
export function tokenize(input: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let quoted = false;
	for (let index = 0; index < input.length; index++) {
		const ch = input[index];
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else if (quote === '"' && ch === "\\") {
				if (index + 1 >= input.length) throw new Error("trailing escape in /side flags");
				current += input[++index];
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			quoted = true;
			continue;
		}
		if (ch === "\\") {
			if (index + 1 >= input.length) throw new Error("trailing escape in /side flags");
			current += input[++index];
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
	if (quote) throw new Error("unterminated quote in /side flags");
	if (current || quoted) out.push(current);
	return out;
}

/** Match the exact resumed session argument, never a substring of another file or prompt. */
function resumesChild(command: string | string[], sessionFile: string): boolean {
	let args: string[];
	try {
		args = typeof command === "string" ? tokenize(command) : command;
		// tmux serializes its single shell-command argument with an extra quoting layer.
		if (typeof command === "string" && args.length === 1) args = tokenize(args[0]);
	} catch {
		return false;
	}
	return args.some((arg, index) =>
		(arg === "--resume" && args[index + 1] === sessionFile) || arg === `--resume=${sessionFile}`,
	);
}

function numericId(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function envNumber(raw: string | undefined): number | null {
	return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
}

const tmuxBackend: Backend = {
	target: (raw) => (/^%\d+$/.test(raw.trim()) ? raw.trim() : null),
	async snapshot(ctx) {
		const output = await checked(ctx.run, "tmux", [
			"list-panes",
			"-a",
			"-F",
			"#{pane_id} #{pane_dead} #{pane_start_command}",
		]);
		const panes = new Map<string, { dead: boolean; command: string }>();
		let last: { dead: boolean; command: string } | null = null;
		for (const line of output.split("\n")) {
			const match = /^(%\d+) ([01]) ?(.*)$/.exec(line);
			if (match) {
				last = { dead: match[2] === "1", command: match[3] };
				panes.set(match[1], last);
			} else if (last) {
				last.command += `\n${line}`;
			}
		}
		return async (target, child) => {
			const pane = panes.get(target);
			if (!pane || pane.dead) return null;
			return { runsChild: resumesChild(pane.command, child), current: ctx.env.TMUX_PANE === target };
		};
	},
	focus: (_ctx, target) => [
		["tmux", ["select-window", "-t", target]],
		["tmux", ["select-pane", "-t", target]],
	],
	close: (_ctx, target) => [["tmux", ["kill-pane", "-t", target]]],
};

interface TernBlockInfo {
	id?: unknown;
	live?: unknown;
	exited?: unknown;
	command?: unknown;
}

const ternBackend: Backend = {
	target(raw) {
		const match = /^block:(\d+)$/.exec(raw.trim());
		return match && Number.isSafeInteger(Number(match[1])) ? `block:${Number(match[1])}` : null;
	},
	async snapshot(ctx) {
		const tern = resolveTern(ctx.env, ctx.platform);
		const tree = await checkedJson(ctx.run, tern, ["inspect", "--json"]);
		const blocks = new Map<number, TernBlockInfo>();
		const sessions = isRecord(tree) && Array.isArray(tree.sessions) ? tree.sessions : [];
		for (const session of sessions) {
			const tabs = isRecord(session) && Array.isArray(session.tabs) ? session.tabs : [];
			for (const tab of tabs) {
				const tabBlocks = isRecord(tab) && Array.isArray(tab.blocks) ? tab.blocks : [];
				for (const block of tabBlocks) {
					const id = isRecord(block) ? numericId(block.id) : null;
					if (id !== null) blocks.set(id, block as TernBlockInfo);
				}
			}
		}
		const currentPane = envNumber(ctx.env.TERN_PANE);
		return async (target, child) => {
			const id = Number(target.slice("block:".length));
			const block = blocks.get(id);
			if (!block || block.live === false || (block.exited !== null && block.exited !== undefined)) return null;
			const command = typeof block.command === "string" ? block.command : "";
			return { runsChild: resumesChild(command, child), current: currentPane === id };
		};
	},
	focus: (ctx, target) => [[resolveTern(ctx.env, ctx.platform), ["focus", target.slice("block:".length)]]],
	close: (ctx, target) => [[resolveTern(ctx.env, ctx.platform), ["close", target.slice("block:".length)]]],
};

const weztermBackend: Backend = {
	target: (raw) => (/^\d+$/.test(raw.trim()) ? String(Number(raw.trim())) : null),
	async snapshot(ctx) {
		const listing = await checkedJson(ctx.run, "wezterm", ["cli", "list", "--format", "json"]);
		const panes = new Set<number>();
		for (const pane of Array.isArray(listing) ? listing : []) {
			const id = isRecord(pane) ? numericId(pane.pane_id) : null;
			if (id !== null) panes.add(id);
		}
		const currentPane = envNumber(ctx.env.WEZTERM_PANE);
		// `wezterm cli list` reports no process data, so identity rests on the scope and exact id.
		return async (target) => {
			const id = Number(target);
			return panes.has(id) ? { runsChild: null, current: currentPane === id } : null;
		};
	},
	focus: (_ctx, target) => [["wezterm", ["cli", "activate-pane", "--pane-id", target]]],
	close: (_ctx, target) => [["wezterm", ["cli", "kill-pane", "--pane-id", target]]],
};

function kittyExecutable(env: NodeJS.ProcessEnv): string {
	return resolveOnPath(["kitten", "kitty"], env.PATH);
}

const kittyBackend: Backend = {
	// The launcher falls back to `kitty:<source window>` when kitty prints no id; that names the
	// parent, so only a bare window id is a manageable target.
	target: (raw) => (/^\d+$/.test(raw.trim()) ? String(Number(raw.trim())) : null),
	async snapshot(ctx) {
		const listing = await checkedJson(ctx.run, kittyExecutable(ctx.env), ["@", "ls"]);
		const windows = new Map<number, Record<string, unknown>>();
		for (const osWindow of Array.isArray(listing) ? listing : []) {
			for (const tab of isRecord(osWindow) && Array.isArray(osWindow.tabs) ? osWindow.tabs : []) {
				for (const window of isRecord(tab) && Array.isArray(tab.windows) ? tab.windows : []) {
					const id = isRecord(window) ? numericId(window.id) : null;
					if (id !== null) windows.set(id, window as Record<string, unknown>);
				}
			}
		}
		const currentWindow = envNumber(ctx.env.KITTY_WINDOW_ID);
		return async (target, child) => {
			const id = Number(target);
			const window = windows.get(id);
			if (!window) return null;
			const cmdlines: unknown[] = [window.cmdline];
			if (Array.isArray(window.foreground_processes)) {
				for (const process of window.foreground_processes) cmdlines.push(isRecord(process) ? process.cmdline : undefined);
			}
			const runsChild = cmdlines.some(cmdline =>
				Array.isArray(cmdline) && cmdline.every(arg => typeof arg === "string") && resumesChild(cmdline, child),
			);
			return { runsChild, current: currentWindow === id };
		};
	},
	focus: (ctx, target) => [[kittyExecutable(ctx.env), ["@", "focus-window", "--match", `id:${target}`]]],
	close: (ctx, target) => [[kittyExecutable(ctx.env), ["@", "close-window", "--match", `id:${target}`]]],
};

const cmuxBackend: Backend = {
	target: (raw) => (/^surface:\d+$/.test(raw.trim()) ? raw.trim() : null),
	async snapshot(ctx) {
		const workspace = ctx.env.CMUX_WORKSPACE_ID;
		if (!workspace) throw new Error("CMUX_WORKSPACE_ID is missing");
		const tree = await checked(ctx.run, "cmux", ["--id-format", "both", "tree", "--workspace", workspace]);
		const lines = tree.split("\n");
		const surfaceId = ctx.env.CMUX_SURFACE_ID;
		return async (target) => {
			const mark = new RegExp(`\\b${target.replace(":", "\\:")}\\b`);
			const line = lines.find((candidate) => mark.test(candidate));
			if (line === undefined) return null;
			// cmux reports no process data, so identity rests on the scope and this exact ref.
			return { runsChild: null, current: Boolean(surfaceId) && (surfaceId === target || line.includes(surfaceId as string)) };
		};
	},
	focus: (ctx, target) => [["cmux", ["focus-panel", "--panel", target, "--workspace", ctx.env.CMUX_WORKSPACE_ID ?? ""]]],
	close: (ctx, target) => [["cmux", ["close-surface", "--surface", target, "--workspace", ctx.env.CMUX_WORKSPACE_ID ?? ""]]],
};

const BACKENDS: Record<Exclude<TerminalKind, "ghostty">, Backend> = {
	tmux: tmuxBackend,
	tern: ternBackend,
	wezterm: weztermBackend,
	kitty: kittyBackend,
	cmux: cmuxBackend,
};

/**
 * The current session's own pane in the same representation as a fork's `target`, validated
 * by the same rules management applies; undefined when it cannot be named exactly.
 */
export function terminalSource(terminal: TerminalKind, env: NodeJS.ProcessEnv): string | undefined {
	switch (terminal) {
		case "tmux":
			return tmuxBackend.target(env.TMUX_PANE ?? "") ?? undefined;
		case "tern":
			return ternBackend.target(`block:${env.TERN_PANE ?? ""}`) ?? undefined;
		case "wezterm":
			return weztermBackend.target(env.WEZTERM_PANE ?? "") ?? undefined;
		case "kitty":
			return kittyBackend.target(env.KITTY_WINDOW_ID ?? "") ?? undefined;
		case "cmux":
			return env.CMUX_SURFACE_ID?.trim() || undefined;
		case "ghostty":
			return undefined;
	}
}

// ---------------------------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------------------------

type ForkState = "live" | "closed" | "gone" | "unverified" | "unavailable";

interface Assessment {
	state: ForkState;
	reason?: string;
	backend?: Backend;
	target?: string;
}

type SnapshotFor = (kind: Exclude<TerminalKind, "ghostty">, backend: Backend) => Promise<Lookup>;

async function assess(fork: ManagedFork, ctx: Context, snapshotFor: SnapshotFor): Promise<Assessment> {
	const { data } = fork;
	if (fork.closed) return { state: "closed" };
	if (data.terminal === "ghostty") {
		return { state: "unavailable", reason: "Ghostty windows have no stable target to manage" };
	}
	if (!data.scope || !data.childSessionFile) {
		return { state: "unverified", reason: "recorded before fork identity was tracked" };
	}
	if (data.childSessionFile === data.parentSessionFile) {
		return { state: "unverified", reason: "recorded child session is the parent session" };
	}
	const current = detectTerminal(ctx.env);
	if (current !== data.terminal) {
		return { state: "unavailable", reason: `launched from ${data.terminal}, which is not this terminal` };
	}
	if (terminalScope(current, ctx.env) !== data.scope) {
		return { state: "unavailable", reason: `belongs to a different ${data.terminal} server or window` };
	}
	const backend = BACKENDS[data.terminal];
	const target = backend.target(data.target);
	if (!target) return { state: "unverified", reason: "target was not recorded in a manageable form" };
	if (data.source !== undefined && (data.source.trim() === data.target.trim() || backend.target(data.source) === target)) {
		return { state: "unavailable", reason: "target is the parent pane" };
	}
	const facts = await (await snapshotFor(data.terminal, backend))(target, data.childSessionFile);
	if (!facts) return { state: "gone", reason: "the pane no longer exists" };
	if (facts.current) return { state: "unavailable", reason: "target is the pane running this session" };
	if (facts.runsChild === false) {
		return { state: "unverified", reason: "the pane no longer runs this fork session" };
	}
	return { state: "live", backend, target };
}

function title(fork: ManagedFork): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control characters from prompts
	const line = (fork.data.prompt.split("\n").find((text) => text.trim() !== "") ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
	if (!line) return "(no prompt)";
	return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

async function listForks(forks: ManagedFork[], ctx: Context, notify: ManageOptions["notify"]): Promise<void> {
	if (forks.length === 0) {
		notify("No side forks recorded from this session.", "info");
		return;
	}
	const snapshots = new Map<string, Promise<Lookup>>();
	const snapshotFor: SnapshotFor = (kind, backend) => {
		let snapshot = snapshots.get(kind);
		if (!snapshot) {
			snapshot = backend.snapshot(ctx);
			snapshots.set(kind, snapshot);
		}
		return snapshot;
	};
	let degraded = false;
	const lines: string[] = [];
	for (const fork of forks) {
		let result: Assessment;
		try {
			result = await assess(fork, ctx, snapshotFor);
		} catch (error) {
			degraded = true;
			const detail = error instanceof Error ? error.message : String(error);
			result = { state: "unavailable", reason: `could not read ${fork.data.terminal} state: ${detail}` };
		}
		const detail = result.reason && result.state !== "gone" ? ` (${result.reason})` : "";
		lines.push(`${fork.number}. ${result.state}  ${fork.data.terminal} ${fork.data.placement}  ${title(fork)}${detail}`);
	}
	lines.push("Use /side focus N or /side close N.");
	notify(lines.join("\n"), degraded ? "warning" : "info");
}

/** Throws on backend failures; returns false after reporting a refusal. */
async function requireLive(
	fork: ManagedFork,
	ctx: Context,
	notify: ManageOptions["notify"],
	verb: string,
): Promise<{ backend: Backend; target: string } | null> {
	// A fresh inventory on every call: nothing is cached between validation and action.
	const result = await assess(fork, ctx, (_kind, backend) => backend.snapshot(ctx));
	if (result.state === "live" && result.backend && result.target) {
		return { backend: result.backend, target: result.target };
	}
	const reason = result.state === "closed" ? "it was already closed" : (result.reason ?? result.state);
	notify(`Side fork ${fork.number} was not ${verb}: ${reason}.`, "error");
	return null;
}

async function runAll(ctx: Context, invocations: [string, string[]][]): Promise<void> {
	for (const [command, args] of invocations) await checked(ctx.run, command, args);
}

export async function manageForks(
	command: ManagementCommand,
	forks: ManagedFork[],
	options: ManageOptions,
): Promise<void> {
	const ctx: Context = { run: options.run, env: options.env, platform: options.platform };
	if (command.action === "list") {
		await listForks(forks, ctx, options.notify);
		return;
	}
	const fork = forks.find((candidate) => candidate.number === command.number);
	if (!fork) {
		options.notify(`There is no side fork ${command.number}. Use /side list to see the numbers.`, "error");
		return;
	}
	const where = `${fork.data.terminal} ${fork.data.target}`;
	if (command.action === "focus") {
		const live = await requireLive(fork, ctx, options.notify, "focused");
		if (!live) return;
		await runAll(ctx, live.backend.focus(ctx, live.target));
		options.notify(`Focused side fork ${fork.number} (${where}).`, "info");
		return;
	}
	const first = await requireLive(fork, ctx, options.notify, "closed");
	if (!first) return;
	const approved = await options.confirm(
		`Close side fork ${fork.number}?`,
		`This closes ${where} and terminates any process still running in it. ` +
			"The side session transcript is kept. The current session is not affected.",
	);
	if (!approved) {
		options.notify(`Side fork ${fork.number} was left open.`, "info");
		return;
	}
	// The pane can change while the dialog is open, so everything is checked again.
	const second = await requireLive(fork, ctx, options.notify, "closed");
	if (!second) return;
	await runAll(ctx, second.backend.close(ctx, second.target));
	options.recordClose(fork.entryId);
	options.notify(`Closed side fork ${fork.number} (${where}). Its transcript is kept.`, "info");
}
