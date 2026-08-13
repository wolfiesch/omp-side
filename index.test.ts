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
	direction: "right" as const,
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
		expect(__testing.parseRequest("--left -- question").placement).toBe("split");
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

	test("recognizes direct terminal integrations", () => {
		expect(__testing.detectTerminal({ WEZTERM_PANE: "2" })).toBe("wezterm");
		expect(__testing.detectTerminal({ KITTY_WINDOW_ID: "3" })).toBe("kitty");
		expect(__testing.detectTerminal({ TERM_PROGRAM: "ghostty" })).toBe("ghostty");
	});
});

describe("automatic placement", () => {
	test("uses a tab once the current layout already has a split", () => {
		expect(__testing.choosePlacement("auto", 2)).toBe("tab");
		expect(__testing.choosePlacement("auto", 1)).toBe("split");
		expect(__testing.choosePlacement("split", 4)).toBe("split");
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
			{ CMUX_WORKSPACE_ID: "workspace-uuid-2", CMUX_SURFACE_ID: "uuid-surface-8" },
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
		expect(command).toContain("'a path/'\\''quote'\\''/$HOME; still one argument'");
	});

	test("tmux opens a new window when the current one is split", async () => {
		const fake = runner((_command, args) =>
			args[0] === "display-message" ? { stdout: "2" } : { stdout: "%9" },
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
		expect(fake.calls[1].args[0]).toBe("new-window");
	});

	test("WezTerm splits a single-pane tab with structured command arguments", async () => {
		const fake = runner((_command, args) =>
			args[1] === "list"
				? { stdout: JSON.stringify([{ pane_id: 7, tab_id: 3 }]) }
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

	test("direct Ghostty uses a new OS window without shell interpolation", async () => {
		const fake = runner(() => ({}));
		const result = await __testing.launchInTerminal(
			fake.run,
			{ TERM_PROGRAM: "ghostty" },
			"darwin",
			baseRequest,
			"/tmp/a b",
			argv,
			"side title",
		);

		expect(result.placement).toBe("window");
		expect(fake.calls[0]).toEqual({
			command: "/usr/bin/open",
			args: ["-na", "Ghostty.app", "--args", "--working-directory=/tmp/a b", "-e", ...argv],
		});
	});
});
