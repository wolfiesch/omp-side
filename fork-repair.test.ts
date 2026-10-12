import { describe, expect, test } from "bun:test";
import { __testing } from "./index";

interface FakeEntry {
	type: "message" | "custom" | "thinking_level_change";
	id: string;
	parentId: string | null;
	message?: Record<string, unknown>;
	customType?: string;
	data?: unknown;
}

interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, never>;
}

const toolCall = (id: string, name = "bash"): ToolCall => ({ type: "toolCall", id, name, arguments: {} });
const assistant = (...calls: ToolCall[]) => ({
	role: "assistant",
	content: [{ type: "text", text: "working" }, ...calls],
	stopReason: "toolUse",
});
const toolResult = (id: string, text = "ok") => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text }],
	isError: false,
});
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

function message(id: string, parentId: string | null, body: Record<string, unknown>): FakeEntry {
	return { type: "message", id, parentId, message: body };
}

/** Plain objects are message bodies; objects with a `type` are non-message entries. */
function chain(...bodies: Array<Record<string, unknown> | FakeEntry>): FakeEntry[] {
	const entries: FakeEntry[] = [];
	for (const [index, body] of bodies.entries()) {
		const parentId = index === 0 ? null : `e${index - 1}`;
		entries.push(
			"type" in body ? { ...(body as FakeEntry), id: `e${index}`, parentId } : message(`e${index}`, parentId, body),
		);
	}
	return entries;
}

/** Child manager shaped like OMP's: the branch is the copied history plus later appends. */
function forkOf(parentEntries: FakeEntry[], opts: { failOn?: "appendMessage" } = {}) {
	const childEntries: FakeEntry[] = structuredClone(parentEntries);
	const state = { closed: false, parentBefore: structuredClone(parentEntries) };
	const append = (entry: Omit<FakeEntry, "id" | "parentId">): string => {
		const id = `c${childEntries.length}`;
		childEntries.push({ ...entry, id, parentId: childEntries.at(-1)?.id ?? null });
		return id;
	};
	const factory = async () =>
		({
			getBranch: () => structuredClone(childEntries),
			appendMessage(body: Record<string, unknown>) {
				if (opts.failOn === "appendMessage") throw new Error("append failed");
				return append({ type: "message", message: body });
			},
			appendCustomEntry(customType: string, data?: unknown) {
				return append({ type: "custom", customType, data });
			},
			getSessionFile: () => "/sessions/child.jsonl",
			async close() {
				state.closed = true;
			},
		}) as never;
	return { factory, childEntries, state, parentEntries };
}

function resultsAfterBoundary(entries: FakeEntry[]): Array<Record<string, unknown>> {
	return entries
		.filter(entry => entry.type === "message" && entry.message?.role === "toolResult")
		.map(entry => entry.message as Record<string, unknown>);
}

describe("fork tool-call repair", () => {
	test("pairs every pending call on the tail assistant turn, before the tangent boundary", async () => {
		const parent = chain(user("go"), assistant(toolCall("a"), toolCall("b", "read")));
		const fork = forkOf(parent);
		await __testing.prepareSideFork("/sessions/parent.jsonl", "/work", fork.factory);

		const results = resultsAfterBoundary(fork.childEntries);
		expect(results.map(r => [r.toolCallId, r.toolName, r.isError])).toEqual([
			["a", "bash", true],
			["b", "read", true],
		]);
		for (const result of results) {
			expect(JSON.stringify(result.content)).toContain("outcome is unknown");
			expect(JSON.stringify(result.content)).not.toContain("success");
		}

		const firstResult = fork.childEntries.findIndex(e => e.message?.role === "toolResult");
		const boundary = fork.childEntries.findIndex(e => e.type === "custom" && e.customType === __testing.SIDE_CONTEXT_ENTRY);
		expect(firstResult).toBeGreaterThan(parent.length - 1);
		expect(firstResult).toBeLessThan(boundary);
		expect(fork.childEntries.at(-1)?.message?.role).toBe("developer");
		expect(fork.state.closed).toBe(true);
	});

	test("repairs only the missing results of a partially completed batch", async () => {
		const parent = chain(
			user("go"),
			assistant(toolCall("a"), toolCall("b"), toolCall("c")),
			toolResult("b", "finished before fork"),
		);
		const fork = forkOf(parent);
		await __testing.prepareSideFork("/sessions/parent.jsonl", "/work", fork.factory);

		const results = resultsAfterBoundary(fork.childEntries);
		expect(results.map(r => r.toolCallId)).toEqual(["b", "a", "c"]);
		expect(results[0]).toEqual(toolResult("b", "finished before fork"));
		expect(results.filter(r => r.toolCallId === "b")).toHaveLength(1);
	});

	test("leaves clean snapshots untouched", async () => {
		const completed = chain(user("go"), assistant(toolCall("a")), toolResult("a"));
		const textOnly = chain(user("go"), { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });
		const empty: FakeEntry[] = [];
		for (const parent of [completed, textOnly, empty]) {
			const fork = forkOf(parent);
			await __testing.prepareSideFork("/sessions/parent.jsonl", "/work", fork.factory);
			expect(fork.childEntries.slice(0, parent.length)).toEqual(parent);
			expect(resultsAfterBoundary(fork.childEntries)).toHaveLength(resultsAfterBoundary(parent).length);
		}
	});

	test("skips non-message entries between the call and the leaf", async () => {
		const parent = chain(
			user("go"),
			assistant(toolCall("a")),
			{ type: "custom", customType: "tool_execution_start", data: { toolCallId: "a" } } as FakeEntry,
			{ type: "thinking_level_change" } as FakeEntry,
		);
		const fork = forkOf(parent);
		await __testing.prepareSideFork("/sessions/parent.jsonl", "/work", fork.factory);
		expect(resultsAfterBoundary(fork.childEntries).map(r => r.toolCallId)).toEqual(["a"]);
	});

	test("does not append out-of-order results for calls buried under later messages", async () => {
		const parent = chain(user("go"), assistant(toolCall("a")), user("moved on"));
		const fork = forkOf(parent);
		await __testing.prepareSideFork("/sessions/parent.jsonl", "/work", fork.factory);
		expect(resultsAfterBoundary(fork.childEntries)).toEqual([]);
	});

	test("never modifies the parent history", async () => {
		const parent = chain(user("go"), assistant(toolCall("a"), toolCall("b")), toolResult("a"));
		const fork = forkOf(parent);
		await __testing.prepareSideFork("/sessions/parent.jsonl", "/work", fork.factory);
		expect(fork.parentEntries).toEqual(fork.state.parentBefore);
		expect(fork.childEntries.length).toBeGreaterThan(parent.length);
	});

	test("closes the child manager when repair fails", async () => {
		const parent = chain(user("go"), assistant(toolCall("a")));
		const fork = forkOf(parent, { failOn: "appendMessage" });
		await expect(__testing.prepareSideFork("/sessions/parent.jsonl", "/work", fork.factory)).rejects.toThrow(
			"append failed",
		);
		expect(fork.state.closed).toBe(true);
		expect(fork.childEntries.some(e => e.type === "custom" && e.customType === __testing.SIDE_CONTEXT_ENTRY)).toBe(false);
	});
});
