import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	flushGraphPhaseTimings,
	phaseTimingsEnabled,
	recordGraphPhase,
	resolvePhaseTimingsFile,
} from "../phase-timing.js";

// The timing sink touches node:fs; replace it entirely so tests observe the
// target file and directory without filying real bytes anywhere.
vi.mock("node:fs", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof import("node:fs");
	return {
		...actual,
		appendFileSync: vi.fn(),
		mkdirSync: vi.fn(),
	};
});

import { appendFileSync, mkdirSync } from "node:fs";

const APPEND = vi.mocked(appendFileSync);
const MKDIR = vi.mocked(mkdirSync);
const DEFAULT_FILE = join(".mex", "local", "graph-phase-timings.jsonl");

describe("resolvePhaseTimingsFile", () => {
	it.each(["1", "true", "on", "yes", "TRUE", " Yes "])("maps %s to the checkout-local default sink", (value) => {
		expect(resolvePhaseTimingsFile(value)).toBe(DEFAULT_FILE);
	});

	it.each([undefined, "", "   ", "0", "false", "off", "FALSE"])("treats %s as disabled", (value) => {
		expect(resolvePhaseTimingsFile(value)).toBeNull();
	});

	it("takes an operator-named path verbatim", () => {
		expect(resolvePhaseTimingsFile("timings.jsonl")).toBe("timings.jsonl");
	});
});

describe("phaseTimingsEnabled", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
	});

	it("follows the flag spellings", () => {
		vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "1");
		expect(phaseTimingsEnabled()).toBe(true);
		vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "false");
		expect(phaseTimingsEnabled()).toBe(false);
		vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "timings.jsonl");
		expect(phaseTimingsEnabled()).toBe(true);
	});
});

describe("flushGraphPhaseTimings", () => {
	beforeEach(() => {
		APPEND.mockClear();
		MKDIR.mockClear();
		vi.unstubAllEnvs();
	});

	it("appends to the default sink when the flag is switched on with a bare value", () => {
		vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "1");
		recordGraphPhase("graph.render", 3);
		recordGraphPhase("graph.render", 1);
		recordGraphPhase("graph.index", 10);
		flushGraphPhaseTimings("test");

		expect(MKDIR).toHaveBeenCalledWith(join(".mex", "local"), { recursive: true });
		expect(APPEND).toHaveBeenCalledTimes(1);
		const [file, line] = APPEND.mock.calls[0]!;
		expect(file).toBe(DEFAULT_FILE);
		const record = JSON.parse(line as string) as { label: string; phases: Record<string, number> };
		expect(record.label).toBe("test");
		expect(record.phases["graph.render"]).toBe(4);
		expect(record.phases["graph.index"]).toBe(10);

		// A second flush reports the cleared totals.
		flushGraphPhaseTimings("reset");
		expect(APPEND).toHaveBeenCalledTimes(2);
		expect((JSON.parse(APPEND.mock.calls[1]![1] as string) as { phases: object }).phases).toEqual({});
	});

	it("stays disabled for the flag-off spellings", () => {
		for (const value of ["0", "false", "off", ""]) {
			vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", value);
			recordGraphPhase("graph.render", 1);
			flushGraphPhaseTimings("test");
			expect(APPEND).not.toHaveBeenCalled();
			expect(MKDIR).not.toHaveBeenCalled();
		}
	});

	it("appends verbatim to an operator-named path without touching directories", () => {
		vi.stubEnv("MEX_GRAPH_PHASE_TIMINGS", "timings.jsonl");
		recordGraphPhase("graph.render", 5);
		flushGraphPhaseTimings("test");

		expect(MKDIR).not.toHaveBeenCalled();
		expect(APPEND).toHaveBeenCalledTimes(1);
		expect(APPEND.mock.calls[0]![0]).toBe("timings.jsonl");
	});
});
