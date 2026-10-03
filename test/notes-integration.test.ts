import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
const cli = resolve("dist/cli.js");
const mcp = resolve("packages/mex-mcp/dist/index.js");
const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-note-integration-"))); roots.push(root);
  mkdirSync(join(root, ".mex")); writeFileSync(join(root, ".mex/ROUTER.md"), "# Notes fixture\n");
  writeFileSync(join(root, ".mex/config.json"), JSON.stringify({ aiTools: [] })); return root;
}
function run(root: string, args: string[], extra: string[] = []) {
  return spawnSync(process.execPath, [...extra, cli, ...args], { cwd: root, env: { ...process.env, MEX_TELEMETRY: "0", NO_COLOR: "1" }, encoding: "utf8", timeout: 15_000, maxBuffer: 512 * 1024 });
}
function json(result: ReturnType<typeof run>) { expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("real CLI/MCP note workflow", () => {
  beforeAll(async () => {
    // Root builds do not emit the optional MCP workspace. A clean checkout
    // must exercise today's handlers rather than rely on a developer's dist.
    await exec(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "--workspace", "mex-mcp"],
      { cwd: resolve("."), env: { ...process.env, MEX_TELEMETRY: "0" }, timeout: 60_000, shell: process.platform === "win32" });
  }, 60_000);

  it("writes with CLI, finds/reads with MCP, then writes with MCP and reads after restart", async () => {
    const root = fixture();
    const configBefore = readFileSync(join(root, ".mex/config.json"));
    const receipt = json(run(root, ["log", "Auth [v2]\r\noriginal", "--type", "decision", "--file", "src/a.ts", "--source", "agent", "--json"]));
    const transport = new StdioClientTransport({ command: process.execPath, args: [mcp], cwd: root,
      env: { ...process.env, MEX_TELEMETRY: "0" } as Record<string, string>, stderr: "pipe" });
    const client = new Client({ name: "note-integration", version: "1" });
    try {
      await client.connect(transport);
      const tools = await client.listTools(); expect(tools.tools.some((tool) => tool.name === "mex_log")).toBe(true);
      const search = await client.callTool({ name: "mex_timeline", arguments: { projectRoot: root, query: "AUTH [v2]", files: ["src/a.ts"], kind: "decision", limit: 10 } });
      expect(search.isError).not.toBe(true);
      const parsed = JSON.parse((search.content as Array<{ text: string }>)[0].text);
      const cliSearch = json(run(root, ["timeline", "--query", "AUTH [v2]", "--file", "src/a.ts", "--type", "decision", "--limit", "10", "--json"]));
      expect(parsed).toEqual(cliSearch); expect(parsed.events[0].id).toBe(receipt.id);
      const detail = await client.callTool({ name: "mex_log", arguments: { projectRoot: root, action: "get", id: receipt.id } });
      expect(JSON.parse((detail.content as Array<{ text: string }>)[0].text).note.message).toBe("Auth [v2]\r\noriginal");
      const written = await client.callTool({ name: "mex_log", arguments: { projectRoot: root, action: "write", summary: "MCP supplied", files: ["src/a.ts"], source: "native", status: "observed" } });
      expect(written.isError).not.toBe(true);
      const second = JSON.parse((written.content as Array<{ text: string }>)[0].text).receipt;
      expect(json(run(root, ["note", "get", second.id, "--json"])).note).toMatchObject({ message: "MCP supplied", originAdapter: "mcp", source: "native", status: "observed" });
      const invalid = await client.callTool({ name: "mex_log", arguments: { projectRoot: root, action: "write", summary: "unsafe", files: ["../escape"] } });
      expect(invalid.isError).toBe(true);
      const invalidQuery = await client.callTool({ name: "mex_timeline", arguments: { projectRoot: root, since: "yesterday" } });
      expect(invalidQuery.isError).toBe(true);
    } finally { await client.close(); await transport.close(); }
    expect(json(run(root, ["note", "get", receipt.id, "--json"])).note.id).toBe(receipt.id);
    expect(readFileSync(join(root, ".mex/config.json"))).toEqual(configBefore);
    expect(readdirSync(join(root, ".mex")).sort()).toEqual(["ROUTER.md", "config.json", "events"]);
  }, 30_000);

  it("retains every independently acknowledged note from concurrent processes", async () => {
    const root = fixture();
    const writes = await Promise.all(Array.from({ length: 8 }, () => exec(process.execPath, [cli, "log", "same message", "--json"],
      { cwd: root, env: { ...process.env, MEX_TELEMETRY: "0" }, timeout: 15_000 })));
    const ids = writes.map((result) => JSON.parse(result.stdout).id);
    expect(new Set(ids).size).toBe(8);
    const saved = json(run(root, ["timeline", "--json"]));
    expect(saved.events.map((entry: { id: string }) => entry.id).sort()).toEqual(ids.sort());
    expect(saved.sourceTruncated).toBe(false);
  }, 30_000);

  it.skipIf(process.platform === "win32")("distinguishes process death before publication from death after durable commit/before receipt", () => {
    for (const phase of ["before", "after"]) {
      const root = fixture();
      const preload = join(root, "crash.mjs");
      // Instrument native filesystem calls in a separate real process. No fault
      // switches or test hooks are added to production note APIs.
      writeFileSync(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const descriptors = new Map();
let published = false;
const open = fs.openSync, close = fs.closeSync, link = fs.linkSync, sync = fs.fsyncSync;
fs.openSync = (...args) => { const fd = open(...args); descriptors.set(fd, String(args[0])); return fd; };
fs.closeSync = (fd) => { descriptors.delete(fd); return close(fd); };
fs.linkSync = (...args) => {
  const note = String(args[1]).endsWith('.md');
  if (note && ${JSON.stringify(phase)} === 'before') process.kill(process.pid, 'SIGKILL');
  link(...args); if (note) published = true;
};
fs.fsyncSync = (fd) => {
  sync(fd);
  if (published && descriptors.get(fd) === ${JSON.stringify(root)} && ${JSON.stringify(phase)} === 'after') process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports();
`);
      const killed = run(root, ["log", "survives if committed", "--json"], ["--import", pathToFileURL(preload).href]);
      expect(killed.signal).toBe("SIGKILL"); expect(killed.stdout).toBe("");
      const beforeRead = readdirSync(join(root, ".mex/events/notes"), { recursive: true });
      const found = json(run(root, ["timeline", "--json"]));
      expect(found.events).toHaveLength(phase === "after" ? 1 : 0);
      if (phase === "after") expect(json(run(root, ["note", "get", found.events[0].id, "--json"])).note.message).toBe("survives if committed");
      expect(readdirSync(join(root, ".mex/events/notes"), { recursive: true })).toEqual(beforeRead);
      expect(existsSync(join(root, ".mex/wiki.db"))).toBe(false); expect(existsSync(join(root, ".mex/graph.db"))).toBe(false);
    }
  }, 30_000);
});
