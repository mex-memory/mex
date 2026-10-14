import { describe, expect, it } from "vitest";
import { GraphCandidateProcessError } from "../../graph/candidate-process.js";
import { IndexInUseError, IndexPathError, IndexPublishRecoveryError, WikiMaintenanceLockedError } from "../../wiki/index/dbfile.js";
import { WikiCorpusLimitError } from "../../wiki/index/corpus-policy.js";
import { WikiMaintenanceInterruptedError } from "../../wiki/index/maintenance.js";
import type { WikiDiagnostic } from "../../wiki/model/diagnostic.js";
import { SetupError } from "../errors.js";
import { classifySetupMaintenanceError, setupWikiFailureMessage } from "../maintenance-errors.js";

const PRIVATE = "private-token /private/project/secret.db";

describe("safe setup maintenance failures", () => {
  it.each([
    ["GRAPH_MAINTENANCE_LOCKED", "Wait for it to finish"],
    ["GRAPH_MAINTENANCE_GATE_STALE", "Verify no MEX process is running"],
    ["GRAPH_MAINTENANCE_RACE", "Wait for other writers"],
    ["GRAPH_PUBLICATION_FAILED", "recovery files"],
    ["GRAPH_INDEX_NOT_REFRESHABLE", "mex graph rebuild"],
    ["GRAPH_SOURCE_STAGING_FAILED", "read or parsed safely"],
  ])("projects %s by code while preserving its local diagnostic", (code, advice) => {
    const original = Object.assign(new Error(PRIVATE), { code, recoveryPath: PRIVATE, diagnostics: [{ message: PRIVATE }] });
    const result = classifySetupMaintenanceError(original, "graph");
    expect(result).toBeInstanceOf(SetupError);
    expect(result?.message).toContain(PRIVATE);
    expect(result?.cause).toBe(original);
    expect(result?.userMessage).toContain(advice);
    expect(result?.userMessage).not.toContain(PRIVATE);
    expect(result!.userMessage.length).toBeLessThanOrEqual(512);
  });

  it.each(["compatibility", "staging", "failed", "unsafe", "cancelled"] as const)("explains a graph worker %s without its raw diagnostics", (category) => {
    const error = new GraphCandidateProcessError(category);
    error.message = PRIVATE;
    const result = classifySetupMaintenanceError(error, "graph");
    expect(result?.userMessage).toContain("Code graph setup could not finish.");
    expect(result?.userMessage).toContain("setup");
    expect(result?.userMessage).not.toContain(PRIVATE);
    expect(result?.message).toContain(PRIVATE);
  });

  it.each([
    ["entrypoint-missing", "Rebuild MEX"],
    ["spawn", "execution permissions"],
    ["startup-timeout", "startup deadline"],
    ["build-timeout", "build time limit"],
    ["protocol", "invalid response"],
    ["ipc-disconnected", "lost communication"],
    ["observer", "could not process"],
    ["worker-error", "worker diagnostics"],
  ] as const)("explains the worker lifecycle failure %s without exposing stderr", (reason, advice) => {
    const result = classifySetupMaintenanceError(new GraphCandidateProcessError("failed", {
      reason, stderr: PRIVATE,
    }), "graph");
    expect(result?.userMessage).toContain(advice);
    expect(result?.userMessage).not.toContain(PRIVATE);
    expect(result?.message).toContain(PRIVATE);
    expect(result!.userMessage.length).toBeLessThanOrEqual(512);
  });

  it("explains confirmed heap exhaustion but does not infer it from a signal", () => {
    const heap = classifySetupMaintenanceError(new GraphCandidateProcessError("failed", {
      reason: "exit", signal: "SIGABRT", resourceFailure: "heap-limit", stderr: PRIVATE,
    }), "graph");
    expect(heap?.userMessage).toContain("JavaScript heap limit");
    expect(heap?.userMessage).toContain("NODE_OPTIONS");
    expect(heap?.userMessage).not.toContain(PRIVATE);
    for (const signal of ["SIGABRT", "SIGKILL"] as const) {
      const terminated = classifySetupMaintenanceError(new GraphCandidateProcessError("failed", {
        reason: "exit", signal, stderr: PRIVATE,
      }), "graph");
      expect(terminated?.userMessage).toContain("terminated by a signal");
      expect(terminated?.userMessage).not.toContain("heap");
    }
    expect(classifySetupMaintenanceError(new GraphCandidateProcessError("failed", {
      reason: "exit", exitCode: 7,
    }), "graph")?.userMessage).toContain("exited with status 7");
  });

  it.each([
    [new WikiMaintenanceLockedError(PRIVATE), "Another Wiki operation"],
    [new WikiCorpusLimitError("maxFileBytes"), "wiki.exclude"],
    [new WikiMaintenanceInterruptedError("publish"), "Wait for other writers"],
    [new IndexPublishRecoveryError(PRIVATE, PRIVATE, new Error(PRIVATE), new Error(PRIVATE)), "recovery files were retained"],
    [new IndexInUseError(PRIVATE, new Error(PRIVATE)), "Close other processes"],
    [new IndexPathError(PRIVATE), "redirected, or conflicting paths"],
  ])("projects the expected Wiki failure %s", (error, advice) => {
    const result = classifySetupMaintenanceError(error, "wiki");
    expect(result?.userMessage).toContain(advice);
    expect(result?.userMessage).not.toContain(PRIVATE);
  });

  it.each([
    [{ code: "EACCES" }, "permissions"],
    [{ code: "ENOSPC" }, "Free disk space"],
    [{ code: "SQLITE_BUSY" }, "database is busy"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 262 }, "database is busy"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 13 }, "ran out of storage"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 8 }, "database is read-only"],
  ])("projects filesystem/SQLite codes without inspecting their text: %j", (fields, advice) => {
    const result = classifySetupMaintenanceError(Object.assign(new Error(PRIVATE), fields), "grounding");
    expect(result?.userMessage).toContain(advice);
    expect(result?.userMessage).not.toContain(PRIVATE);
  });

  it("keeps unrelated exceptions and SQLite failures unclassified", () => {
    for (const error of [new Error(PRIVATE), Object.assign(new Error(PRIVATE), { code: "UNKNOWN" }),
      Object.assign(new Error(PRIVATE), { code: "ERR_SQLITE_ERROR", errcode: 1 }),
      { code: "GRAPH_MAINTENANCE_LOCKED", message: PRIVATE }]) {
      expect(classifySetupMaintenanceError(error, "wiki")).toBeNull();
    }
  });
});

