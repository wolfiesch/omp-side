import { describe, expect, test } from "bun:test";
import { __testing } from "./index";

interface Call {
	command: string;
	args: string[];
}

function runner(
	respond: (command: string, args: string[]) => { code?: number; stdout?: string; stderr?: string },
): { calls: Call[]; run: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> } {
	const calls: Call[] = [];
	return {
		calls,
		run: async (command, args) => {
			calls.push({ command, args });
			const result = respond(command, args);
			return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		},
	};
}

const baseRequest = {
	focus: true,
	placement: "auto" as const,
	pull: false,
	ompArgs: [],
	prompt: "",
};

const hostileArg = "a path/'quote'/$HOME; still one argument";
const argv = ["/opt/bin/omp", "--cwd", "/tmp/a b", "--fork", "/tmp/session's.jsonl", hostileArg];

describe("request parsing", () => {
	test("defaults to automatic placement", () => {
		expect(__testing.parseRequest("why now?")).toEqual({ ...baseRequest, prompt: "why now?" });
	});

	test("explicit directions force a split and tab remains explicit", () => {
		expect(__testing.parseRequest("--left -- question")).toMatchObject({ placement: "split", direction: "left" });
		expect(__testing.parseRequest("--split -- question").direction).toBeUndefined();
		expect(__testing.parseRequest("--tab -- question").placement).toBe("tab");
	});

	test("preserves escaped flag values and rejects malformed quoting", () => {
		expect(__testing.parseRequest("--model model\\ with\\ spaces --").ompArgs).toEqual([
			"--model",
			"model with spaces",
		]);
		expect(() => __testing.parseRequest("--model 'unterminated")).toThrow("unterminated quote");
		expect(() => __testing.parseRequest("--model trailing\\")).toThrow("trailing escape");
	});
});

describe("argument completion", () => {
	const models = [
		{
			selector: "@smol",
			label: "@smol",
			description: "anthropic/claude-haiku-4-5 · Fast, cheap role",
		},
		{
			selector: "anthropic/claude-opus-4-6",
			label: "anthropic/claude-opus-4-6",
			description: "Claude Opus 4.6 · minimal, low, medium, high, max",
		},
		{
			selector: "openai/gpt-5.4",
			label: "openai/gpt-5.4",
			description: "GPT-5.4 · low, medium, high, xhigh",
		},
	];

	test("completes side flags from the current token", () => {
		expect(__testing.getSideArgumentCompletions("--m", models)).toEqual([
			{
				value: "--model ",
				label: "--model",
				description: "Choose the side session model",
			},
		]);
	});

	test("completes models while preserving earlier options", () => {
		expect(__testing.getSideArgumentCompletions("--bg --model opus", models)).toEqual([
			{
				value: "--bg --model anthropic/claude-opus-4-6 ",
				label: "anthropic/claude-opus-4-6",
				description: "Claude Opus 4.6 · minimal, low, medium, high, max",
			},
		]);
		expect(__testing.getSideArgumentCompletions("--model @s", models)?.[0]?.value).toBe("--model @smol ");
	});

	test("completes reasoning levels and then returns to flags", () => {
		expect(__testing.getSideArgumentCompletions("--thinking h", models)).toEqual([
			{ value: "--thinking high ", label: "high", description: "High reasoning" },
		]);
		expect(
			__testing
				.getSideArgumentCompletions("--thinking high --p", models)
				?.map(item => item.value),
		).toEqual(["--thinking high --pull "]);
	});

	test("does not suggest options inside the prompt", () => {
		expect(__testing.getSideArgumentCompletions("--model @smol -- explain this", models)).toBeNull();
		expect(__testing.getSideArgumentCompletions("explain", models)).toBeNull();
	});
});

