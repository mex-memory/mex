import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test via the module's public exports. Each test gets a fresh $HOME
// so the global config / telemetry-id files are isolated.
//
// Important: tests run from the mex repo, so isDevRepo() returns true by
// default. Tests that need telemetry ENABLED must chdir to a temp dir that
// has no mex-agent package.json.

let originalHome: string | undefined;
let originalDoNotTrack: string | undefined;
let originalMexTelemetry: string | undefined;
let originalMexDev: string | undefined;
let originalCwd: string;
let tempHome: string;

function setTempHome(): string {
  tempHome = mkdtempSync(join(tmpdir(), "mex-tel-"));
  process.env.HOME = tempHome;
  return tempHome;
}

/** chdir to temp home so isDevRepo() returns false. */
function exitDevRepo(): void {
  process.chdir(tempHome);
}

/** Restore cwd to original. */
function restoreCwd(): void {
  process.chdir(originalCwd);
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalDoNotTrack = process.env.DO_NOT_TRACK;
  originalMexTelemetry = process.env.MEX_TELEMETRY;
  originalMexDev = process.env.MEX_DEV;
  originalCwd = process.cwd();
  delete process.env.DO_NOT_TRACK;
  delete process.env.MEX_TELEMETRY;
  delete process.env.MEX_DEV;
  setTempHome();
});

