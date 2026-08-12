/**
 * omp-side: fork an OMP conversation into a nearby terminal pane or tab.
 *
 *   /side why would the cache miss here?      auto-place a fork and ask
 *   /side --model @slow -- second opinion?    fork into a different model
 *   /side --bg --pull -- audit the plan       keep focus; first answer comes back
 *   /side --tab -- long tangent               force a new terminal tab
 *   alt+s                                     empty auto-placed fork, focused
 *
 * The extension creates a real child session: full transcript up to the current point,
 * its own session file, and `parentSession` lineage. Parent todos are cleared in the child
 * before launch so a completion reminder cannot drag the tangent back into the parent's work.
 */

import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const SPAWN_ENTRY = "omp-side.spawn";
const SIDE_CONTEXT_ENTRY = "omp-side.context";
const USER_TODO_EDIT_ENTRY = "user_todo_edit";
const SIDE_CONTEXT_SWITCH = `<system-notice cause="fork">
The conversation above belongs to your concurrently running parent session.
You are a side fork created solely to handle the user's request below.

- Focus exclusively on the user's immediate request.
- Never continue, update, or complete work from before this notice.
- The parent owns every earlier todo, plan, and unfinished checklist.
- The parent may be editing the same working directory. Do not fix or build on its in-flight changes.
- After answering the side request and completing any todos you created yourself, stop.
</system-notice>`;
const POLL_MS = 750;
const DISCOVER_LIMIT_MS = 60_000;
const PULL_LIMIT_MS = 30 * 60_000;
const TERMINAL_TIMEOUT_MS = 15_000;

type Direction = "right" | "left" | "up" | "down";
type Placement = "auto" | "split" | "tab";
type TerminalKind = "cmux" | "tmux" | "wezterm" | "kitty" | "ghostty";