describe("tangent isolation", () => {
	test("persists an empty todo snapshot and fork boundary before launch", async () => {
		const customEntries: Array<{ customType: string; data: unknown }> = [];
		const messages: unknown[] = [];
		const forkCalls: unknown[][] = [];
		let closed = false;
		const childFile = await __testing.prepareSideFork(
			"/sessions/parent.jsonl",
			"/work",
			async (...args) => {
				forkCalls.push(args);
				return {
					appendCustomEntry(customType: string, data?: unknown) {
						customEntries.push({ customType, data });
						return "entry";
					},
					appendMessage(message: unknown) {
						messages.push(message);
						return "message";
					},
					getSessionFile() {
						return "/sessions/child.jsonl";
					},
					async close() {
						closed = true;
					},
				} as never;
			},
		);

		expect(childFile).toBe("/sessions/child.jsonl");
		expect(forkCalls).toEqual([["/sessions/parent.jsonl", "/work", undefined]]);
		expect(customEntries).toEqual([
			{
				customType: __testing.SIDE_CONTEXT_ENTRY,
				data: { parentSessionFile: "/sessions/parent.jsonl" },
			},
			{ customType: __testing.USER_TODO_EDIT_ENTRY, data: { phases: [] } },
		]);
		expect(messages).toEqual([
			expect.objectContaining({
				role: "developer",
				content: [
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining("parent owns every earlier todo"),
					}),
				],
			}),
		]);
		expect(closed).toBe(true);
	});

	test("recognizes only child context markers", () => {
		expect(
			__testing.isSideFork({
				sessionManager: {
					getBranch: () => [{ type: "custom", customType: __testing.SIDE_CONTEXT_ENTRY }],
				},
			} as Parameters<typeof __testing.isSideFork>[0]),
		).toBe(true);
		expect(
			__testing.isSideFork({
				sessionManager: {
					getBranch: () => [{ type: "custom", customType: "omp-side.spawn" }],
				},
			} as Parameters<typeof __testing.isSideFork>[0]),
		).toBe(false);
	});
});

describe("terminal detection", () => {
	test("prefers an inner multiplexer over its host emulator", () => {
		expect(__testing.detectTerminal({ TMUX: "/tmp/tmux", KITTY_WINDOW_ID: "4" })).toBe("tmux");
		expect(__testing.detectTerminal({ CMUX_WORKSPACE_ID: "workspace:1", TMUX: "/tmp/tmux" })).toBe(
			"cmux",
		);
	});

	test("prefers tmux running inside a Tern pane", () => {
		expect(__testing.detectTerminal({ TMUX: "/tmp/tmux", TERM_PROGRAM: "tern", TERN_PANE: "9" })).toBe("tmux");
	});

	test("recognizes direct terminal integrations", () => {
		expect(__testing.detectTerminal({ WEZTERM_PANE: "2" })).toBe("wezterm");
		expect(__testing.detectTerminal({ KITTY_WINDOW_ID: "3" })).toBe("kitty");
		expect(__testing.detectTerminal({ TERM_PROGRAM: "ghostty" })).toBe("ghostty");
		expect(__testing.detectTerminal({ TERM_PROGRAM: "tern", TERN_PANE: "9" })).toBe("tern");
	});
});

describe("child command PATH", () => {
	test("prepends the active runtime directory once", () => {
		expect(__testing.pathWithExecutableDir("/usr/bin:/bin", "/opt/runtime/bin/bun")).toBe(
			"/opt/runtime/bin:/usr/bin:/bin",
		);
		expect(__testing.pathWithExecutableDir("/opt/runtime/bin:/usr/bin", "/opt/runtime/bin/bun")).toBe(
			"/opt/runtime/bin:/usr/bin",
		);
		expect(__testing.pathWithExecutableDir("", "/opt/runtime/bin/bun")).toBe("/opt/runtime/bin");
		expect(__testing.pathWithExecutableDir(undefined, "/opt/runtime/bin/bun")).toBeUndefined();
	});
});

