import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { __testing } from "./index";

const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", GHOSTTY_RESOURCES_DIR: "/ghostty" };
const request = { focus: false, placement: "auto" as const, pull: false, ompArgs: [], prompt: "" };

describe("Herdr launch", () => {
	test("uses Herdr instead of inherited Ghostty and starts the fork in a split", async () => {
		const calls: string[][] = [];
		let script = "";
		const run = async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[1] === "run") {
				const path = args[3].slice(1, -1);
				script = readFileSync(path, "utf8");
				rmSync(dirname(path), { recursive: true });
			}
			const result = args[1] === "layout"
				? { layout: { workspace_id: "w1", panes: [{ pane_id: "w1:p1", rect: { width: 240, height: 80, x: 0, y: 0 } }] } }
				: args[1] === "split" ? { pane: { pane_id: "w1:p2" } } : {};
			return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
		};
		const result = await __testing.launchInTerminal(run, env, "darwin", request, "/tmp/a b", ["omp", "literal ';$HOME"], "side");
		expect(result).toEqual({ terminal: "herdr", target: "w1:p2", placement: "split" });
		expect(calls[1]).toEqual(["pane", "split", "w1:p1", "--direction", "right", "--cwd", "/tmp/a b", "--env", "OMPCODE=", "--no-focus"]);
		expect(calls[2].slice(0, 3)).toEqual(["pane", "run", "w1:p2"]);
		expect(script).toContain("exec 'omp' 'literal '\\'';$HOME'");
	});

	test.each([
		["left", "x"],
		["up", "y"],
	] as const)("places the new fork %s of the original pane", async (direction, axis) => {
		const positions = new Map([
			["w1:p1", { x: 0, y: 0 }],
		]);
		const run = async (_command: string, args: string[]) => {
			let result: object = {};
			if (args[1] === "layout") {
				result = { layout: { workspace_id: "w1", panes: [
					{ pane_id: "w1:p1", rect: { width: 240, height: 120, x: 0, y: 0 } },
				] } };
			} else if (args[1] === "split") {
				const splitDirection = args[args.indexOf("--direction") + 1];
				positions.set("w1:p2", { x: splitDirection === "right" ? 120 : 0, y: splitDirection === "down" ? 60 : 0 });
				result = { pane: { pane_id: "w1:p2" } };
			} else if (args[1] === "swap") {
				const source = args[args.indexOf("--source-pane") + 1];
				const target = args[args.indexOf("--target-pane") + 1];
				const first = positions.get(source);
				const second = positions.get(target);
				if (!first || !second) throw new Error("cannot swap missing panes");
				positions.set(source, second);
				positions.set(target, first);
			} else if (args[1] === "run") {
				rmSync(dirname(args[3].slice(1, -1)), { recursive: true });
			}
			return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
		};
		const result = await __testing.launchInTerminal(
			run, env, "darwin", { ...request, placement: "split", direction }, "/tmp", ["omp"], "side",
		);
		expect(result).toEqual({ terminal: "herdr", target: "w1:p2", placement: "split" });
		expect(positions.get(result.target)![axis]).toBeLessThan(positions.get("w1:p1")![axis]);
	});

	test("opens a tab when no pane fits", async () => {
		const calls: string[][] = [];
		const run = async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[1] === "run") rmSync(dirname(args[3].slice(1, -1)), { recursive: true });
			const result = args[1] === "layout"
				? { layout: { workspace_id: "w1", panes: [{ pane_id: "w1:p1", rect: { width: 100, height: 40, x: 0, y: 0 } }] } }
				: args[1] === "create" ? { root_pane: { pane_id: "w1:p3" } } : {};
			return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
		};
		const result = await __testing.launchInTerminal(run, env, "darwin", request, "/tmp", ["omp"], "side");
		expect(result).toEqual({ terminal: "herdr", target: "w1:p3", placement: "tab" });
		expect(calls[1]).toEqual(["tab", "create", "--workspace", "w1", "--cwd", "/tmp", "--label", "side", "--env", "OMPCODE=", "--no-focus"]);
	});
});
