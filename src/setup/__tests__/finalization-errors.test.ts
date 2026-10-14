import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupWikiFinalizationResult } from "../wiki-finalize.js";
import { WikiMaintenanceLockedError } from "../../wiki/index/dbfile.js";
import { SetupError } from "../errors.js";

const mocks = vi.hoisted(() => ({ capture: vi.fn(), wiki: vi.fn() }));
vi.mock("../../graph/runtime.js", async (original) => ({ ...await original(), captureGroundingBaselines: mocks.capture }));
vi.mock("../wiki-finalize.js", () => ({ finalizeSetupWiki: mocks.wiki }));
vi.mock("../../config.js", async (original) => ({ ...await original(), findConfig: () => ({ wiki: {} }) }));

import { finalizeCodeRepoSetup, SetupFinalizationError } from "../index.js";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  mocks.capture.mockResolvedValue({ captured: 0, skipped: 0 });
});
afterEach(() => vi.restoreAllMocks());

describe("setup finalization expected failures", () => {
  it("preserves a graph failure locally while reporting actionable grounding advice", async () => {
    mocks.capture.mockRejectedValue(Object.assign(new Error("secret diagnostic /private/project"), { code: "GRAPH_MAINTENANCE_LOCKED" }));
    const failure = await finalizeCodeRepoSetup("/project", "/project/.mex").catch(error => error);
    expect(failure).toBeInstanceOf(SetupError);
    expect(failure.message).toContain("secret diagnostic");
    expect(failure.userMessage).toContain("Another graph operation is active");
    expect(failure.userMessage).not.toContain("secret");
    expect(mocks.wiki).not.toHaveBeenCalled();
  });

  it("keeps an unexpected grounding exception out of the browser allowlist", async () => {
    mocks.capture.mockRejectedValue(new Error("secret unexpected exception"));
    const failure = await finalizeCodeRepoSetup("/project", "/project/.mex").catch(error => error);
    expect(failure).not.toBeInstanceOf(SetupError);
    expect(failure.message).toContain("secret unexpected exception");
  });

  it("projects a thrown Wiki lock refusal", async () => {
    mocks.wiki.mockRejectedValue(new WikiMaintenanceLockedError("/private/project/wiki.db.lock"));
    const failure = await finalizeCodeRepoSetup("/project", "/project/.mex").catch(error => error);
    expect(failure).toBeInstanceOf(SetupError);
    expect(failure.userMessage).toContain("Another Wiki operation is active");
    expect(failure.userMessage).not.toContain("/private");
  });

  it("retains the finalization error type and reports a Wiki diagnostic's authored fix", async () => {
    mocks.wiki.mockResolvedValue({ ready: false, stage: "index", reason: "Wiki index rebuild failed validation.",
      diagnostics: [{ code: "WIKI_INDEX_FTS5_UNAVAILABLE", severity: "error", message: "private database error", remediation: "private override" }],
    } as SetupWikiFinalizationResult);
    const failure = await finalizeCodeRepoSetup("/project", "/project/.mex").catch(error => error);
    expect(failure).toBeInstanceOf(SetupFinalizationError);
    expect(failure).toBeInstanceOf(SetupError);
    expect(failure.message).toContain("WIKI_INDEX_FTS5_UNAVAILABLE");
    expect(failure.userMessage).toContain("use a different Node build/version");
    expect(failure.userMessage).toContain("Retry setup");
    expect(failure.userMessage).not.toContain("private");
    expect(failure.userMessage.length).toBeLessThanOrEqual(512);
  });

  it("preserves the existing grounding-remediation contract", async () => {
    mocks.capture.mockImplementation(async (_config, options) => {
      options.warn("Skipped grounding baseline for unavailable node <exact-node-id> in .mex/AGENTS.md.");
      return { captured: 0, skipped: 1 };
    });
    const failure = await finalizeCodeRepoSetup("/project", "/project/.mex").catch(error => error);
    expect(failure).toBeInstanceOf(SetupFinalizationError);
    expect(failure.message).toContain("<exact-node-id> in .mex/AGENTS.md");
    expect(failure.userMessage).toBe(failure.message);
    expect(failure.message.length).toBeLessThanOrEqual(512);
  });
});
