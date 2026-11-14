import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord } from "../../record/index.js";
import { shortHash } from "../../record/project.js";
import { automaticWorkEnabled, offDeadline, setCheckoutEnabled, setGlobalEnabled, setCaptureEnabled } from "../index.js";
import { enqueueJob, registerJobKind, runOneBatch } from "../../record/jobs.js";

const temps: string[] = [];
function temp(): string { const path = mkdtempSync(join(tmpdir(), "mex-controls-")); temps.push(path); return path; }
afterEach(() => { vi.unstubAllEnvs(); for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("checkout controls", () => {
  it("persists off, timed off and on across opens, and publishes the hook state", () => {
    const home = temp(), project = temp();
    let writer = openRecord({ home, projectPath: project, isNetwork: () => false });
    const root = writer.checkout(project)!.path;
    const mirror = () => JSON.parse(readFileSync(join(home, "hook-checkouts", `${shortHash(root)}.json`), "utf8"));
    for (const [enabled, until, state] of [[false, null, "off"], [false, "2030-01-01T00:00:00.000Z", "off until"], [true, null, "on"]] as const) {
      setCheckoutEnabled(writer, project, enabled, until);
      writer.close(); writer = openRecord({ home, isNetwork: () => false });
      expect(writer.checkout(project)).toMatchObject({ state, off_until: until });
      expect(mirror()).toMatchObject({ state, off_until: until ?? "" });
    }
    writer.close();
  });
  it("refuses unregistered folders and rolls back a mirror publication failure", () => {
    const home = temp(), project = temp();
    const writer = openRecord({ home, projectPath: project, isNetwork: () => false });
    try {
      expect(() => setCheckoutEnabled(writer, temp(), false)).toThrow("not registered");
      rmSync(join(home, "hook-checkouts"), { recursive: true });
      writeFileSync(join(home, "hook-checkouts"), "occupied");
      expect(() => setCheckoutEnabled(writer, project, false)).toThrow();
      expect(writer.checkout(project)?.state).toBe("on");
    } finally { writer.close(); }
  });
  it("rejects invalid durations before any state mutation", () => {
    const now = Date.parse("2026-11-14T00:00:00Z");
    expect(offDeadline("2h", now)).toBe("2026-11-14T02:00:00.000Z");
    expect(offDeadline("0.5d", now)).toBe("2026-11-14T12:00:00.000Z");
    for (const text of ["", "2", "0h", "-1h", "2h more", "Infinityh", "1e9d", "999999999999999999999d"]) {
      expect(() => offDeadline(text, now)).toThrow("positive duration");
    }
  });
});

describe("global and capture policy", () => {
  it("survives restarts and preserves each independent choice", () => {
    const home = temp(), project = temp();
    let writer = openRecord({ home, projectPath: project, isNetwork: () => false });
    const id = writer.checkout(project)!.project_id;
    setGlobalEnabled(writer, false); setCaptureEnabled(writer, false); setCaptureEnabled(writer, true, project);
    setCheckoutEnabled(writer, project, false);
    writer.close(); writer = openRecord({ home, isNetwork: () => false });
    expect(JSON.parse(readFileSync(join(home, "controls.json"), "utf8"))).toEqual({ version: 1, off: true, capture: false });
    expect(JSON.parse(readFileSync(join(home, "hook-capture", `${id}.json`), "utf8"))).toEqual({ version: 1, enabled: true });
    setCheckoutEnabled(writer, project, true);
    expect(automaticWorkEnabled(writer, id)).toBe(false);
    setGlobalEnabled(writer, true);
    expect(writer.setting("global", "capture.enabled")).toBe("false");
    expect(automaticWorkEnabled(writer, id)).toBe(true);
    setCheckoutEnabled(writer, project, false);
    setCaptureEnabled(writer, true);
    expect(automaticWorkEnabled(writer, id)).toBe(false);
    expect(writer.checkout(project)?.state).toBe("off");
    writer.close();
  });
  it("repairs missing mirrors from the committed settings on a writer restart", () => {
    const home = temp(), project = temp();
    let writer = openRecord({ home, projectPath: project, isNetwork: () => false });
    const id = writer.checkout(project)!.project_id;
    setGlobalEnabled(writer, false); setCaptureEnabled(writer, false, project); writer.close();
    rmSync(join(home, "controls.json")); rmSync(join(home, "hook-capture", `${id}.json`));
    writer = openRecord({ home, isNetwork: () => false });
    expect(JSON.parse(readFileSync(join(home, "controls.json"), "utf8")).off).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "hook-capture", `${id}.json`), "utf8")).enabled).toBe(false);
    expect(writer.db.prepare("PRAGMA user_version").get()!.user_version).toBe(4);
    writer.close();
  });
  it("reports a failed publication and does not let an unrelated corrupt mirror block global off", () => {
    const home = temp(), project = temp();
    const writer = openRecord({ home, projectPath: project, isNetwork: () => false });
    try {
      setCaptureEnabled(writer, false, project);
      const id = writer.checkout(project)!.project_id;
      writeFileSync(join(home, "hook-capture", `${id}.json`), "x".repeat(4097));
      setGlobalEnabled(writer, false);
      expect(writer.setting("global", "enabled")).toBe("false");
      writeFileSync(join(home, "controls.json"), "x".repeat(4097));
      expect(() => setGlobalEnabled(writer, true)).toThrow();
      expect(writer.setting("global", "enabled")).toBe("false");
    } finally { writer.close(); }
  });
  it("holds automatic batches at off boundaries and lets an explicit foreground run proceed", async () => {
    const home = temp(), project = temp();
    const writer = openRecord({ home, projectPath: project, isNetwork: () => false });
    let batches = 0;
    registerJobKind({ name: "controls-test", label: "Controls test", scope: "project", sideEffects: "none", runBatch: () => ({ checkpoint: ++batches, done: batches === 2 }) });
    try {
      const id = writer.checkout(project)!.project_id;
      const { job } = enqueueJob(writer, { kind: "controls-test", projectId: id });
      setGlobalEnabled(writer, false);
      expect(await runOneBatch(writer, "background:1:test")).toBe("idle");
      expect(batches).toBe(0);
      setGlobalEnabled(writer, true); setCheckoutEnabled(writer, project, false);
      expect(await runOneBatch(writer, "background:1:test")).toBe("idle");
      expect(await runOneBatch(writer, "foreground:1:test")).toBe("ran");
      expect(batches).toBe(1);
      setCheckoutEnabled(writer, project, false, "2000-01-01T00:00:00.000Z");
      expect(await runOneBatch(writer, "background:1:test")).toBe("ran");
      expect(writer.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id)?.state).toBe("done");
      writer.db.prepare("DELETE FROM checkouts WHERE project_id=?").run(id);
      expect(automaticWorkEnabled(writer, id)).toBe(false);
      vi.stubEnv("MEX_OFF", "1");
      expect(automaticWorkEnabled(writer, id)).toBe(false);
    } finally { writer.close(); }
  });
});
