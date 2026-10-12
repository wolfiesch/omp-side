import { describe, expect, test } from "bun:test";
import { __testing } from "./index";

const limits = { cols: 80, rows: 30 };
const auto = { placement: "auto" as const };

describe("repeat fork placement", () => {
	test("stacks below an existing fork without dividing a roomy parent again", () => {
		const panes = [{ id: "parent", cols: 240, rows: 120 }, { id: "fork", cols: 200, rows: 120 }];
		expect(__testing.planPlacement(auto, "parent", panes, limits, 2, ["fork"])).toEqual({
			placement: "split", pane: "fork", direction: "down",
		});
	});

	test("uses another member of the group when the newest fork cannot stack", () => {
		const panes = [
			{ id: "parent", cols: 240, rows: 120 },
			{ id: "older", cols: 120, rows: 90 },
			{ id: "newer", cols: 120, rows: 40 },
		];
		expect(__testing.planPlacement(auto, "parent", panes, limits, 2, ["newer", "older"])).toEqual({
			placement: "split", pane: "older", direction: "down",
		});
	});

	test("opens a tab when the side group is full even if the parent has space", () => {
		const panes = [{ id: "parent", cols: 240, rows: 120 }, { id: "fork", cols: 200, rows: 60 }];
		expect(__testing.planPlacement(auto, "parent", panes, limits, 2, ["fork"])).toEqual({ placement: "tab" });
	});

	test("ignores closed, moved-to-another-tab, and self targets", () => {
		const panes = [{ id: "parent", cols: 240, rows: 80 }];
		expect(__testing.planPlacement(auto, "parent", panes, limits, 2, ["missing", "parent"])).toEqual({
			placement: "split", pane: "parent", direction: "right",
		});
	});

	test("explicit placement overrides automatic grouping", () => {
		const panes = [{ id: "parent", cols: 240, rows: 120 }, { id: "fork", cols: 200, rows: 120 }];
		for (const request of [{ placement: "split" as const }, { placement: "split" as const, direction: "left" as const }]) {
			expect(__testing.planPlacement(request, "parent", panes, limits, 2, ["fork"])).toEqual({
				placement: "split", pane: "parent", direction: request.direction ?? "right",
			});
		}
		expect(__testing.planPlacement({ placement: "tab" }, "parent", panes, limits, 2, ["fork"])).toEqual({ placement: "tab" });
	});
});

describe("neighbor-aware fallback", () => {
	test("prefers a fitting edge neighbor over a larger distant pane", () => {
		const panes = [
			{ id: "source", cols: 80, rows: 40, left: 0, top: 0 },
			{ id: "near", cols: 170, rows: 40, left: 81, top: 0 },
			{ id: "far", cols: 400, rows: 120, left: 252, top: 0 },
		];
		expect(__testing.planPlacement(auto, "source", panes, limits, 2)).toEqual({
			placement: "split", pane: "near", direction: "right",
		});
	});

	test("recognizes vertical adjacency and rejects corner-only contact", () => {
		const panes = [
			{ id: "source", cols: 100, rows: 40, left: 0, top: 0 },
			{ id: "corner", cols: 400, rows: 120, left: 101, top: 41 },
			{ id: "below", cols: 100, rows: 90, left: 0, top: 41 },
		];
		expect(__testing.planPlacement(auto, "source", panes, limits, 2)).toEqual({
			placement: "split", pane: "below", direction: "down",
		});
	});

	test("tries distant panes when neighbors do not fit the requested axis", () => {
		const panes = [
			{ id: "source", cols: 100, rows: 40, left: 0, top: 0 },
			{ id: "near", cols: 100, rows: 90, left: 101, top: 0 },
			{ id: "far", cols: 220, rows: 90, left: 202, top: 0 },
		];
		expect(__testing.planPlacement({ placement: "split", direction: "left" }, "source", panes, limits, 2)).toEqual({
			placement: "split", pane: "far", direction: "left",
		});
	});
});
