import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { setCheckoutEnabled, setGlobalEnabled } from "../../controls/index.js";
import { openRecord, migrateRecord, schemaVersion } from "../../record/index.js";
import { recordMigrations, RECORD_SCHEMA_VERSION } from "../../record/schema.js";
import { forgetObservations, observationCutoff, readObservations, saveObservations, supportObservations } from "../observations.js";
import { fixtureAt, observation } from "./fixtures/observations.js";

it("migrates an existing record, retains checked observations per project and marks a forgotten norm durably", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateRecord(db, recordMigrations.filter(step => step.version < RECORD_SCHEMA_VERSION));
    expect(schemaVersion(db)).toBe(6);
    db.prepare("INSERT INTO settings VALUES('global','retained','yes')").run();
    const project = db.prepare("INSERT INTO projects VALUES(?,?,'folder',0,?)");
    project.run("left", "/example/left", fixtureAt);
    project.run("right", "/example/right", fixtureAt);
    migrateRecord(db);
    expect(schemaVersion(db)).toBe(7);
    expect(db.prepare("SELECT value FROM settings WHERE key='retained'").get()?.value).toBe("yes");

    const cutoff = observationCutoff(Date.parse(fixtureAt), "30");
    const active = observation(1), aged = observation(2, { at: "2026-09-01T00:00:00.000Z" });
    saveObservations(db, "left", [active, aged], cutoff);
    saveObservations(db, "right", [active], cutoff);
    expect(readObservations(db, "left", cutoff).map(item => item.id)).toEqual([active.id]);
    expect(readObservations(db, "right", cutoff).map(item => item.id)).toEqual([active.id]);

    const id = "mx_deep" + "a".repeat(32);
    supportObservations(db, "left", id, [active.id]);
    expect(readObservations(db, "left", cutoff, true)).toEqual([]);
    expect(readObservations(db, "left", cutoff)[0]).toMatchObject({ normId: id, forgotten: false });
    forgetObservations(db, "left", id);
    saveObservations(db, "left", [active], cutoff);
    expect(readObservations(db, "left", cutoff)[0]).toMatchObject({ normId: id, forgotten: true });
    expect(readObservations(db, "right", cutoff, true)[0]).toMatchObject({ forgotten: false });
    saveObservations(db, "left", [], "2026-11-16T00:00:00.000Z");
    expect(readObservations(db, "left", cutoff)).toEqual([]);
  } finally { db.close(); }
});

it("clears the project on off and clears every observation on global off", () => {
  const scratch = mkdtempSync(join(tmpdir(), "mex-observation-off-"));
  const root = join(scratch, "repo"), other = join(scratch, "other");
  mkdirSync(root);
  mkdirSync(other);
  const home = join(scratch, ".mex");
  const writer = openRecord({ home, projectPath: root, isNetwork: () => false });
  const second = openRecord({ home, projectPath: other, isNetwork: () => false });
  try {
    const firstCheckout = setCheckoutEnabled(writer, root, true);
    const otherCheckout = setCheckoutEnabled(second, other, true);
    saveObservations(writer.db, firstCheckout.project_id, [observation(1)], fixtureAt);
    saveObservations(writer.db, otherCheckout.project_id, [observation(2)], fixtureAt);
    setCheckoutEnabled(writer, root, false);
    expect(readObservations(writer.db, firstCheckout.project_id, fixtureAt)).toEqual([]);
    expect(readObservations(writer.db, otherCheckout.project_id, fixtureAt)).toHaveLength(1);
    setGlobalEnabled(writer, false);
    expect(readObservations(writer.db, otherCheckout.project_id, fixtureAt)).toEqual([]);
  } finally { second.close(); writer.close(); rmSync(scratch, { recursive: true, force: true }); }
});