describe("Wiki setup remediation", () => {
  it("uses the registry's blocking remediation and a safe relative location", () => {
    const message = setupWikiFailureMessage("validation", [
      { code: "ORPHANED_ENTITY", severity: "info", message: PRIVATE },
      { code: "INVALID_ENTITY_ID", severity: "error", message: PRIVATE, remediation: PRIVATE, file: "context/setup.md" },
    ]);
    expect(message).toContain("INVALID_ENTITY_ID in .mex/context/setup.md");
    expect(message).toContain("Do not hand-edit them");
    expect(message).toContain("Retry setup");
    expect(message).not.toContain(PRIVATE);
  });

  it("explains the runtime fix for missing FTS5 instead of prescribing a CLI setup rerun", () => {
    const message = setupWikiFailureMessage("index", [{ code: "WIKI_INDEX_FTS5_UNAVAILABLE", severity: "error", message: PRIVATE }]);
    expect(message).toContain("use a different Node build/version");
    expect(message).toContain("Rebuilding cannot fix this");
    expect(message).not.toContain("setup --cli");
  });

  it.each(["/private/project/secret.md", "../outside.md", "C:\\private\\secret.md", "context/secret\nname.md"])("omits unsafe location %s", (file) => {
    const message = setupWikiFailureMessage("plan", [{ code: "WIKI_PARSE_ERROR", severity: "error", message: PRIVATE, file }]);
    expect(message).not.toContain(file);
    expect(message).not.toContain(" in ");
  });

  it("bounds long locations while retaining the retry action and avoids false no-write promises", () => {
    const message = setupWikiFailureMessage("migration", [{ code: "WRITE_SCOPE_VIOLATION", severity: "error", message: PRIVATE,
      file: `context/${"x".repeat(135)}.md` }]);
    expect(message.length).toBeLessThanOrEqual(512);
    expect(message).toContain("Retry setup");
    expect(message).toContain("wiki.readOnly");
    expect(message).not.toContain("Nothing was written");
  });

  it("does not echo unknown diagnostic codes or prose", () => {
    const message = setupWikiFailureMessage("migration", [{ code: PRIVATE, severity: "error", message: PRIVATE } as unknown as WikiDiagnostic]);
    expect(message).not.toContain(PRIVATE);
    expect(message).toContain("retry setup");
  });
});
