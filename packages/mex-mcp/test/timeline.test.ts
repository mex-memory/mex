import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EVENT_KINDS } from "mex-agent";
import { registerTimelineTool } from "../src/tools/timeline.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-mcp-timeline-"));
  mkdirSync(join(root, ".mex/events"), { recursive: true });
  writeFileSync(join(root, ".mex/ROUTER.md"), "# Fixture\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function tool() {
  const register = vi.fn(); registerTimelineTool({ tool: register } as unknown as McpServer);
  const [, description, shape, handler] = register.mock.calls[0];
  return { description: description as string, schema: z.object(shape as z.ZodRawShape), handler };
}
function history(entries: unknown[]) {
  writeFileSync(join(root, ".mex/events/decisions.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

describe("MCP timeline", () => {
  it("advertises supported kinds and validates bounded filter shapes", () => {
    const { schema, description } = tool();
    for (const kind of EVENT_KINDS) expect(schema.safeParse({ kind }).success).toBe(true);
    for (const kind of ["session_start", "checkpoint", "unknown"]) expect(schema.safeParse({ kind }).success).toBe(false);
    for (const limit of [0, -1, 201, 1.5]) expect(schema.safeParse({ limit }).success).toBe(false);
    expect(schema.safeParse({ files: Array(17).fill("file") }).success).toBe(false);
    expect(description).toContain("historical"); expect(description).toContain("8 MiB");
  });

  it("returns structured errors for unsupported time syntax from the shared service", async () => {
    const result = await tool().handler({ projectRoot: root, since: "yesterday", limit: 20 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).problem.code).toBe("INVALID_NOTE_INPUT");
  });

  it("filters real legacy history by kind, time, subject and exact file while preserving stable ties", async () => {
    const base = { timestamp: "2026-05-14T00:00:00.000Z", kind: "decision", files: ["src/a.ts"], cwd: "." };
    history([
      { ...base, message: "Auth first" }, { ...base, message: "Auth second", source: "meeting", status: "decided" },
      { ...base, message: "Auth other file", files: ["src/a.tsx"] }, { ...base, message: "Auth other kind", kind: "risk" },
      { ...base, message: "Auth old", timestamp: "2026-04-01T00:00:00.000Z" },
    ]);
    const result = await tool().handler({ projectRoot: root, kind: "decision", since: "2026-05-01", query: "AUTH", files: ["src/a.ts"], limit: 50 });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ schemaVersion: 1, truncated: false, sourceTruncated: false, events: [
      { message: "Auth second", source: "meeting", status: "decided", files: ["src/a.ts"] }, { message: "Auth first" },
    ] });
  });

  it("bounds the complete UTF-8 response and never shortens a message", async () => {
    const message = "界".repeat(1000);
    const base = { timestamp: "2026-05-14T00:00:00.000Z", kind: "note", message, files: [], cwd: "." };
    history(Array.from({ length: 30 }, () => base));
    const result = await tool().handler({ projectRoot: root, limit: 200 });
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(64 * 1024);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.events.length).toBeGreaterThan(0); expect(parsed.events.length).toBeLessThan(30);
    expect(parsed.events.every((entry: { message: string }) => entry.message === message)).toBe(true);
    expect(parsed.truncated).toBe(true);
  });
});
