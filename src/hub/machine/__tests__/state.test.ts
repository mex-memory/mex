import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRecord, openRecordReadOnly, type RecordWriter } from "../../../record/index.js";
import {
  candidatePorts,
  clearBound,
  clearBoundForPid,
  consumeBootstrap,
  ensureHomeId,
  keepHubOpen,
  mintBootstrap,
  preferredPort,
  readBound,
  writeBound,
  type BoundHub,
} from "../state.js";

const NOW = Date.parse("2026-11-24T00:00:00.000Z");
const LINK_LIFETIME_MS = 5 * 60_000;
const BOUND: BoundHub = {
  port: 41917,
  pid: 1234,
  version: "test-version",
  homeId: "test-home",
  mode: "background",
  at: new Date(NOW).toISOString(),
};

describe("candidatePorts", () => {
  it("returns ten ports starting at the preferred port", () => {
    expect(candidatePorts(41930)).toEqual(Array.from({ length: 10 }, (_, i) => 41930 + i));
  });

  it("wraps from 41999 to 41917", () => {
    expect(candidatePorts(41995)).toEqual([
      41995, 41996, 41997, 41998, 41999, 41917, 41918, 41919, 41920, 41921,
    ]);
  });

  it("tries an explicit port outside the reserved range before falling back inside it", () => {
    expect(candidatePorts(43000)).toEqual([
      43000, 41917, 41918, 41919, 41920, 41921, 41922, 41923, 41924, 41925,
    ]);
  });
});

describe("machine Hub state in record.db", () => {
  let home: string;
  let writer: RecordWriter;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mex-hub-state-"));
    writer = openRecord({ home, cache: home, isNetwork: () => false });
  });

  afterEach(() => {
    writer?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("prefers an existing hub.port setting", () => {
    writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES('hub','port','43000')").run();
    expect(preferredPort(writer)).toBe(43000);
    expect(writer.setting("hub", "port")).toBe("43000");
  });

  it("assigns and stores a stable port from 41920 through 41999 for a new home", () => {
    expect(writer.setting("hub", "port")).toBeUndefined();
    const port = preferredPort(writer);

    expect(port).toBeGreaterThanOrEqual(41920);
    expect(port).toBeLessThanOrEqual(41999);
    expect(writer.setting("hub", "port")).toBe(String(port));
    expect(preferredPort(writer)).toBe(port);
  });

  it("consumes a bootstrap token exactly once", () => {
    const token = mintBootstrap(writer, NOW);
    expect(consumeBootstrap(writer, token, NOW + 1)).toBe(true);
    expect(consumeBootstrap(writer, token, NOW + 1)).toBe(false);
  });

  it("rejects a bootstrap token at its expiry", () => {
    const token = mintBootstrap(writer, NOW);
    expect(consumeBootstrap(writer, token, NOW + LINK_LIFETIME_MS)).toBe(false);
  });

  it("rejects an unknown, well-formed bootstrap token", () => {
    expect(consumeBootstrap(writer, Buffer.alloc(32).toString("base64url"), NOW)).toBe(false);
  });

  it("sweeps only expired bootstrap rows when minting a token", () => {
    const count = writer.db.prepare("SELECT count(*) AS count FROM settings WHERE scope='hub' AND key LIKE 'bootstrap.%'");
    mintBootstrap(writer, NOW);
    const stillValid = mintBootstrap(writer, NOW + 1);
    expect(count.get()?.count).toBe(2);

    const later = NOW + LINK_LIFETIME_MS;
    const newest = mintBootstrap(writer, later);

    expect(count.get()?.count).toBe(2);
    expect(consumeBootstrap(writer, stillValid, later)).toBe(true);
    expect(consumeBootstrap(writer, newest, later)).toBe(true);
    expect(count.get()?.count).toBe(0);
  });

  it("extends hub_until and preserves it when given an earlier time", () => {
    const readUntil = writer.db.prepare("SELECT hub_until FROM background WHERE id=1");
    expect(readUntil.get()?.hub_until).toBeNull();

    keepHubOpen(writer, NOW + 60_000);
    keepHubOpen(writer, NOW + 30_000);
    expect(readUntil.get()?.hub_until).toBe(new Date(NOW + 60_000).toISOString());

    keepHubOpen(writer, NOW + 90_000);
    expect(readUntil.get()?.hub_until).toBe(new Date(NOW + 90_000).toISOString());
  });

  it("writes a bound Hub address that a read-only handle can read", () => {
    expect(readBound(writer)).toBeUndefined();
    writeBound(writer, BOUND);

    const reader = openRecordReadOnly({ home, cache: home });
    try {
      expect(reader && readBound(reader)).toEqual(BOUND);
    } finally {
      reader?.close();
    }
  });

  it("clears a bound address only when both the pid and port match", () => {
    writeBound(writer, BOUND);
    clearBound(writer, BOUND.pid + 1, BOUND.port);
    expect(readBound(writer)).toEqual(BOUND);
    clearBound(writer, BOUND.pid, BOUND.port + 1);
    expect(readBound(writer)).toEqual(BOUND);
    clearBound(writer, BOUND.pid, BOUND.port);
    expect(readBound(writer)).toBeUndefined();
  });

  it("clears a bound address by pid regardless of its port", () => {
    const bound = { ...BOUND, port: 41999 };
    writeBound(writer, bound);
    clearBoundForPid(writer, bound.pid + 1);
    expect(readBound(writer)).toEqual(bound);
    clearBoundForPid(writer, bound.pid);
    expect(readBound(writer)).toBeUndefined();
  });

  it("assigns a home ID once and persists it across record opens", () => {
    const id = ensureHomeId(writer);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(writer.setting("hub", "home_id")).toBe(id);
    writer.close();
    writer = openRecord({ home, cache: home, isNetwork: () => false });
    expect(ensureHomeId(writer)).toBe(id);
  });
});
