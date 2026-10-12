import { describe, expect, test } from "bun:test";
import {
	CLOSED_ENTRY_TYPE,
	SPAWN_ENTRY_TYPE,
	collectForks,
	manageForks,
	parseManagementCommand,
	terminalScope,
	terminalSource,
	type ForkData,
	type ManagedFork,
	type TerminalKind,
} from "./side-management";

const PARENT = "/sessions/parent.jsonl";
const CHILD = "/sessions/child-7.jsonl";

function spawnEntry(id: string, data: Partial<ForkData> & Pick<ForkData, "target">, parent = PARENT) {
	return {
		type: "custom",
		customType: SPAWN_ENTRY_TYPE,
		id,
		data: { parentSessionFile: parent, terminal: "tmux", placement: "split", prompt: "p", at: "t", ...data },
	};
}

function closedEntry(spawnEntryId: string, parent = PARENT) {
	return { type: "custom", customType: CLOSED_ENTRY_TYPE, id: `c-${spawnEntryId}`, data: { parentSessionFile: parent, spawnEntryId } };
}

describe("parseManagementCommand", () => {
	test("accepts the three commands with strict arity", () => {
		expect(parseManagementCommand("list")).toEqual({ action: "list" });
		expect(parseManagementCommand("  focus   3 ")).toEqual({ action: "focus", number: 3 });
		expect(parseManagementCommand("close 12")).toEqual({ action: "close", number: 12 });
	});

	test("anything that is not a leading command stays a prompt", () => {
		expect(parseManagementCommand("")).toBeNull();
		expect(parseManagementCommand("-- list")).toBeNull();
		expect(parseManagementCommand("--bg list")).toBeNull();
		expect(parseManagementCommand("why does list fail")).toBeNull();
		expect(parseManagementCommand("listing files")).toBeNull();
		expect(parseManagementCommand("closed form?")).toBeNull();
	});

	test("malformed commands are errors, never prompts or guesses", () => {
		expect(() => parseManagementCommand("list now")).toThrow(/no arguments/);
		expect(() => parseManagementCommand("focus")).toThrow(/exactly one/);
		expect(() => parseManagementCommand("close 1 2")).toThrow(/exactly one/);
		for (const bad of ["0", "-1", "1.5", "01", "abc", "1e2", "99999999999999999999"]) {
			expect(() => parseManagementCommand(`close ${bad}`)).toThrow(/positive whole number/);
		}
		expect(() => parseManagementCommand("close nope")).toThrow(/-- list/);
	});
});

describe("collectForks", () => {
	test("numbers this session's forks in creation order and skips inherited records", () => {
		const entries = [
			spawnEntry("inherited", { target: "%1" }, "/sessions/grandparent.jsonl"),
			{ type: "message", id: "m1" },
			spawnEntry("a", { target: "%2" }),
			closedEntry("a", "/sessions/grandparent.jsonl"),
			spawnEntry("b", { target: "%3", scope: "tmux:abc", childSessionFile: CHILD, source: "%0", automatic: true }),
			closedEntry("b"),
			spawnEntry("c", { target: "%4" }),
		];
		const forks = collectForks(entries, PARENT);
		expect(forks.map((fork) => [fork.number, fork.entryId, fork.closed])).toEqual([
			[1, "a", false],
			[2, "b", true],
			[3, "c", false],
		]);
		expect(forks[1].data).toMatchObject({ scope: "tmux:abc", childSessionFile: CHILD, source: "%0", automatic: true });
		expect(forks[0].data.scope).toBeUndefined();
	});

	test("ignores malformed spawn records and close records without a matching spawn", () => {
		const entries = [
			{ type: "custom", customType: SPAWN_ENTRY_TYPE, id: "x", data: { parentSessionFile: PARENT, target: 5 } },
			{ type: "custom", customType: SPAWN_ENTRY_TYPE, data: { parentSessionFile: PARENT, target: "%1", terminal: "tmux", placement: "tab" } },
			{ type: "custom", customType: SPAWN_ENTRY_TYPE, id: "y", data: { parentSessionFile: PARENT, target: "%1", terminal: "screen", placement: "tab" } },
			null,
			"text",
			closedEntry("ghost"),
			spawnEntry("ok", { target: "%9" }),
		];
		expect(collectForks(entries, PARENT).map((fork) => fork.entryId)).toEqual(["ok"]);
	});
});