interface SideRequest {
	focus: boolean;
	placement: Placement;
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

function parseRequest(raw: string): SideRequest {
	const request: SideRequest = {
		focus: true,
		placement: "auto",
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
				request.placement = "tab";
				break;
			case "--split":
				request.placement = "split";
				break;
			case "--pull":
				request.pull = true;
				break;
			case "--right":
			case "--left":
			case "--up":
			case "--down":
				request.direction = token.slice(2) as Direction;
				request.placement = "split";
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

type SideSessionManager = Pick<
	ExtensionContext["sessionManager"],
	"appendCustomEntry" | "appendMessage" | "getSessionFile" | "close"
>;
type ForkFactory = (sourcePath: string, cwd: string, sessionDir?: string) => Promise<SideSessionManager>;

function seedTangentContext(
	manager: Pick<SideSessionManager, "appendCustomEntry" | "appendMessage">,
	parentSessionFile: string,
): void {
	manager.appendCustomEntry(SIDE_CONTEXT_ENTRY, { parentSessionFile });
	manager.appendCustomEntry(USER_TODO_EDIT_ENTRY, { phases: [] });
	manager.appendMessage({
		role: "developer",
		content: [{ type: "text", text: SIDE_CONTEXT_SWITCH }],
		attribution: "agent",
		timestamp: Date.now(),
	});
}

async function prepareSideFork(
	parentSessionFile: string,
	cwd: string,
	forkFrom: ForkFactory,
	sessionDir?: string,
): Promise<string> {
	const manager = await forkFrom(parentSessionFile, cwd, sessionDir);
	try {
		seedTangentContext(manager, parentSessionFile);
		const childSessionFile = manager.getSessionFile();
		if (!childSessionFile) throw new Error("OMP created a side fork without a session file");
		return childSessionFile;
	} finally {
		await manager.close();
	}
}

function isSideFork(ctx: ExtensionContext): boolean {
	return ctx.sessionManager
		.getBranch()
		.some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === SIDE_CONTEXT_ENTRY,
		);
}

interface ExecOutput {
	code: number;
	stdout: string;
	stderr: string;
}

type Runner = (command: string, args: string[]) => Promise<ExecOutput>;

interface LaunchResult {
	target: string;
	terminal: TerminalKind;
	placement: "split" | "tab" | "window";
}

function createRunner(pi: ExtensionAPI): Runner {
	return (command, args) => pi.exec(command, args, { timeout: TERMINAL_TIMEOUT_MS });
}

async function checked(run: Runner, command: string, args: string[]): Promise<string> {
	const result = await run(command, args);
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
		throw new Error(`${command} ${args[0] ?? ""}: ${detail}`.trim());
	}
	return result.stdout.trim();
}

function resolveOnPath(names: string[], path = process.env.PATH ?? ""): string {
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

function detectTerminal(env: NodeJS.ProcessEnv): TerminalKind | null {
	if (env.CMUX_WORKSPACE_ID) return "cmux";
	if (env.TMUX) return "tmux";
	if (env.WEZTERM_PANE) return "wezterm";
	if (env.KITTY_WINDOW_ID) return "kitty";
	if (env.TERM_PROGRAM?.toLowerCase() === "ghostty" || env.GHOSTTY_RESOURCES_DIR) return "ghostty";
	return null;
}

function choosePlacement(requested: Placement, paneCount: number): "split" | "tab" {
	if (requested === "tab") return "tab";
	if (requested === "split") return "split";
	return paneCount > 1 ? "tab" : "split";
}

function cmuxLayout(tree: string, surface: string | undefined): {
	paneCount: number;
	ownerPane: string | null;
} {
	const panes = new Set<string>();
	let currentPane: string | null = null;
	let ownerPane: string | null = null;
	for (const line of tree.split("\n")) {
		const pane = /\bpane:\d+\b/.exec(line)?.[0];
		if (pane) {
			currentPane = pane;
			panes.add(pane);
		}
		if (surface && line.includes(surface)) ownerPane = currentPane;
	}
	return { paneCount: panes.size, ownerPane };
}

function surfaceRef(output: string): string {
	const ref = /\bsurface:\d+\b/.exec(output)?.[0];
	if (!ref) throw new Error(`unexpected cmux output: ${output}`);
	return ref;
}

async function launchCmux(
	run: Runner,
	env: NodeJS.ProcessEnv,
	request: SideRequest,
	cwd: string,
	argv: string[],
	title: string,
): Promise<LaunchResult> {
	const workspace = env.CMUX_WORKSPACE_ID;
	if (!workspace) throw new Error("CMUX_WORKSPACE_ID is missing");
	const sourceSurface = env.CMUX_SURFACE_ID;
	const tree = await checked(run, "cmux", [
		"--id-format",
		"both",
		"tree",
		"--workspace",
		workspace,
	]);
	const layout = cmuxLayout(tree, sourceSurface);
	let identity: {
		focused?: { pane_ref?: string; window_ref?: string };
	} | null = null;
	if (!layout.ownerPane || !request.focus) {
		identity = JSON.parse(await checked(run, "cmux", ["identify", "--no-caller"]));
	}
	const ownerPane = layout.ownerPane ?? identity?.focused?.pane_ref ?? null;
	const restore =
		!request.focus && identity?.focused?.pane_ref && identity.focused.window_ref
			? { pane: identity.focused.pane_ref, window: identity.focused.window_ref }
			: null;
	const placement = choosePlacement(request.placement, layout.paneCount);
	const command = ["exec", ...argv.map(shQuote)].join(" ");

	let target: string;
	if (placement === "tab") {
		if (!ownerPane) throw new Error("could not resolve the cmux pane containing this session");
		target = surfaceRef(
			await checked(run, "cmux", [
				"new-surface",
				"--type",
				"terminal",
				"--pane",
				ownerPane,
				"--workspace",
				workspace,
				"--focus",
				String(request.focus),
			]),
		);
	} else {
		target = surfaceRef(
			await checked(run, "cmux", [
				"new-split",
				request.direction,
				"--workspace",
				workspace,
				...(sourceSurface ? ["--surface", sourceSurface] : []),
				"--focus",
				String(request.focus),
			]),
		);
	}
	await checked(run, "cmux", ["rename-tab", "--surface", target, title]);
	await checked(run, "cmux", ["respawn-pane", "--surface", target, "--command", command]);
	if (restore) {
		try {
			await checked(run, "cmux", [
				"focus-pane",
				"--pane",
				restore.pane,
				"--window",
				restore.window,
			]);
		} catch {
			// The source may have closed while the fork was starting.
		}
	}
	return { target, terminal: "cmux", placement };
}

async function launchTmux(
	run: Runner,
	env: NodeJS.ProcessEnv,
	request: SideRequest,
	cwd: string,
	argv: string[],
	title: string,
): Promise<LaunchResult> {
	const sourcePane = env.TMUX_PANE;
	const countText = await checked(run, "tmux", [
		"display-message",
		"-p",
		...(sourcePane ? ["-t", sourcePane] : []),
		"#{window_panes}",
	]);
	const paneCount = Number.parseInt(countText, 10);
	if (!Number.isFinite(paneCount)) throw new Error(`unexpected tmux pane count: ${countText}`);
	const placement = choosePlacement(request.placement, paneCount);
	const command = argv.map(shQuote).join(" ");
	const args =
		placement === "tab"
			? [
					"new-window",
					"-P",
					"-F",
					"#{pane_id}",
					"-c",
					cwd,
					"-n",
					title,
					...(!request.focus ? ["-d"] : []),
					command,
				]
			: [
					"split-window",
					"-P",
					"-F",
					"#{pane_id}",
					"-c",
					cwd,
					...(sourcePane ? ["-t", sourcePane] : []),
					...(request.direction === "left" || request.direction === "right" ? ["-h"] : []),
					...(request.direction === "left" || request.direction === "up" ? ["-b"] : []),
					...(!request.focus ? ["-d"] : []),
					command,
				];
	const target = await checked(run, "tmux", args);
	return { target, terminal: "tmux", placement };
}

interface WezPane {
	pane_id: number;
	tab_id: number;
}

async function launchWezTerm(
	run: Runner,
	env: NodeJS.ProcessEnv,
	request: SideRequest,
	cwd: string,
	argv: string[],
): Promise<LaunchResult> {
	const sourcePane = Number.parseInt(env.WEZTERM_PANE ?? "", 10);
	if (!Number.isFinite(sourcePane)) throw new Error("WEZTERM_PANE is invalid");
	const panes = JSON.parse(await checked(run, "wezterm", ["cli", "list", "--format", "json"])) as WezPane[];
	const source = panes.find((pane) => pane.pane_id === sourcePane);
	if (!source) throw new Error(`WezTerm pane ${sourcePane} was not returned by wezterm cli list`);
	const paneCount = panes.filter((pane) => pane.tab_id === source.tab_id).length;
	const placement = choosePlacement(request.placement, paneCount);
	const args =
		placement === "tab"
			? ["cli", "spawn", "--pane-id", String(sourcePane), "--cwd", cwd, "--", ...argv]
			: [
					"cli",
					"split-pane",
					`--${request.direction}`,
					"--pane-id",
					String(sourcePane),
					"--cwd",
					cwd,
					"--",
					...argv,
				];
	const target = await checked(run, "wezterm", args);
	if (!request.focus) {
		try {
			await checked(run, "wezterm", ["cli", "activate-pane", "--pane-id", String(sourcePane)]);
		} catch {
			// The source may have closed while the fork was starting.
		}
	}
	return { target, terminal: "wezterm", placement };
}

interface KittyWindow {
	id: number;
}

interface KittyTab {
	windows?: KittyWindow[];
}

interface KittyOsWindow {
	tabs?: KittyTab[];
}

async function launchKitty(
	run: Runner,
	env: NodeJS.ProcessEnv,
	request: SideRequest,
	cwd: string,
	argv: string[],
	title: string,
): Promise<LaunchResult> {
	const sourceWindow = Number.parseInt(env.KITTY_WINDOW_ID ?? "", 10);
	if (!Number.isFinite(sourceWindow)) throw new Error("KITTY_WINDOW_ID is invalid");
	const executable = resolveOnPath(["kitten", "kitty"], env.PATH);
	const osWindows = JSON.parse(await checked(run, executable, ["@", "ls"])) as KittyOsWindow[];
	const sourceTab = osWindows
		.flatMap((osWindow) => osWindow.tabs ?? [])
		.find((tab) => tab.windows?.some((window) => window.id === sourceWindow));
	if (!sourceTab) throw new Error(`Kitty window ${sourceWindow} was not returned by kitten @ ls`);
	const placement = choosePlacement(request.placement, sourceTab.windows?.length ?? 1);
	const args = [
		"@",
		"launch",
		"--match",
		`id:${sourceWindow}`,
		"--type",
		placement === "tab" ? "tab" : "window",
		"--cwd",
		cwd,
		...(placement === "tab" ? ["--tab-title", title] : ["--title", title]),
		...(!request.focus ? ["--keep-focus"] : []),
		...(placement === "split"
			? ["--location", request.direction === "left" || request.direction === "right" ? "vsplit" : "hsplit"]
			: []),
		...argv,
	];
	const target = await checked(run, executable, args);
	return { target: target || `kitty:${sourceWindow}`, terminal: "kitty", placement };
}

async function launchGhostty(
	run: Runner,
	platform: NodeJS.Platform,
	cwd: string,
	argv: string[],
): Promise<LaunchResult> {
	if (platform === "darwin") {
		await checked(run, "/usr/bin/open", [
			"-na",
			"Ghostty.app",
			"--args",
			`--working-directory=${cwd}`,
			"-e",
			...argv,
		]);
	} else {
		await checked(run, "ghostty", [`--working-directory=${cwd}`, "-e", ...argv]);
	}
	return { target: "Ghostty window", terminal: "ghostty", placement: "window" };
}

async function launchInTerminal(
	run: Runner,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	request: SideRequest,
	cwd: string,
	argv: string[],
	title: string,
): Promise<LaunchResult> {
	switch (detectTerminal(env)) {
		case "cmux":
			return launchCmux(run, env, request, cwd, argv, title);
		case "tmux":
			return launchTmux(run, env, request, cwd, argv, title);
		case "wezterm":
			return launchWezTerm(run, env, request, cwd, argv);
		case "kitty":
			return launchKitty(run, env, request, cwd, argv, title);
		case "ghostty":
			return launchGhostty(run, platform, cwd, argv);
		default:
			throw new Error(
				"unsupported terminal: use cmux, tmux, WezTerm, Kitty, or Ghostty (direct Ghostty opens a new window)",
			);
	}
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
	// A session with no durable entries yet has a path but no file; the fork factory would
	// otherwise fail after the terminal placement has already started.
	if (!existsSync(sessionFile)) {
		ctx.ui.notify("/side has nothing to fork yet — this session has not written any entries.", "error");
		return;
	}
	const cwd = ctx.sessionManager.getCwd();
	const managerClass = ctx.sessionManager.constructor as unknown as { forkFrom?: ForkFactory };
	if (typeof managerClass.forkFrom !== "function") {
		throw new Error("this OMP build does not expose session forking to extensions");
	}
	const childSessionFile = await prepareSideFork(
		sessionFile,
		cwd,
		(sourcePath, childCwd, sessionDir) => managerClass.forkFrom!(sourcePath, childCwd, sessionDir),
	);
	const argv = [
		resolveOmp(),
		"--cwd",
		cwd,
		"--resume",
		childSessionFile,
		...request.ompArgs,
		...(request.prompt ? [request.prompt] : []),
	];
	const launched = await launchInTerminal(
		createRunner(pi),
		process.env,
		process.platform,
		request,
		cwd,
		argv,
		paneTitle(request.prompt),
	);

	pi.appendEntry(SPAWN_ENTRY, {
		parentSessionFile: sessionFile,
		target: launched.target,
		terminal: launched.terminal,
		placement: launched.placement,
		prompt: request.prompt,
		ompArgs: request.ompArgs,
		pull: request.pull,
		at: new Date().toISOString(),
	});
	ctx.ui.notify(
		`side session forked into ${launched.terminal} ${launched.placement} ${launched.target}${
			request.pull ? " — its first answer will come back to me" : ""
		}`,
		"info",
	);
	if (request.pull) watchFork(pi, ctx, sessionFile);
}

function reinjectSideContext(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!isSideFork(ctx)) return;
	pi.sendMessage(
		{
			customType: "omp-side.context-switch",
			content: SIDE_CONTEXT_SWITCH,
			display: false,
			attribution: "agent",
		},
		{ deliverAs: "nextTurn" },
	);
}

export default function ompSide(pi: ExtensionAPI) {
	pi.on("auto_compaction_end", async (event, ctx) => {
		if (event.result && !event.aborted) reinjectSideContext(pi, ctx);
	});
	pi.registerCommand("side", {
		description:
			"Fork this session beside you: /side [--bg|--split|--tab|--pull|--model X --] <prompt>",
		handler: async (args, ctx) => {
			try {
				await openSide(pi, ctx, parseRequest(args));
			} catch (error) {
				ctx.ui.notify(`/side failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerShortcut("alt+s", {
		description: "Fork this session beside you",
		handler: async (ctx) => {
			try {
				await openSide(pi, ctx as ExtensionCommandContext, {
					focus: true,
					placement: "auto",
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

export const __testing = {
	prepareSideFork,
	seedTangentContext,
	isSideFork,
	SIDE_CONTEXT_ENTRY,
	USER_TODO_EDIT_ENTRY,
	SIDE_CONTEXT_SWITCH,
	choosePlacement,
	cmuxLayout,
	detectTerminal,
	launchInTerminal,
	parseRequest,
	shQuote,
};