describe("automatic placement", () => {
	test("pane-count fallback uses a tab once the current layout already has a split", () => {
		expect(__testing.choosePlacement("auto", 2)).toBe("tab");
		expect(__testing.choosePlacement("auto", 1)).toBe("split");
		expect(__testing.choosePlacement("split", 4)).toBe("split");
	});

	const limits = { cols: 80, rows: 30 };
	const pane = (id: string, cols: number, rows: number) => ({ id, cols, rows });
	const auto = { placement: "auto" as const };

	test.each([
		["one wide pane splits beside itself", auto, [pane("s", 288, 85)], { placement: "split", pane: "s", direction: "right" }],
		[
			"a narrow source splits the largest pane that fits side by side",
			auto,
			[pane("s", 107, 93), pane("big", 208, 93), pane("mid", 170, 93)],
			{ placement: "split", pane: "big", direction: "right" },
		],
		[
			"two full columns stack below the source before trying other panes",
			auto,
			[pane("s", 142, 85), pane("o", 142, 85)],
			{ placement: "split", pane: "s", direction: "down" },
		],
		[
			"a short source stacks below the largest tall pane",
			auto,
			[pane("s", 142, 40), pane("o", 142, 85)],
			{ placement: "split", pane: "o", direction: "down" },
		],
		["a pane too small for either half opens a tab", auto, [pane("s", 120, 40)], { placement: "tab" }],
		[
			"an explicit direction only searches its own axis",
			{ placement: "split" as const, direction: "up" as const },
			[pane("s", 288, 85)],
			{ placement: "split", pane: "s", direction: "up" },
		],
		[
			"an explicit direction keeps left on another pane",
			{ placement: "split" as const, direction: "left" as const },
			[pane("s", 100, 85), pane("o", 180, 85)],
			{ placement: "split", pane: "o", direction: "left" },
		],
		[
			"a forced split without a fit divides the source in the requested direction",
			{ placement: "split" as const, direction: "left" as const },
			[pane("s", 142, 85), pane("o", 142, 85)],
			{ placement: "split", pane: "s", direction: "left" },
		],
		[
			"--split without a fit divides the source to the right",
			{ placement: "split" as const },
			[pane("s", 120, 40)],
			{ placement: "split", pane: "s", direction: "right" },
		],
		["--tab wins over available space", { placement: "tab" as const }, [pane("s", 288, 85)], { placement: "tab" }],
	])("%s", (_name, request, panes, expected) => {
		expect(__testing.planPlacement(request, "s", panes, limits)).toEqual(expected);
	});

	test("the divider cell counts against each half", () => {
		expect(__testing.planPlacement(auto, "s", [pane("s", 161, 30)], limits)).toMatchObject({ direction: "right" });
		expect(__testing.planPlacement(auto, "s", [pane("s", 160, 30)], limits)).toEqual({ placement: "tab" });
		expect(__testing.planPlacement(auto, "s", [pane("s", 80, 61)], limits)).toMatchObject({ direction: "down" });
		expect(__testing.planPlacement(auto, "s", [pane("s", 80, 60)], limits)).toEqual({ placement: "tab" });
	});

	test("minimum pane size comes from the environment and rejects invalid values", () => {
		expect(__testing.placementLimits({})).toEqual({ cols: 80, rows: 30 });
		expect(__testing.placementLimits({ OMP_SIDE_MIN_COLS: "60", OMP_SIDE_MIN_ROWS: " 20 " })).toEqual({
			cols: 60,
			rows: 20,
		});
		expect(() => __testing.placementLimits({ OMP_SIDE_MIN_COLS: "wide" })).toThrow(/OMP_SIDE_MIN_COLS/);
		expect(() => __testing.placementLimits({ OMP_SIDE_MIN_ROWS: "0" })).toThrow(/OMP_SIDE_MIN_ROWS/);
	});

	test("maps a cmux surface back to its owning pane", () => {
		expect(
			__testing.cmuxLayout(
				"├── pane pane:4\n│   └── surface surface:8\n└── pane pane:5\n    └── surface surface:9",
				"surface:8",
			),
		).toEqual({ paneCount: 2, ownerPane: "pane:4" });
	});
});

