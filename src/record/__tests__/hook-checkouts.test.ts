import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord, projectIdentity } from "../index.js";
import { realPath, shortHash } from "../project.js";
import { HOOK_CHECKOUTS_DIRECTORY } from "../hook-checkouts.js";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "mex-hook-checkouts-")); temps.push(dir); return dir; }

function mirror(home: string, root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, HOOK_CHECKOUTS_DIRECTORY, `${shortHash(realPath(root))}.json`), "utf8")) as Record<string, unknown>;
}

describe("hook checkout mirror", () => {
  it("is written when a checkout registers, keyed and rooted at its real path", () => {
    const home = temp(); const project = temp();
    const writer = openRecord({ home, projectPath: project, isNetwork: () => false });
    try {
      expect(mirror(home, project)).toEqual({
        version: 1, project_id: projectIdentity(project).id, root: realPath(project), state: "on", off_until: "", provisional: false,
      });
    } finally { writer.close(); }
  });

  it("follows on/off changes and removes mirrors of checkouts that are gone", () => {
    const home = temp(); const project = temp(); const other = temp();
    const writer = openRecord({ home, projectPath: project, isNetwork: () => false });
    try {
      writer.register(projectIdentity(other));
      expect(readdirSync(join(home, HOOK_CHECKOUTS_DIRECTORY))).toHaveLength(2);
      writer.db.prepare("UPDATE checkouts SET state='off until',off_until=? WHERE path=?").run("2026-11-14T10:00:00.000Z", realPath(project));
      writer.db.prepare("DELETE FROM checkouts WHERE path=?").run(realPath(other));
      writer.writeHookCheckouts();
      expect(mirror(home, project)).toMatchObject({ state: "off until", off_until: "2026-11-14T10:00:00.000Z" });
      expect(readdirSync(join(home, HOOK_CHECKOUTS_DIRECTORY))).toHaveLength(1);
    } finally { writer.close(); }
  });

  it("is created on the next open for a record registered before the mirror existed", () => {
    const home = temp(); const project = temp();
    openRecord({ home, projectPath: project, isNetwork: () => false }).close();
    rmSync(join(home, HOOK_CHECKOUTS_DIRECTORY), { recursive: true });
    openRecord({ home, isNetwork: () => false }).close();
    expect(mirror(home, project).project_id).toBe(projectIdentity(project).id);
  });

  it("never fails the command that registers", () => {
    const home = temp(); const project = temp();
    // A file where the folder should be: the mirror can't be written.
    mkdirSync(home, { recursive: true });
    const writer = openRecord({ home, isNetwork: () => false });
    try {
      rmSync(join(home, HOOK_CHECKOUTS_DIRECTORY), { recursive: true, force: true });
      writeFileSync(join(home, HOOK_CHECKOUTS_DIRECTORY), "");
      expect(() => writer.register(projectIdentity(project))).not.toThrow();
      expect(existsSync(join(home, HOOK_CHECKOUTS_DIRECTORY))).toBe(true);
    } finally { writer.close(); }
  });
});
