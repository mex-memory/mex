import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentsInUse, liveSessions } from "../agents-in-use.js";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function temp(): string { const d = mkdtempSync(join(tmpdir(), "mex-agents-")); dirs.push(d); return d; }

function beat(home: string, agent: string, session: string, cwd: string, ageMs: number): void {
  mkdirSync(join(home, "heartbeats", agent), { recursive: true });
  const file = join(home, "heartbeats", agent, session);
  writeFileSync(file, JSON.stringify({ agent, session_id: session, cwd, started: "2026-11-15T00:00:00Z" }));
  const at = new Date(Date.now() - ageMs);
  utimesSync(file, at, at);
}

describe("agents in use", () => {
  it("come from files in the repo", () => {
    const root = temp();
    expect(agentsInUse(root)).toEqual([]);
    mkdirSync(join(root, ".claude"));
    expect(agentsInUse(root)).toEqual(["claude-code"]);
    writeFileSync(join(root, "AGENTS.md"), "# Rules\n");
    expect(agentsInUse(root)).toEqual(["claude-code", "codex"]);
  });

  it("and from hooks that ran in this checkout on this machine", () => {
    const root = temp(), other = temp(), home = temp();
    mkdirSync(join(root, "src"));
    beat(home, "codex", "s1", join(root, "src"), 1000);
    beat(home, "claude-code", "s2", other, 1000);
    expect(agentsInUse(root, home)).toEqual(["codex"]);
  });

  it("a session is live only while its heartbeat is recent", () => {
    const root = temp(), home = temp();
    beat(home, "claude-code", "old", root, 60 * 60 * 1000);
    expect(liveSessions(root, home)).toEqual([]);
    beat(home, "claude-code", "now", root, 1000);
    expect(liveSessions(root, home)).toEqual(["claude-code"]);
  });

  it("a session the agent reported ended is not live, however recent", () => {
    const root = temp(), home = temp();
    beat(home, "claude-code", "done", root, 1000);
    const file = join(home, "heartbeats", "claude-code", "done");
    writeFileSync(file, JSON.stringify({ agent: "claude-code", session_id: "done", cwd: root, started: "2026-11-15T00:00:00Z", ended: "2026-11-15T01:00:00Z" }));
    expect(liveSessions(root, home)).toEqual([]);
  });
});