describe("terminal launch adapters", () => {
	test("cmux adds a terminal tab instead of a third split", async () => {
		const parentPath = "/Users/test/.local/bin:/usr/bin:/bin";
		const expectedPath = __testing.pathWithExecutableDir(parentPath, process.execPath);
		const fake = runner((_command, args) => {
			if (args.includes("tree")) {
				return {
					stdout:
						"├── pane pane:4 uuid-pane-4\n│   └── surface surface:8 uuid-surface-8\n└── pane pane:5 uuid-pane-5\n    └── surface surface:9 uuid-surface-9",
				};
			}
			if (args[0] === "new-surface") return { stdout: "surface:10" };
			return {};
		});
		const result = await __testing.launchInTerminal(
			fake.run,
			{ CMUX_WORKSPACE_ID: "workspace-uuid-2", CMUX_SURFACE_ID: "uuid-surface-8", PATH: parentPath },
			"darwin",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "surface:10", terminal: "cmux", placement: "tab" });
		expect(fake.calls.some((call) => call.args[0] === "new-split")).toBe(false);
		expect(fake.calls.find((call) => call.args[0] === "new-surface")?.args).toContain("pane:4");
		const command = fake.calls.find((call) => call.args[0] === "respawn-pane")?.args.at(-1);
		expect(command).toContain("'/usr/bin/env'");
		expect(command).toContain(`'PATH=${expectedPath}'`);
		expect(command).toContain("'a path/'\\''quote'\\''/$HOME; still one argument'");
	});

	test("cmux starts the child without waiting for the tab rename", async () => {
		const renameGate = Promise.withResolvers<void>();
		const renameStarted = Promise.withResolvers<void>();
		let respawnStarted = false;
		const run = async (_command: string, args: string[]) => {
			if (args.includes("tree")) {
				return {
					code: 0,
					stdout: "└── pane pane:4\n    └── surface surface:8",
					stderr: "",
				};
			}
			if (args[0] === "new-surface") {
				return { code: 0, stdout: "surface:10", stderr: "" };
			}
			if (args[0] === "rename-tab") {
				renameStarted.resolve();
				await renameGate.promise;
			}
			if (args[0] === "respawn-pane") {
				respawnStarted = true;
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		const launch = __testing.launchInTerminal(
			run,
			{ CMUX_WORKSPACE_ID: "workspace:2", CMUX_SURFACE_ID: "surface:8" },
			"darwin",
			{ ...baseRequest, placement: "tab" },
			"/tmp",
			argv,
			"side title",
		);
		await renameStarted.promise;
		expect(respawnStarted).toBe(true);
		renameGate.resolve();
		await launch;
	});

	test("tmux opens a new window when no pane in the window has room", async () => {
		const fake = runner((_command, args) =>
			args[0] === "list-panes" ? { stdout: "%1 100 40 1\n%2 100 40 0\n" } : { stdout: "%9" },
		);
		const result = await __testing.launchInTerminal(
			fake.run,
			{ TMUX: "/tmp/tmux", TMUX_PANE: "%1" },
			"linux",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "%9", terminal: "tmux", placement: "tab" });
		expect(fake.calls[0].args.slice(0, 3)).toEqual(["list-panes", "-t", "%1"]);
		expect(fake.calls[1].args[0]).toBe("new-window");
	});

	test("tmux splits a roomier sibling pane in the background", async () => {
		const fake = runner((_command, args) =>
			args[0] === "list-panes" ? { stdout: "%1 100 60 1\n%2 200 60 0\n" } : { stdout: "%9" },
		);
		const result = await __testing.launchInTerminal(
			fake.run,
			{ TMUX: "/tmp/tmux" },
			"linux",
			{ ...baseRequest, focus: false },
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "%9", terminal: "tmux", placement: "split" });
		expect(fake.calls[1].args.slice(0, -1)).toEqual([
			"split-window",
			"-P",
			"-F",
			"#{pane_id}",
			"-c",
			"/tmp/a b",
			"-t",
			"%2",
			"-h",
			"-d",
		]);
	});

	test("WezTerm splits a roomy single-pane tab with structured command arguments", async () => {
		const fake = runner((_command, args) =>
			args[1] === "list"
				? { stdout: JSON.stringify([{ pane_id: 7, tab_id: 3, size: { cols: 200, rows: 50 } }]) }
				: { stdout: "8" },
		);
		const result = await __testing.launchInTerminal(
			fake.run,
			{ WEZTERM_PANE: "7" },
			"linux",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "8", terminal: "wezterm", placement: "split" });
		expect(fake.calls[1].args).toEqual([
			"cli",
			"split-pane",
			"--right",
			"--pane-id",
			"7",
			"--cwd",
			"/tmp/a b",
			"--",
			...argv,
		]);
	});

	type TernFixtureBlock = [id: number, cols: number, rows: number, pip?: object];
	const ternTree = (blocks: TernFixtureBlock[]) =>
		JSON.stringify({
			sessions: [
				{ id: 1, tabs: [{ blocks: [{ id: 2, cols: 300, rows: 90 }] }] },
				{
					id: 40,
					tabs: [{ blocks: blocks.map(([id, cols, rows, pip]) => ({ id, cols, rows, pip: pip ?? null })) }],
				},
			],
		});

	test("Tern splits a single-pane tab to the left, then focuses the fork", async () => {
		const fake = runner((_command, args) =>
			args[0] === "inspect"
				? { stdout: ternTree([[41, 288, 85]]) }
				: args[0] === "split"
					? { stdout: JSON.stringify({ session: 40, tab: 50, block: 42 }) }
					: {},
		);
		const result = await __testing.launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "tern", TERN_PANE: "41" },
			"linux",
			{ ...baseRequest, direction: "left" },
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "block:42", terminal: "tern", placement: "split" });
		expect(fake.calls.slice(1).map((call) => call.args)).toEqual([
			["split", "41", "right", "--json", "--cwd", "/tmp/a b", "--", ...argv],
			["move", "42", "left-of", "41"],
			["focus", "42"],
		]);
	});

	test("Tern opens a background tab in the source session when no pane has room", async () => {
		const fake = runner((_command, args) =>
			args[0] === "inspect"
				? { stdout: ternTree([[41, 100, 40], [43, 100, 40]]) }
				: args[0] === "new"
					? { stdout: JSON.stringify({ session: 40, tab: 51, block: 44 }) }
					: {},
		);
		const result = await __testing.launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "tern", TERN_PANE: "41" },
			"linux",
			{ ...baseRequest, focus: false },
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "block:44", terminal: "tern", placement: "tab" });
		expect(fake.calls.slice(1).map((call) => call.args)).toEqual([
			["new", "tab", "40", "--json", "--cwd", "/tmp/a b", "--", ...argv],
			["rename", "44", "side title"],
		]);
	});

	test("Tern splits a wide sibling when the source is too narrow and ignores picture-in-picture panes", async () => {
		const fake = runner((_command, args) =>
			args[0] === "inspect"
				? { stdout: ternTree([[41, 107, 93], [43, 208, 93], [45, 300, 90, { owner: 43, corner: "br" }]]) }
				: args[0] === "split"
					? { stdout: JSON.stringify({ session: 40, tab: 50, block: 46 }) }
					: {},
		);
		const result = await __testing.launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "tern", TERN_PANE: "41" },
			"linux",
			{ ...baseRequest, focus: false },
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "block:46", terminal: "tern", placement: "split" });
		expect(fake.calls.slice(1).map((call) => call.args)).toEqual([
			["split", "43", "right", "--json", "--cwd", "/tmp/a b", "--", ...argv],
		]);
	});

	test("Kitty opens a new tab and preserves each command argument", async () => {
		const fake = runner((_command, args) =>
			args[1] === "ls"
				? {
					stdout: JSON.stringify([
						{ tabs: [{ windows: [{ id: 11 }, { id: 12 }] }] },
					]),
				}
				: { stdout: "13" },
		);
		const result = await __testing.launchInTerminal(
			fake.run,
			{ KITTY_WINDOW_ID: "11", PATH: "/missing" },
			"linux",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result).toEqual({ target: "13", terminal: "kitty", placement: "tab" });
		expect(fake.calls[1].args.slice(-argv.length)).toEqual(argv);
	});

	test("direct Ghostty preserves PATH without shell interpolation", async () => {
		const parentPath = "/Users/a path/'quote'/$HOME:/usr/bin";
		const expectedPath = __testing.pathWithExecutableDir(parentPath, process.execPath);
		const fake = runner(() => ({}));
		const result = await __testing.launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "ghostty", PATH: parentPath },
			"darwin",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result.placement).toBe("window");
		expect(fake.calls[0]).toEqual({
			command: "/usr/bin/open",
			args: [
				"-na",
				"Ghostty.app",
				"--args",
				"--working-directory=/tmp/a b",
				"-e",
				"/usr/bin/env",
				`PATH=${expectedPath}`,
				...argv,
			],
		});
	});

	test("direct Ghostty leaves its default environment when PATH is absent", async () => {
		const fake = runner(() => ({}));
		await __testing.launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "ghostty" },
			"darwin",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(fake.calls[0].args).toEqual([
			"-na",
			"Ghostty.app",
			"--args",
			"--working-directory=/tmp/a b",
			"-e",
			...argv,
		]);
	});
});