describe("terminalScope and terminalSource", () => {
	test("tmux scope follows the server, not the client", () => {
		const a = terminalScope("tmux", { TMUX: "/tmp/tmux-1/default,111,0" });
		expect(terminalScope("tmux", { TMUX: "/tmp/tmux-1/default,111,5" })).toBe(a);
		expect(terminalScope("tmux", { TMUX: "/tmp/tmux-1/other,111,0" })).not.toBe(a);
		expect(terminalScope("tmux", { TMUX: "/tmp/tmux-1/default,222,0" })).not.toBe(a);
		expect(a).not.toContain("tmux-1");
	});

	test("each terminal keys on its own routing environment", () => {
		expect(terminalScope("tern", { TERN_WINDOW_KEY: "w1" })).not.toBe(terminalScope("tern", { TERN_WINDOW_KEY: "w2" }));
		expect(terminalScope("tern", { TERN_DAEMON_SOCKET: "/a", TERN_WINDOW_KEY: "w" })).not.toBe(
			terminalScope("tern", { TERN_DAEMON_SOCKET: "/b", TERN_WINDOW_KEY: "w" }),
		);
		expect(terminalScope("cmux", { CMUX_WORKSPACE_ID: "workspace:1" })).not.toBe(
			terminalScope("cmux", { CMUX_WORKSPACE_ID: "workspace:2" }),
		);
		expect(terminalScope("kitty", { KITTY_LISTEN_ON: "unix:/a" })).not.toBe(terminalScope("kitty", { KITTY_LISTEN_ON: "unix:/b" }));
		expect(terminalScope("wezterm", { WEZTERM_UNIX_SOCKET: "/a" })).not.toBe(terminalScope("wezterm", { WEZTERM_UNIX_SOCKET: "/b" }));
		expect(terminalScope("tmux", { TMUX: "/s,1,0" })).not.toBe(terminalScope("wezterm", { WEZTERM_UNIX_SOCKET: "/s" }));
	});

	test("source uses the target representation and rejects what cannot be managed", () => {
		expect(terminalSource("tmux", { TMUX_PANE: "%4" })).toBe("%4");
		expect(terminalSource("tmux", { TMUX_PANE: "4" })).toBeUndefined();
		expect(terminalSource("tern", { TERN_PANE: "77" })).toBe("block:77");
		expect(terminalSource("tern", {})).toBeUndefined();
		expect(terminalSource("wezterm", { WEZTERM_PANE: "3" })).toBe("3");
		expect(terminalSource("kitty", { KITTY_WINDOW_ID: "x" })).toBeUndefined();
		expect(terminalSource("cmux", { CMUX_SURFACE_ID: "surface:2" })).toBe("surface:2");
		expect(terminalSource("ghostty", { TERM_PROGRAM: "ghostty" })).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------------------------

interface Reply {
	code?: number;
	stdout?: string;
	stderr?: string;
}

interface Harness {
	calls: { command: string; args: string[] }[];
	notes: { message: string; level: string }[];
	closed: string[];
	confirms: { title: string; message: string }[];
	options: Parameters<typeof manageForks>[2];
	/** Calls that are not read-only inventory queries. */
	mutations: () => string[];
}

/** The backend calls that only read an inventory; everything else counts as a mutation. */
function isInventoryRead(args: string[]): boolean {
	return (
		["list-panes", "inspect"].includes(args[0]) ||
		(args[0] === "cli" && args[1] === "list") ||
		(args[0] === "@" && args[1] === "ls") ||
		args.includes("tree")
	);
}

function harness(
	env: NodeJS.ProcessEnv,
	respond: (command: string, args: string[], call: number) => Reply,
	answer: boolean | (() => boolean) = true,
): Harness {
	const calls: Harness["calls"] = [];
	const notes: Harness["notes"] = [];
	const closed: string[] = [];
	const confirms: Harness["confirms"] = [];
	const options: Harness["options"] = {
		env,
		platform: "linux",
		run: async (command, args) => {
			calls.push({ command, args });
			const reply = respond(command, args, calls.length);
			return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
		},
		confirm: async (title, message) => {
			confirms.push({ title, message });
			return typeof answer === "function" ? answer() : answer;
		},
		notify: (message, level) => notes.push({ message, level }),
		recordClose: (id) => closed.push(id),
	};
	return {
		calls,
		notes,
		closed,
		confirms,
		options,
		mutations: () =>
			calls
				.filter((call) => !isInventoryRead(call.args))
				.map((call) => `${call.command} ${call.args.join(" ")}`),
	};
}

function fork(env: NodeJS.ProcessEnv, terminal: TerminalKind, data: Partial<ForkData> & Pick<ForkData, "target">, number = 1): ManagedFork {
	return {
		number,
		entryId: `spawn-${number}`,
		closed: false,
		data: {
			parentSessionFile: PARENT,
			childSessionFile: CHILD,
			terminal,
			placement: "split",
			prompt: "audit the cache",
			at: "t",
			scope: terminalScope(terminal, env),
			...data,
		},
	};
}

const tmuxEnv = { TMUX: "/tmp/tmux-1/default,111,0", TMUX_PANE: "%1", PATH: "" };
const tmuxPanes = `%1 0 -zsh\n%5 0 vim notes.md\n%7 0 omp --resume '${CHILD}' 'audit the cache'\n%8 1 omp --resume ${CHILD}`;
const tmuxRespond = (panes = tmuxPanes) => (_command: string, args: string[]): Reply => (args[0] === "list-panes" ? { stdout: panes } : {});

describe("manageForks list", () => {
	test("reports live, gone, closed, unverified and unavailable forks without private details", async () => {
		const live = fork(tmuxEnv, "tmux", { target: "%7" });
		const gone = fork(tmuxEnv, "tmux", { target: "%9", prompt: "second\nline" }, 2);
		const closed = { ...fork(tmuxEnv, "tmux", { target: "%7" }, 3), closed: true };
		const legacy = fork(tmuxEnv, "tmux", { target: "%7", scope: undefined, childSessionFile: undefined }, 4);
		const elsewhere = fork(tmuxEnv, "tmux", { target: "%7", scope: terminalScope("tmux", { TMUX: "/other,1,0" }) }, 5);
		const ghostty = fork(tmuxEnv, "ghostty", { target: "Ghostty window", placement: "window" }, 6);
		const h = harness(tmuxEnv, tmuxRespond());
		await manageForks({ action: "list" }, [live, gone, closed, legacy, elsewhere, ghostty], h.options);

		expect(h.notes).toHaveLength(1);
		const text = h.notes[0].message;
		expect(text).toMatch(/1\. live .*audit the cache/);
		expect(text).toMatch(/2\. gone .*second/);
		expect(text).toMatch(/3\. closed/);
		expect(text).toMatch(/4\. unverified/);
		expect(text).toMatch(/5\. unavailable .*different tmux server/);
		expect(text).toMatch(/6\. unavailable .*Ghostty/);
		expect(text).not.toContain("/sessions/");
		expect(text).not.toContain(live.data.scope as string);
		expect(h.mutations()).toEqual([]);
		// One inventory read serves every fork.
		expect(h.calls).toHaveLength(1);
	});

	test("an inventory failure is unavailable and loud, never gone", async () => {
		const h = harness(tmuxEnv, () => ({ code: 1, stderr: "no server running" }));
		await manageForks({ action: "list" }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options);
		expect(h.notes[0].level).toBe("warning");
		expect(h.notes[0].message).toMatch(/1\. unavailable .*no server running/);
		expect(h.notes[0].message).not.toMatch(/gone/);
	});

	test("an empty session says so", async () => {
		const h = harness(tmuxEnv, tmuxRespond());
		await manageForks({ action: "list" }, [], h.options);
		expect(h.notes[0].message).toMatch(/No side forks/);
		expect(h.calls).toEqual([]);
	});
});

describe("manageForks focus", () => {
	test("recognizes tmux's quoted shell-command argument", async () => {
		const command = `"'omp' '--resume' '${CHILD}'"`;
		const h = harness(tmuxEnv, tmuxRespond(`%7 0 ${command}`));
		await manageForks({ action: "focus", number: 1 }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options);
		expect(h.mutations()).toEqual(["tmux select-window -t %7", "tmux select-pane -t %7"]);
	});

	test("does not confuse a path prefix or a prompt mention with the resumed child", async () => {
		for (const command of [`omp --resume '${CHILD}.backup'`, `omp --resume '/elsewhere.jsonl' '${CHILD}'`]) {
			const h = harness(tmuxEnv, tmuxRespond(`%7 0 ${command}`));
			await manageForks({ action: "close", number: 1 }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options);
			expect(h.confirms).toEqual([]);
			expect(h.mutations()).toEqual([]);
			expect(h.closed).toEqual([]);
		}
	});

	test("focuses exactly the recorded pane after reading the inventory", async () => {
		const h = harness(tmuxEnv, tmuxRespond());
		await manageForks({ action: "focus", number: 1 }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options);
		expect(h.calls.map((call) => call.args[0])).toEqual(["list-panes", "select-window", "select-pane"]);
		expect(h.calls[1].args).toEqual(["select-window", "-t", "%7"]);
		expect(h.calls[2].args).toEqual(["select-pane", "-t", "%7"]);
		expect(h.notes.at(-1)).toMatchObject({ level: "info" });
	});

	test("refuses Ghostty explicitly and touches nothing", async () => {
		const env = { TERM_PROGRAM: "ghostty", PATH: "" };
		const h = harness(env, () => ({}));
		await manageForks({ action: "focus", number: 1 }, [fork(env, "ghostty", { target: "Ghostty window", placement: "window" })], h.options);
		expect(h.calls).toEqual([]);
		expect(h.notes).toEqual([{ message: expect.stringMatching(/Ghostty windows have no stable target/), level: "error" }]);
	});

	test("an unknown number is an error", async () => {
		const h = harness(tmuxEnv, tmuxRespond());
		await manageForks({ action: "focus", number: 4 }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options);
		expect(h.calls).toEqual([]);
		expect(h.notes[0]).toMatchObject({ level: "error", message: expect.stringMatching(/no side fork 4/) });
	});

	test("CLI failures propagate instead of being reported as a missing pane", async () => {
		const h = harness(tmuxEnv, () => ({ code: 1, stderr: "server exited unexpectedly" }));
		await expect(manageForks({ action: "focus", number: 1 }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options)).rejects.toThrow(
			/server exited unexpectedly/,
		);
		expect(h.mutations()).toEqual([]);
	});
});

describe("manageForks close", () => {
	test("closes exactly the recorded pane after confirmation and records it", async () => {
		const h = harness(tmuxEnv, tmuxRespond());
		await manageForks({ action: "close", number: 1 }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options);
		expect(h.mutations()).toEqual(["tmux kill-pane -t %7"]);
		expect(h.closed).toEqual(["spawn-1"]);
		expect(h.confirms).toHaveLength(1);
		expect(h.confirms[0].message).toMatch(/terminates any process/);
		expect(h.confirms[0].message).toMatch(/transcript is kept/);
		// Validated before the dialog and again after it.
		expect(h.calls.map((call) => call.args[0])).toEqual(["list-panes", "list-panes", "kill-pane"]);
	});

	test("declining the confirmation leaves everything untouched", async () => {
		const h = harness(tmuxEnv, tmuxRespond(), false);
		await manageForks({ action: "close", number: 1 }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options);
		expect(h.mutations()).toEqual([]);
		expect(h.closed).toEqual([]);
		expect(h.notes.at(-1)?.message).toMatch(/left open/);
	});

	test("a pane that vanishes while the dialog is open is not closed or recorded", async () => {
		let reads = 0;
		const h = harness(tmuxEnv, (_command, args) => {
			if (args[0] !== "list-panes") return {};
			reads += 1;
			return { stdout: reads === 1 ? tmuxPanes : "%1 0 -zsh" };
		});
		await manageForks({ action: "close", number: 1 }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options);
		expect(h.mutations()).toEqual([]);
		expect(h.closed).toEqual([]);
		expect(h.notes.at(-1)).toMatchObject({ level: "error", message: expect.stringMatching(/no longer exists/) });
	});

	test("a pane reused by a different program while the dialog is open is not closed", async () => {
		let reads = 0;
		const h = harness(tmuxEnv, (_command, args) => {
			if (args[0] !== "list-panes") return {};
			reads += 1;
			return { stdout: reads === 1 ? tmuxPanes : "%1 0 -zsh\n%7 0 vim notes.md" };
		});
		await manageForks({ action: "close", number: 1 }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options);
		expect(h.mutations()).toEqual([]);
		expect(h.closed).toEqual([]);
		expect(h.notes.at(-1)?.message).toMatch(/no longer runs this fork/);
	});

	test("a failed close is thrown and not recorded", async () => {
		const h = harness(tmuxEnv, (_command, args) => (args[0] === "kill-pane" ? { code: 1, stderr: "can't find pane: %7" } : { stdout: tmuxPanes }));
		await expect(manageForks({ action: "close", number: 1 }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options)).rejects.toThrow(
			/can't find pane/,
		);
		expect(h.closed).toEqual([]);
	});

	test("never closes a pane that is not live and verified", async () => {
		const cases: [string, ManagedFork, NodeJS.ProcessEnv?][] = [
			["stale pane", fork(tmuxEnv, "tmux", { target: "%42" })],
			["dead pane", fork(tmuxEnv, "tmux", { target: "%8" })],
			["wrong program", fork(tmuxEnv, "tmux", { target: "%5" })],
			["wrong scope", fork(tmuxEnv, "tmux", { target: "%7", scope: terminalScope("tmux", { TMUX: "/other,1,0" }) })],
			["legacy record", fork(tmuxEnv, "tmux", { target: "%7", scope: undefined })],
			["legacy child", fork(tmuxEnv, "tmux", { target: "%7", childSessionFile: undefined })],
			["child is parent", fork(tmuxEnv, "tmux", { target: "%7", childSessionFile: PARENT })],
			["parent by environment", fork(tmuxEnv, "tmux", { target: "%1" })],
			["parent by source", fork(tmuxEnv, "tmux", { target: "%7", source: "%7" })],
			["malformed target", fork(tmuxEnv, "tmux", { target: "7" })],
			["other terminal", fork(tmuxEnv, "wezterm", { target: "7" })],
			["already closed", { ...fork(tmuxEnv, "tmux", { target: "%7" }), closed: true }],
		];
		for (const [name, candidate] of cases) {
			const h = harness(tmuxEnv, tmuxRespond());
			await manageForks({ action: "close", number: 1 }, [candidate], h.options);
			expect([name, h.mutations(), h.closed, h.confirms.length]).toEqual([name, [], [], 0]);
			expect(h.notes.at(-1)?.level).toBe("error");
		}
	});

	test("a wrong-scope fork does not even query the terminal", async () => {
		const h = harness(tmuxEnv, tmuxRespond());
		const elsewhere = fork(tmuxEnv, "tmux", { target: "%7", scope: terminalScope("tmux", { TMUX: "/other,1,0" }) });
		await manageForks({ action: "close", number: 1 }, [elsewhere], h.options);
		expect(h.calls).toEqual([]);
	});

	test("inventory failure blocks the close", async () => {
		const h = harness(tmuxEnv, () => ({ code: 1, stderr: "error connecting to /tmp/tmux-1/default" }));
		await expect(manageForks({ action: "close", number: 1 }, [fork(tmuxEnv, "tmux", { target: "%7" })], h.options)).rejects.toThrow(
			/error connecting/,
		);
		expect(h.confirms).toEqual([]);
		expect(h.closed).toEqual([]);
	});

	test("Ghostty close is rejected before any prompt", async () => {
		const env = { TERM_PROGRAM: "ghostty", PATH: "" };
		const h = harness(env, () => ({}));
		await manageForks({ action: "close", number: 1 }, [fork(env, "ghostty", { target: "Ghostty window", placement: "window" })], h.options);
		expect(h.calls).toEqual([]);
		expect(h.confirms).toEqual([]);
		expect(h.closed).toEqual([]);
	});
});

describe("manageForks per terminal", () => {
	test("tern uses the inspected block and the exact id", async () => {
		const env = { TERM_PROGRAM: "tern", TERN_PANE: "100", TERN_WINDOW_KEY: "w1", PATH: "" };
		const inspect = JSON.stringify({
			sessions: [
				{
					tabs: [
						{
							blocks: [
								{ id: 100, live: true, exited: null, command: null },
								{ id: 200, live: true, exited: null, command: `/usr/bin/env PATH=x omp --resume '${CHILD}'` },
								{ id: 300, live: true, exited: null, command: null },
								{ id: 400, live: false, exited: null, command: `omp --resume ${CHILD}` },
							],
						},
					],
				},
			],
		});
		const respond = (_command: string, args: string[]): Reply => (args[0] === "inspect" ? { stdout: inspect } : {});
		const h = harness(env, respond);
		await manageForks({ action: "close", number: 1 }, [fork(env, "tern", { target: "block:200" })], h.options);
		expect(h.mutations()).toEqual(["tern close 200"]);
		expect(h.closed).toEqual(["spawn-1"]);

		for (const target of ["block:100", "block:300", "block:400", "block:999"]) {
			const refused = harness(env, respond);
			await manageForks({ action: "close", number: 1 }, [fork(env, "tern", { target })], refused.options);
			expect([target, refused.mutations(), refused.closed]).toEqual([target, [], []]);
		}

		const focus = harness(env, respond);
		await manageForks({ action: "focus", number: 1 }, [fork(env, "tern", { target: "block:200" })], focus.options);
		expect(focus.mutations()).toEqual(["tern focus 200"]);
	});

	test("wezterm checks the pane list and not the prefix of an id", async () => {
		const env = { WEZTERM_PANE: "1", WEZTERM_UNIX_SOCKET: "/tmp/wz", PATH: "" };
		const respond = (_command: string, args: string[]): Reply => (args[0] === "cli" && args[1] === "list" ? { stdout: JSON.stringify([{ pane_id: 1 }, { pane_id: 55 }]) } : {});
		const h = harness(env, respond);
		await manageForks({ action: "close", number: 1 }, [fork(env, "wezterm", { target: "55" })], h.options);
		expect(h.mutations()).toEqual(["wezterm cli kill-pane --pane-id 55"]);

		const stale = harness(env, respond);
		await manageForks({ action: "close", number: 1 }, [fork(env, "wezterm", { target: "5" })], stale.options);
		expect(stale.mutations()).toEqual([]);

		const parent = harness(env, respond);
		await manageForks({ action: "close", number: 1 }, [fork(env, "wezterm", { target: "1" })], parent.options);
		expect(parent.mutations()).toEqual([]);

		const focus = harness(env, respond);
		await manageForks({ action: "focus", number: 1 }, [fork(env, "wezterm", { target: "55" })], focus.options);
		expect(focus.mutations()).toEqual(["wezterm cli activate-pane --pane-id 55"]);
	});

	test("kitty matches the child's process and refuses the launcher's fallback target", async () => {
		const env = { KITTY_WINDOW_ID: "1", KITTY_LISTEN_ON: "unix:/tmp/kitty", PATH: "" };
		const listing = JSON.stringify([
			{
				tabs: [
					{
						windows: [
							{ id: 1, cmdline: ["zsh"] },
							{ id: 9, cmdline: ["omp", "--resume", CHILD] },
							{ id: 10, cmdline: ["zsh"], foreground_processes: [{ cmdline: ["vim"] }] },
						],
					},
				],
			},
		]);
		const respond = (_command: string, args: string[]): Reply => (args[0] === "@" && args[1] === "ls" ? { stdout: listing } : {});
		const h = harness(env, respond);
		await manageForks({ action: "close", number: 1 }, [fork(env, "kitty", { target: "9" })], h.options);
		expect(h.mutations()).toEqual(["kitten @ close-window --match id:9"]);

		for (const target of ["10", "1", "kitty:1", "77"]) {
			const refused = harness(env, respond);
			await manageForks({ action: "close", number: 1 }, [fork(env, "kitty", { target })], refused.options);
			expect([target, refused.mutations()]).toEqual([target, []]);
		}

		const focus = harness(env, respond);
		await manageForks({ action: "focus", number: 1 }, [fork(env, "kitty", { target: "9" })], focus.options);
		expect(focus.mutations()).toEqual(["kitten @ focus-window --match id:9"]);
	});

	test("cmux matches whole surface refs and refuses the surface running this session", async () => {
		const env = { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "UUID-OF-PARENT", PATH: "" };
		const tree = [
			"workspace workspace:1",
			"  pane pane:1",
			"    surface surface:12 [terminal] side",
			"    surface surface:3 [terminal] UUID-OF-PARENT parent",
		].join("\n");
		const respond = (_command: string, args: string[]): Reply => (args.includes("tree") ? { stdout: tree } : {});
		const h = harness(env, respond);
		await manageForks({ action: "close", number: 1 }, [fork(env, "cmux", { target: "surface:12" })], h.options);
		expect(h.mutations()).toEqual(["cmux close-surface --surface surface:12 --workspace workspace:1"]);

		// surface:1 must not match surface:12; surface:3 is the parent's own surface.
		for (const target of ["surface:1", "surface:3"]) {
			const refused = harness(env, respond);
			await manageForks({ action: "close", number: 1 }, [fork(env, "cmux", { target })], refused.options);
			expect([target, refused.mutations()]).toEqual([target, []]);
		}

		const focus = harness(env, respond);
		await manageForks({ action: "focus", number: 1 }, [fork(env, "cmux", { target: "surface:12" })], focus.options);
		expect(focus.mutations()).toEqual(["cmux focus-panel --panel surface:12 --workspace workspace:1"]);
	});
});
