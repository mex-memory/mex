import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bashReads, bashSearchPattern, shellSegments } from "../shell.js";
import { preflightHook } from "../preflight.js";
import { recordShown } from "../../context/session.js";
import { CONTEXT_INDEX_SCHEMA_VERSION } from "../../context/types.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("shell evidence", () => {
  it("preserves quoted separators and takes the first search", () => {
    expect(bashSearchPattern(`pwd && rg -n -g '*.ts' 'foo|bar' src | head; git grep later`)).toBe("foo|bar");
    expect(bashSearchPattern(`echo 'rg decoy'; git grep -n -e realName && pwd`)).toBe("realName");
    expect(shellSegments(`rg 'a;b' src || echo done`)).toEqual(["rg 'a;b' src", "echo done"]);
    expect(bashSearchPattern("npm test")).toBe("");
  });
  it("extracts explicit source reads and their known ranges", () => {
    const root = join(tmpdir(), "source");
    expect(bashReads(`sed -n '10,20p' src/core.ts; head -n 4 src/use.ts`, root)).toEqual([
      { file: "src/core.ts", offset: 10, limit: 11 }, { file: "src/use.ts", offset: 1, limit: 4 },
    ]);
    expect(bashReads("cat src/core.ts | nl -ba", root)).toEqual([{ file: "src/core.ts" }]);
    expect(bashReads("cd src && nl -ba core.ts; tail -n 3 use.ts", root)).toEqual([{file:"src/core.ts"}, {file:"src/use.ts",tail:3}]);
    expect(bashReads("sed -i 's/a/b/' src/core.ts; cat ../outside.ts; cat .mex/AGENTS.md", root)).toEqual([]);
  });
});

describe("hook preflight", () => {
  it("rejects unsupported payloads without resolving a project or loading a graph", async () => {
    for (const raw of ["", "null", "{}", "[]", "invalid", JSON.stringify({ hook_event_name:"PostToolUse", tool_name:"Bash", tool_input:{command:"npm test"} })]) expect(await preflightHook(raw, "Z:/missing")).toBe(false);
    expect(await preflightHook(JSON.stringify({hook_event_name:"UserPromptSubmit",prompt:"<task-notification>done"}), "Z:/missing")).toBe(false);
    expect(await preflightHook(JSON.stringify({hook_event_name:"PostToolUse",tool_name:"Bash",tool_input:{command:"pwd && rg name src | head"},tool_response:{stdout:"src/core.ts:1:name"}}), "Z:/missing")).toBe(true);
  });
  it("skips unlinked and already shown reads using only the context index", async () => {
    const root = mkdtempSync(join(tmpdir(), "hook-preflight-")); roots.push(root);
    const local = join(root, ".mex/local"); mkdirSync(local, { recursive:true });
    writeFileSync(join(root, ".mex/ROUTER.md"), "anchor");
    writeFileSync(join(local,"context-index.json"), JSON.stringify({schemaVersion:CONTEXT_INDEX_SCHEMA_VERSION,inputs:{},vectors:{},entities:[{id:"fact",type:"fact",code:["src/core.ts"]}]}));
    const payload = {hook_event_name:"PostToolUse",tool_name:"Read",session_id:"test",tool_input:{file_path:join(root,"src/core.ts")}};
    expect(await preflightHook(JSON.stringify(payload),root)).toBe(false);
    vi.stubEnv("MEX_HOOK_READ","1");
    expect(await preflightHook(JSON.stringify(payload),root)).toBe(true);
    expect(await preflightHook(JSON.stringify({...payload,tool_input:{file_path:join(root,"outside.ts")}}),root)).toBe(false);
    recordShown(local,"test",["fact"]);
    expect(await preflightHook(JSON.stringify(payload),root)).toBe(false);
    expect(await preflightHook(JSON.stringify({...payload,tool_name:"Bash",tool_input:{command:"sed -n '1,5p' src/core.ts"}}),root)).toBe(false);
    vi.stubEnv("MEX_HOOK_EDIT","1");
    expect(await preflightHook(JSON.stringify({...payload,tool_name:"Bash",tool_input:{command:"node update.js"}}),root)).toBe(true);
  });
});
