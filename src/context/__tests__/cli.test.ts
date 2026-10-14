import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runContextIndex, runContextPrompt, runContextSemantic, type ContextIo } from "../cli.js";
import { indexPathOf } from "../index-store.js";
import { sessionDirOf } from "../session.js";
import { cleanupProjects, createProject, STANDARD_FACTS, writeEntities, type Fixture } from "./fixture.js";

const INVOICE_PROMPT =
  "The invoice total is one cent off after a discount is recalculated: does the tax round per line item before summing the lines?";

interface Captured {
  io: ContextIo;
  out: string[];
  err: string[];
  exit: () => number;
}

function capture(cwd: string): Captured {
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  return {
    io: {
      cwd,
      write: (line) => out.push(line),
      writeError: (line) => err.push(line),
      setExitCode: (value) => {
        code = value;
      },
    },
    out,
    err,
    exit: () => code,
  };
}

let fx: Fixture;
let ids: string[];

beforeEach(() => {
  // No semantic extra anywhere: the MEX home is empty.
  vi.stubEnv("MEX_HOME", mkdtempSync(join(tmpdir(), "mex-context-cli-home-")));
  fx = createProject();
  ids = writeEntities(fx, "context/notes.md", STANDARD_FACTS);
});
afterEach(() => {
  cleanupProjects();
  vi.unstubAllEnvs();
});

describe("mex context index", () => {
  it("builds the index from a subdirectory and reports it as an enveloped object", async () => {
    const sub = join(fx.root, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const run = capture(sub);
    await runContextIndex(run.io, { json: true });
    expect(run.exit()).toBe(0);
    const envelope = JSON.parse(run.out.join("\n"));
    expect(envelope).toMatchObject({ schemaVersion: 1, ok: true, data: { rebuilt: true, entities: STANDARD_FACTS.length, facts: STANDARD_FACTS.length, vectors: null } });
    expect(existsSync(indexPathOf(fx.context.localDir))).toBe(true);
    expect(envelope.data.path).toBe(indexPathOf(fx.context.localDir));
  });

  it("fails with a typed diagnostic outside any project", async () => {
    const run = capture(mkdtempSync(join(tmpdir(), "mex-context-nowhere-")));
    await runContextIndex(run.io, { json: true });
    expect(run.exit()).toBe(1);
    const envelope = JSON.parse(run.out.join("\n"));
    expect(envelope.ok).toBe(false);
    expect(envelope.diagnostics[0]).toMatchObject({ code: "CONTEXT_NO_SCAFFOLD", severity: "error" });
  });
});

describe("mex context prompt", () => {
  it("prints the packet when launched from a subdirectory of the project", async () => {
    const sub = join(fx.root, "services", "billing");
    mkdirSync(sub, { recursive: true });
    const run = capture(sub);
    await runContextPrompt(run.io, INVOICE_PROMPT);
    expect(run.exit()).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out.join("\n")).toContain("Invoice totals round tax per line before summing");
    expect(run.out.join("\n")).toContain(`mex wiki show ${ids[0]}`);
  });

  it("falls back to the lexical recipe silently when the semantic extra is missing", async () => {
    const run = capture(fx.root);
    await runContextPrompt(run.io, INVOICE_PROMPT, { json: true, explain: true });
    const envelope = JSON.parse(run.out.join("\n"));
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ recipe: "R2w", channel: "lexical", abstention: null });
    expect(envelope.diagnostics.filter((d: { severity: string }) => d.severity !== "info")).toEqual([]);
    expect(run.err).toEqual([]);
    expect(envelope.data.candidates[0]).toMatchObject({ id: ids[0], decision: "selected" });
    expect(envelope.data.timingsMs.total).toBeGreaterThanOrEqual(0);
  });

  it("prints nothing, and exits 0, when nothing clearly fits", async () => {
    const run = capture(fx.root);
    await runContextPrompt(run.io, "What is the weather going to be like in Paris tomorrow afternoon?");
    expect(run.exit()).toBe(0);
    expect(run.out).toEqual([]);
    const json = capture(fx.root);
    await runContextPrompt(json.io, "What is the weather going to be like in Paris tomorrow afternoon?", { json: true });
    expect(JSON.parse(json.out.join("\n")).data.abstention).not.toBeNull();
  });

  it("explains candidate ranks, scores and gate decisions", async () => {
    const run = capture(fx.root);
    await runContextPrompt(run.io, INVOICE_PROMPT, { explain: true });
    const text = run.out.join("\n");
    expect(text).toMatch(/recipe R2w \(lexical\)/);
    expect(text).toMatch(/# 1\s+selected/);
    expect(text).toMatch(/norm \d+\.\d{4}\s+groups \d+/);
    expect(text).toContain("MEX knowledge (");
  });

  it("does not repeat an entry within a session, and persists the session under .mex/local", async () => {
    const first = capture(fx.root);
    await runContextPrompt(first.io, INVOICE_PROMPT, { json: true, session: "session-A" });
    expect(JSON.parse(first.out.join("\n")).data.injected).toHaveLength(1);
    expect(readdirSync(sessionDirOf(fx.context.localDir))).toHaveLength(1);

    const again = capture(fx.root);
    await runContextPrompt(again.io, INVOICE_PROMPT, { json: true, session: "session-A" });
    expect(JSON.parse(again.out.join("\n")).data).toMatchObject({ injected: [], abstention: "already-shown", alreadyShown: [ids[0]] });

    const other = capture(fx.root);
    await runContextPrompt(other.io, INVOICE_PROMPT, { json: true, session: "session-B" });
    expect(JSON.parse(other.out.join("\n")).data.injected).toHaveLength(1);
  });

  it("warns about, and ignores, an invalid session id", async () => {
    const run = capture(fx.root);
    await runContextPrompt(run.io, INVOICE_PROMPT, { json: true, session: "bad\nid" });
    const envelope = JSON.parse(run.out.join("\n"));
    expect(envelope.diagnostics.map((d: { code: string }) => d.code)).toContain("CONTEXT_SESSION_INVALID");
    expect(envelope.data.injected).toHaveLength(1);
    expect(existsSync(sessionDirOf(fx.context.localDir))).toBe(false);
  });

  it("joins a multi-word prompt given as separate arguments", async () => {
    const run = capture(fx.root);
    await runContextPrompt(run.io, INVOICE_PROMPT.split(" "), { json: true });
    expect(JSON.parse(run.out.join("\n")).data.injected).toHaveLength(1);
  });
});

describe("mex context semantic", () => {
  it("reports the missing extra as a plain status", async () => {
    const run = capture(fx.root);
    await runContextSemantic(run.io, "status", { json: true });
    expect(JSON.parse(run.out.join("\n")).data).toMatchObject({ state: "absent" });
    expect(run.exit()).toBe(0);
  });

  it("rejects an unknown action with a usage exit code", async () => {
    const run = capture(fx.root);
    await runContextSemantic(run.io, "upgrade", { json: true });
    expect(run.exit()).toBe(2);
    expect(JSON.parse(run.out.join("\n")).diagnostics[0].code).toBe("CONTEXT_USAGE");
  });

  it("treats removing an absent extra as success", async () => {
    const run = capture(fx.root);
    await runContextSemantic(run.io, "remove", { json: true });
    expect(run.exit()).toBe(0);
    expect(JSON.parse(run.out.join("\n")).data.removed).toBe(false);
  });
});