describe("profile propagation", () => {
	test("resolves named profile from session paths", () => {
		expect(
			__testing.resolveProfileFromSessionPath(
				"/Users/wolfgangschoenberger/.omp/profiles/ompgem/agent/sessions/--private-tmp--/2026-08-20T10-43-05-598Z_01a01ec4.jsonl",
			),
		).toBe("ompgem");
		expect(
			__testing.resolveProfileFromSessionPath(
				"C:\\Users\\user\\.omp\\profiles\\work\\agent\\sessions\\project\\session.jsonl",
			),
		).toBe("work");
		expect(
			__testing.resolveProfileFromSessionPath(
				"/Users/wolfgangschoenberger/.omp/agent/sessions/--private-tmp--/session.jsonl",
			),
		).toBeUndefined();
	});

	test("detects profile argument in request flags", () => {
		expect(__testing.hasProfileArg(["--model", "@slow", "--profile", "ompgpt"])).toBe(true);
		expect(__testing.hasProfileArg(["--profile=ompgpt"])).toBe(true);
		expect(__testing.hasProfileArg(["--model", "@slow", "--thinking", "high"])).toBe(false);
	});

	test("resolves active profile from environment and session path fallback", () => {
		expect(
			__testing.resolveActiveProfile("/path/without/profile.jsonl", {
				OMP_PROFILE: "ompgem",
			} as NodeJS.ProcessEnv),
		).toBe("ompgem");
		expect(
			__testing.resolveActiveProfile("/path/without/profile.jsonl", {
				PI_PROFILE: "ompgpt",
			} as NodeJS.ProcessEnv),
		).toBe("ompgpt");
		expect(
			__testing.resolveActiveProfile(
				"/Users/user/.omp/profiles/ompgem/agent/sessions/--private-tmp--/session.jsonl",
				{} as NodeJS.ProcessEnv,
			),
		).toBe("ompgem");
		expect(
			__testing.resolveActiveProfile(
				"/Users/user/.omp/agent/sessions/--private-tmp--/session.jsonl",
				{} as NodeJS.ProcessEnv,
			),
		).toBeUndefined();
	});

	test("buildChildArgv propagates active profile to child command", () => {
		const request = { ...baseRequest, prompt: "how does this work?" };
		const argv = __testing.buildChildArgv(
			"/usr/local/bin/omp",
			"/tmp",
			"/sessions/child.jsonl",
			request,
			"/Users/user/.omp/profiles/ompgem/agent/sessions/--private-tmp--/parent.jsonl",
			{} as NodeJS.ProcessEnv,
		);
		expect(argv).toEqual([
			"/usr/local/bin/omp",
			"--profile",
			"ompgem",
			"--cwd",
			"/tmp",
			"--resume",
			"/sessions/child.jsonl",
			"how does this work?",
		]);
	});

	test("buildChildArgv does not duplicate explicit --profile in request", () => {
		const request = {
			...baseRequest,
			ompArgs: ["--profile", "ompgpt"],
			prompt: "second opinion",
		};
		const argv = __testing.buildChildArgv(
			"/usr/local/bin/omp",
			"/tmp",
			"/sessions/child.jsonl",
			request,
			"/Users/user/.omp/profiles/ompgem/agent/sessions/--private-tmp--/parent.jsonl",
			{ OMP_PROFILE: "ompgem" } as NodeJS.ProcessEnv,
		);
		expect(argv).toEqual([
			"/usr/local/bin/omp",
			"--cwd",
			"/tmp",
			"--resume",
			"/sessions/child.jsonl",
			"--profile",
			"ompgpt",
			"second opinion",
		]);
	});

	test("buildChildArgv omits --profile when in default profile", () => {
		const request = { ...baseRequest, prompt: "question" };
		const argv = __testing.buildChildArgv(
			"/usr/local/bin/omp",
			"/tmp",
			"/sessions/child.jsonl",
			request,
			"/Users/user/.omp/agent/sessions/--private-tmp--/parent.jsonl",
			{} as NodeJS.ProcessEnv,
		);
		expect(argv).toEqual([
			"/usr/local/bin/omp",
			"--cwd",
			"/tmp",
			"--resume",
			"/sessions/child.jsonl",
			"question",
		]);
	});
});
