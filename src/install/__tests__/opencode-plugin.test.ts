import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { opencodePlugin } from "../opencode-plugin.js";

const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });

/** Loads the generated plugin with a fake hook that answers `reply` and records its input. */
async function load(hookScript: string) {
  const dir = mkdtempSync(join(tmpdir(), "mex-opencode-")); temps.push(dir);
  const hook = join(dir, "hook.cjs");
  writeFileSync(hook, hookScript);
  const plugin = join(dir, "mex.mjs");
  writeFileSync(plugin, opencodePlugin({ path: process.execPath, args: [hook] }));
  const module = await import(pathToFileURL(plugin).href) as { MexPlugin: (ctx: { directory: string }) => Promise<Record<string, (...args: any[]) => Promise<void>>> };
  return { dir, hooks: await module.MexPlugin({ directory: "/home/dev/shop" }) };
}
const answer = (reply: unknown) => `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{require("fs").writeFileSync(__dirname+"/in-"+process.argv[3]+".json",JSON.stringify({argv:process.argv.slice(2),payload:JSON.parse(s)}));process.stdout.write(${JSON.stringify(JSON.stringify(reply))})})`;

describe("OpenCode plugin", () => {
  it("blocks a tool call only on a deny reply, with the reason", async () => {
    const { hooks } = await load(answer({ deny: "[mex rule-3]\nread cart.ts first" }));
    await expect(hooks["tool.execute.before"]!({ tool: "edit", sessionID: "ses_1" }, { args: { filePath: "a.ts" } })).rejects.toThrow("read cart.ts first");
  });

  it("appends context to the tool output and sends the payload MEX's profile reads", async () => {
    const { dir, hooks } = await load(answer({ append: "[mex m1]\nrecipe" }));
    const output = { output: "12 passed", metadata: { exit: 0 } };
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_1", args: { command: "npm test" } }, output);
    expect(output.output).toBe("12 passed\n\n[mex m1]\nrecipe");
    const sent = JSON.parse((await import("node:fs")).readFileSync(join(dir, "in-tool.execute.after.json"), "utf8"));
    expect(sent.argv).toEqual(["opencode", "tool.execute.after"]);
    expect(sent.payload).toEqual({ session_id: "ses_1", cwd: "/home/dev/shop", tool: "bash", args: { command: "npm test" }, output: "12 passed", metadata: { exit: 0 } });
  });

  it("adds context to the compaction prompt", async () => {
    const { hooks } = await load(answer({ context: "[mex keep]\nids" }));
    const output = { context: [] as string[] };
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_1" }, output);
    expect(output.context).toEqual(["[mex keep]\nids"]);
  });

  it("lets OpenCode keep working when the hook is missing, crashes or answers garbage", async () => {
    for (const script of ["process.exit(1)", "process.stdout.write('not json')", "throw new Error('boom')"]) {
      const { hooks } = await load(script);
      const output = { output: "kept", metadata: {} };
      await expect(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s" }, { args: {} })).resolves.toBeUndefined();
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", args: {} }, output);
      expect(output.output).toBe("kept");
      await expect(hooks.event!({ event: { type: "session.created", properties: { info: { id: "s" } } } })).resolves.toBeUndefined();
    }
    const dir = mkdtempSync(join(tmpdir(), "mex-opencode-")); temps.push(dir);
    const plugin = join(dir, "missing.mjs");
    writeFileSync(plugin, opencodePlugin({ path: join(dir, "no-such-hook"), args: [] }));
    const { MexPlugin } = await import(pathToFileURL(plugin).href);
    const hooks = await MexPlugin({ directory: dir });
    await expect(hooks["tool.execute.before"]({ tool: "bash", sessionID: "s" }, { args: {} })).resolves.toBeUndefined();
  });
});
