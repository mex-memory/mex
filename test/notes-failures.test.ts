import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordNote, findNotes, getNote } from "../src/notes/service.js";
import type { MexConfig } from "../src/types.js";

const fault = vi.hoisted(() => ({ kind: "none", published: false, descriptors: new Map<number, string>() }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const fail = () => { throw Object.assign(new Error("injected storage failure"), { code: "ENOSPC" }); };
  return { ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) { const fd = fs.openSync(...args); fault.descriptors.set(fd, String(args[0])); return fd; },
    closeSync(fd: number) { fault.descriptors.delete(fd); return fs.closeSync(fd); },
    writeFileSync(...args: Parameters<typeof fs.writeFileSync>) {
      const path = typeof args[0] === "number" ? fault.descriptors.get(args[0]) ?? "" : String(args[0]);
      if (fault.kind === "write" && path.includes(".md.mex-tmp-")) fail();
      return fs.writeFileSync(...args);
    },
    fsyncSync(fd: number) {
      const path = fault.descriptors.get(fd) ?? "";
      if (fault.kind === "file-flush" && path.includes(".md.mex-tmp-")) fail();
      if (fault.kind === "directory-flush" && fault.published && fs.fstatSync(fd).isDirectory()) fail();
      return fs.fsyncSync(fd);
    },
    linkSync(...args: Parameters<typeof fs.linkSync>) {
      const note = String(args[1]).endsWith(".md");
      if (fault.kind === "publish" && note) fail();
      fs.linkSync(...args);
      if (note) fault.published = true;
    },
  };
});
let root: string;
let config: MexConfig;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-note-failure-")); config = { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] };
  fault.kind = "none"; fault.published = false;
});
afterEach(() => { fault.kind = "none"; rmSync(root, { recursive: true, force: true }); });

describe("note completion boundary", () => {
  it.each(["write", "file-flush", "publish"])("does not acknowledge %s failure or damage an accepted note", async (kind) => {
    const accepted = await recordNote(config, { message: "already accepted" });
    const original = readFileSync(join(root, accepted.recordPath));
    fault.kind = kind; fault.published = false;
    await expect(recordNote(config, { message: "must not acknowledge" })).rejects.toMatchObject({ code: "NOTE_WRITE_UNCONFIRMED" });
    fault.kind = "none";
    expect(readFileSync(join(root, accepted.recordPath))).toEqual(original);
    expect(findNotes(config).events.map((entry) => entry.message)).toEqual(["already accepted"]);
    const month = join(config.scaffoldRoot, "events/notes", accepted.recordedAt.slice(0, 7));
    expect(readdirSync(month)).toEqual([`${accepted.id}.md`]);
  });

  it.skipIf(process.platform === "win32")("reports uncertainty after publication if directory flushing fails", async () => {
    await recordNote(config, { message: "prior" });
    fault.kind = "directory-flush"; fault.published = false;
    let failure: unknown;
    try { await recordNote(config, { message: "published but not acknowledged" }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "NOTE_WRITE_UNCONFIRMED", recordId: expect.stringMatching(/^log_/) });
    fault.kind = "none";
    expect(getNote(config, (failure as { recordId: string }).recordId).message).toBe("published but not acknowledged");
    expect(findNotes(config).events).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("honors actual filesystem write permissions", async () => {
    const prior = await recordNote(config, { message: "prior" });
    const month = join(config.scaffoldRoot, "events/notes", prior.recordedAt.slice(0, 7));
    chmodSync(month, 0o500);
    try {
      await expect(recordNote(config, { message: "permission denied" })).rejects.toMatchObject({ code: "NOTE_WRITE_UNCONFIRMED" });
      expect(getNote(config, prior.id).message).toBe("prior");
    } finally { chmodSync(month, 0o700); }
  });
});