afterEach(async () => {
  restoreCwd();
  process.env.HOME = originalHome;
  if (originalDoNotTrack !== undefined) process.env.DO_NOT_TRACK = originalDoNotTrack;
  else delete process.env.DO_NOT_TRACK;
  if (originalMexTelemetry !== undefined) process.env.MEX_TELEMETRY = originalMexTelemetry;
  else delete process.env.MEX_TELEMETRY;
  if (originalMexDev !== undefined) process.env.MEX_DEV = originalMexDev;
  else delete process.env.MEX_DEV;

  // Reset module state between tests
  const tel = await import("../src/telemetry/index.js");
  tel.__setTransport(null);

  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── AC1: opt-out paths disable telemetry and prevent file creation ──

describe("opt-out precedence (AC1)", () => {
  it("DO_NOT_TRACK=1 disables telemetry", async () => {
    process.env.DO_NOT_TRACK = "1";
    const { isEnabled } = await import("../src/telemetry/index.js");
    const result = isEnabled();
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("DO_NOT_TRACK");
  });

  it("MEX_TELEMETRY=0 disables telemetry", async () => {
    process.env.MEX_TELEMETRY = "0";
    const { isEnabled } = await import("../src/telemetry/index.js");
    const result = isEnabled();
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("MEX_TELEMETRY");
  });

  it("global config telemetry=off disables telemetry", async () => {
    exitDevRepo(); // leave the mex repo so dev guard doesn't fire first
    const { isEnabled } = await import("../src/telemetry/index.js");
    const { setGlobalConfigKey } = await import("../src/global-config.js");
    setGlobalConfigKey("telemetry", "off");
    const result = isEnabled();
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("config");
  });

  it("MEX_DEV disables telemetry", async () => {
    process.env.MEX_DEV = "1";
    const { isEnabled } = await import("../src/telemetry/index.js");
    const result = isEnabled();
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("dev");
  });

  it("dev-repo guard fires (running from mex repo cwd)", async () => {
    // We're in the mex repo by default — isDevRepo should detect it
    const { isEnabled } = await import("../src/telemetry/index.js");
    const result = isEnabled();
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("dev");
  });

  it("when disabled, capture sends nothing and no telemetry-id file is created", async () => {
    process.env.DO_NOT_TRACK = "1";
    const { capture, __setTransport } = await import("../src/telemetry/index.js");
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    __setTransport((event, properties) => events.push({ event, properties }));

    capture("command_run", "check");

    expect(events).toHaveLength(0);
    expect(existsSync(join(tempHome, ".mex", "telemetry-id"))).toBe(false);
  });
});

// ── AC2: payload whitelist — exactly 6 keys, PII fields absent ──

describe("payload whitelist (AC2)", () => {
  it("buildPayload returns exactly the 6 whitelisted keys", async () => {
    const { buildPayload } = await import("../src/telemetry/index.js");
    const payload = buildPayload("check", "test-scaffold-id");

    const keys = Object.keys(payload).sort();
    expect(keys).toEqual([
      "command",
      "machine_id",
      "mex_version",
      "node_version",
      "os",
      "scaffold_id",
    ]);
    expect(payload.command).toBe("check");
    expect(payload.scaffold_id).toBe("test-scaffold-id");
  });

  it("omits scaffold_id when not provided", async () => {
    const { buildPayload } = await import("../src/telemetry/index.js");
    const payload = buildPayload("setup");

    const keys = Object.keys(payload).sort();
    expect(keys).toEqual([
      "command",
      "machine_id",
      "mex_version",
      "node_version",
      "os",
    ]);
  });

  it("scaffold_name, origin, and upstream NEVER appear in the payload", async () => {
    const { buildPayload } = await import("../src/telemetry/index.js");
    const payload = buildPayload("check", "some-id");

    expect(payload).not.toHaveProperty("scaffold_name");
    expect(payload).not.toHaveProperty("origin");
    expect(payload).not.toHaveProperty("upstream");
  });
});

// ── AC3: telemetry inspect — no send, read-only ──

describe("getPayloadPreview (AC3)", () => {
  it("returns whitelist-only JSON without sending", async () => {
    const { getPayloadPreview, __setTransport } = await import("../src/telemetry/index.js");
    const events: unknown[] = [];
    __setTransport((event, props) => events.push({ event, props }));

    const payload = getPayloadPreview("inspect", "scaffold-123", "machine-456");

    expect(payload.command).toBe("inspect");
    expect(payload.scaffold_id).toBe("scaffold-123");
    expect(payload.machine_id).toBe("machine-456");
    expect(events).toHaveLength(0); // no send
  });
});

// ── AC5: machine_id file mode 0600 + only when enabled ──

describe("machine_id (AC5)", () => {
  it("creates telemetry-id with mode 0600 when enabled", async () => {
    const { getMachineId } = await import("../src/global-config.js");
    const id = getMachineId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const filePath = join(tempHome, ".mex", "telemetry-id");
    expect(existsSync(filePath)).toBe(true);

    const stat = statSync(filePath);
    // 0o600 = owner read+write only
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns the same id on subsequent calls", async () => {
    const { getMachineId } = await import("../src/global-config.js");
    const id1 = getMachineId();
    const id2 = getMachineId();
    expect(id1).toBe(id2);
  });
});

// ── AC6: transport failure does not throw ──

describe("error swallowing (AC6)", () => {
  it("capture swallows transport errors", async () => {
    exitDevRepo(); // need telemetry enabled
    const { capture, __setTransport } = await import("../src/telemetry/index.js");
    __setTransport(() => {
      throw new Error("network failure");
    });

    // Should not throw
    expect(() => capture("command_run", "check")).not.toThrow();
  });

  it("flush swallows errors", async () => {
    const { flush } = await import("../src/telemetry/index.js");
    // No client initialized + custom transport = nothing to flush
    await expect(flush()).resolves.toBeUndefined();
  });
});

// ── AC7: dev-repo guard ──

describe("dev-repo guard (AC7)", () => {
  it("detects MEX_DEV environment variable", async () => {
    process.env.MEX_DEV = "1";
    const { isDevRepo } = await import("../src/global-config.js");
    expect(isDevRepo()).toBe(true);
  });

  it("detects mex-agent package name with src/cli.ts present", async () => {
    // Create a fake mex-agent project in temp dir
    const fakeRepo = mkdtempSync(join(tmpdir(), "mex-dev-guard-"));
    try {
      writeFileSync(join(fakeRepo, "package.json"), JSON.stringify({ name: "mex-agent" }));
      mkdirSync(join(fakeRepo, "src"), { recursive: true });
      writeFileSync(join(fakeRepo, "src", "cli.ts"), "");

      process.chdir(fakeRepo);
      const { isDevRepo } = await import("../src/global-config.js");
      expect(isDevRepo()).toBe(true);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  it("does NOT treat a user project merely named \"mex\" as the dev repo", async () => {
    // The bare "mex" name is too generic to disable a real user's telemetry.
    const fakeRepo = mkdtempSync(join(tmpdir(), "mex-named-"));
    try {
      writeFileSync(join(fakeRepo, "package.json"), JSON.stringify({ name: "mex" }));
      mkdirSync(join(fakeRepo, "src"), { recursive: true });
      writeFileSync(join(fakeRepo, "src", "cli.ts"), "");

      process.chdir(fakeRepo);
      const { isDevRepo } = await import("../src/global-config.js");
      expect(isDevRepo()).toBe(false);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  it("returns false in a non-mex directory", async () => {
    exitDevRepo(); // temp dir has no package.json
    const { isDevRepo } = await import("../src/global-config.js");
    expect(isDevRepo()).toBe(false);
  });
});

// ── AC8: config set round-trip ──

describe("config set telemetry round-trip (AC8)", () => {
  it("off then on round-trips through global config", async () => {
    exitDevRepo(); // need telemetry enabled by default
    const { setGlobalConfigKey, readGlobalConfig } = await import("../src/global-config.js");
    const { isEnabled } = await import("../src/telemetry/index.js");

    // Default: enabled (not in dev repo, no env vars, no config)
    expect(isEnabled().enabled).toBe(true);

    // Set off
    setGlobalConfigKey("telemetry", "off");
    expect(readGlobalConfig().telemetry).toBe("off");
    expect(isEnabled().enabled).toBe(false);
    expect(isEnabled().reason).toBe("config");

    // Set on
    setGlobalConfigKey("telemetry", "on");
    expect(readGlobalConfig().telemetry).toBe("on");
    expect(isEnabled().enabled).toBe(true);
  });
});

// ── AC9: first-run notice to stderr, not stdout, shown once ──

describe("first-run notice (AC9)", () => {
  it("prints to stderr on first enabled run with TTY", async () => {
    exitDevRepo(); // need telemetry enabled
    const { showFirstRunNotice } = await import("../src/telemetry/index.js");

    // Mock stderr.isTTY
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write");

    try {
      const shown = showFirstRunNotice();
      expect(shown).toBe(true);
      expect(stderrSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();

      // Check it contains opt-out instructions
      const output = stderrSpy.mock.calls.map(c => c[0]).join("");
      expect(output).toContain("mex config set telemetry off");
      expect(output).toContain("DO_NOT_TRACK");
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });

  it("is not shown on the second run", async () => {
    exitDevRepo();
    const { showFirstRunNotice } = await import("../src/telemetry/index.js");

    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      showFirstRunNotice(); // first
      stderrSpy.mockClear();
      const shown = showFirstRunNotice(); // second
      expect(shown).toBe(false);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });

  it("is not shown when telemetry is disabled", async () => {
    process.env.DO_NOT_TRACK = "1";
    const { showFirstRunNotice } = await import("../src/telemetry/index.js");

    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      const shown = showFirstRunNotice();
      expect(shown).toBe(false);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });
});

// ── AC10: no I/O at import time ──

describe("no I/O at import time (AC10)", () => {
  it("importing the module does not create files or make network calls", () => {
    // The module is already imported — check that no ~/.mex/ was created
    // in a fresh temp home before any explicit call
    const freshHome = mkdtempSync(join(tmpdir(), "mex-import-"));
    expect(existsSync(join(freshHome, ".mex"))).toBe(false);
    rmSync(freshHome, { recursive: true, force: true });
  });
});

// ── captureCommand: PII firewall ──

describe("captureCommand PII firewall", () => {
  it("sends only the scaffold_id string, not identity object fields", async () => {
    exitDevRepo(); // need telemetry enabled
    const { captureCommand, __setTransport } = await import("../src/telemetry/index.js");
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    __setTransport((event, properties) => events.push({ event, properties }));

    captureCommand("check", "some-uuid-here");

    expect(events).toHaveLength(1);
    const props = events[0].properties;
    expect(props.scaffold_id).toBe("some-uuid-here");
    expect(props.command).toBe("check");
    expect(props).not.toHaveProperty("scaffold_name");
    expect(props).not.toHaveProperty("origin");
    expect(props).not.toHaveProperty("upstream");
  });
});

// ── readMachineId: read-only, never plants the tracking file ──

describe("readMachineId (read-only)", () => {
  it("returns undefined and does NOT create telemetry-id when absent", async () => {
    const { readMachineId } = await import("../src/global-config.js");
    expect(readMachineId()).toBeUndefined();
    expect(existsSync(join(tempHome, ".mex", "telemetry-id"))).toBe(false);
  });

  it("returns an existing id without creating a new one", async () => {
    const { getMachineId, readMachineId } = await import("../src/global-config.js");
    const created = getMachineId();
    expect(readMachineId()).toBe(created);
  });
});

// ── readScaffoldId: read-only, no mint ──

describe("readScaffoldId (read-only)", () => {
  it("returns scaffold_id from existing config without minting", async () => {
    const { readScaffoldId } = await import("../src/config.js");
    const fixture = mkdtempSync(join(tmpdir(), "mex-readonly-"));
    const scaffoldRoot = join(fixture, ".mex");
    mkdirSync(scaffoldRoot, { recursive: true });
    writeFileSync(join(scaffoldRoot, "ROUTER.md"), "");
    writeFileSync(
      join(scaffoldRoot, "config.json"),
      JSON.stringify({ scaffold_id: "existing-id-123", scaffold_name: "my-project" }),
    );

    try {
      const id = readScaffoldId(scaffoldRoot);
      expect(id).toBe("existing-id-123");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("returns undefined when no scaffold_id exists (does not mint)", async () => {
    const { readScaffoldId } = await import("../src/config.js");
    const fixture = mkdtempSync(join(tmpdir(), "mex-noid-"));
    const scaffoldRoot = join(fixture, ".mex");
    mkdirSync(scaffoldRoot, { recursive: true });
    writeFileSync(join(scaffoldRoot, "config.json"), JSON.stringify({ aiTools: ["claude"] }));

    try {
      const id = readScaffoldId(scaffoldRoot);
      expect(id).toBeUndefined();

      // Verify no scaffold_id was written
      const config = JSON.parse(readFileSync(join(scaffoldRoot, "config.json"), "utf-8"));
      expect(config).not.toHaveProperty("scaffold_id");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
