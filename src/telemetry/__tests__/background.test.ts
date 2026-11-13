import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { build, stop } from "esbuild";
import { openRecord } from "../../record/index.js";
import { validateReport } from "../report-schema.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const root = join(repo,"src");
describe("Go hook to background reporter", () => {
  it.runIf(process.env.MEX_TEST_REAL_HOOK_BINARY === "1")("reports real Go counters through the real background process and HTTP boundary", async () => {
    const fixture = mkdtempSync(join(tmpdir(),"mex-report-chain-"));
    const priorHome = process.env.MEX_HOME;
    const bodies: unknown[] = [];
    const server = createServer((req,res) => {
      let body=""; req.on("data",part => { body+=part; });
      req.on("end",() => { bodies.push(JSON.parse(body)); res.end('{"status":1}'); });
    });
    try {
      process.env.MEX_HOME=fixture;
      const writer = openRecord({ isNetwork: () => false });
      const hooksPath = writer.location.hooks; writer.close();
      writeFileSync(join(fixture,".mex","config.json"),JSON.stringify({telemetryNoticeVersion:3}));
      writeFileSync(join(fixture,"package.json"),JSON.stringify({name:"report-chain-fixture",version:JSON.parse(readFileSync(join(repo,"package.json"),"utf8")).version,type:"module"}));
      const env: NodeJS.ProcessEnv = {...process.env,MEX_HOME:fixture,MEX_DEV:"",MEX_TELEMETRY:"1",MEX_OFFLINE:"",DO_NOT_TRACK:"",MEX_BACKGROUND:"0"};
      for (const key of ["CI","CONTINUOUS_INTEGRATION","GITHUB_ACTIONS","GITLAB_CI","TF_BUILD","BUILDKITE","CIRCLECI","JENKINS_URL"]) env[key]="";
      const binary=join(repo,"npm",`hook-${process.platform}-${process.arch}`,"bin",process.platform==="win32"?"mex-hook.exe":"mex-hook");
      const result=spawnSync(binary,["claude-code","SessionStart"],{input:JSON.stringify({session_id:"PRIVATE_SESSION",cwd:"PRIVATE_PATH"}),cwd:fixture,env,encoding:"utf8",timeout:5000});
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({});
      const observed = new DatabaseSync(hooksPath, { readOnly: true });
      try { expect(observed.prepare("SELECT value FROM counters_go WHERE name='agent:claude-code:hook.calls'").get()?.value, "The Go hook did not persist its counter before reporting").toBe(1); }
      finally { observed.close(); }
      server.listen(0,"127.0.0.1"); await once(server,"listening");
      const address=server.address() as import("node:net").AddressInfo;
      mkdirSync(join(fixture,"dist")); const entry=join(fixture,"dist","background.mjs");
      try {
        await build({stdin:{contents:`
          import {runBackground} from ${JSON.stringify(join(root,"record/background.ts"))};
          import {__setTelemetryEndpointForTest} from ${JSON.stringify(join(root,"telemetry/index.ts"))};
          __setTelemetryEndpointForTest('http://127.0.0.1:${address.port}/batch/');
          const reason=await runBackground({clock:()=>Date.now()+86400000,settings:{idleMs:5,pollMs:1}});
          if(reason!=='idle') throw new Error(reason);
        `,sourcefile:"report-worker.ts",resolveDir:repo},outfile:entry,bundle:true,platform:"node",format:"esm",packages:"external",target:"node22",logLevel:"silent"});
      } finally { await stop(); }
      await promisify(execFile)(process.execPath,[entry],{cwd:fixture,env:{...env,MEX_BACKGROUND:"1"},timeout:10000});
      expect(bodies).toHaveLength(1);
      const batch=(bodies[0] as {batch:unknown[]}).batch;
      expect(batch).toHaveLength(1); expect(validateReport(batch[0])).toBe(true);
      expect(batch[0]).toMatchObject({event:"daily",properties:{counts:{sessions:"1","hook.calls":"1"},agents:["claude-code"]}});
      expect(JSON.stringify(bodies)).not.toMatch(/PRIVATE_SESSION|PRIVATE_PATH|session_id/);
      expect(readFileSync(join(repo,"npm",`hook-${process.platform}-${process.arch}`,"bin","THIRD-PARTY-NOTICES.txt"),"utf8")).toContain("modernc.org/sqlite@v1.62.0");
    } finally {
      if (priorHome===undefined) delete process.env.MEX_HOME; else process.env.MEX_HOME=priorHome;
      server.closeAllConnections(); await new Promise<void>(done => server.close(()=>done()));
      rmSync(fixture,{recursive:true,force:true});
    }
  });
});
