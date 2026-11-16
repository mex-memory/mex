import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob, registerJobKind } from "../../record/jobs.js";
import { shortHash } from "../../record/project.js";
import { judgePending, queuePendingJudgements } from "../pending.js";

let bundleRoot: string, bundle: string, base: string, writer: RecordWriter;
beforeAll(() => {
  mkdirSync(resolve("node_modules/.cache"), { recursive: true });
  bundleRoot = mkdtempSync(resolve("node_modules/.cache/judge-crash-")); bundle = join(bundleRoot, "dist", "worker.mjs");
  writeFileSync(join(bundleRoot, "package.json"), readFileSync(resolve("package.json")));
  buildSync({ stdin: { contents: `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    import {openRecord} from ${JSON.stringify(resolve("src/record/index.ts"))};
    import {registerJobKind,enqueueJob} from ${JSON.stringify(resolve("src/record/jobs.ts"))};
    import {queuePendingJudgements} from ${JSON.stringify(resolve("src/judge/pending.ts"))};
    registerJobKind({name:'judge',label:'Fake judge',scope:'project',sideEffects:'none',runBatch(){return {checkpoint:{},done:true};}});
    const writer=openRecord({home:process.argv[2],isNetwork:()=>false});
    const phase=process.argv[3];
    if(phase==='consume') {const rename=fs.renameSync;fs.renameSync=(...args)=>{rename(...args);process.exit(17)};syncBuiltinESMExports();}
    queuePendingJudgements(writer,(w,options)=>{
      if(phase==='before')process.exit(17);
      const result=enqueueJob(w,options);
      if(phase==='after')process.exit(17);
      return result;
    });
  `, resolveDir: resolve("."), sourcefile: "judge-crash.ts" }, outfile: bundle, bundle: true, packages: "external", platform: "node", format: "esm", target: "node22" });
});
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-judge-crash-")));
  const root = join(base, "repo"); mkdirSync(root);
  writer = openRecord({ home: join(base, "home"), projectPath: root, isNetwork: () => false });
  registerJobKind({ name: "judge", label: "Fake judge", scope: "project", sideEffects: "none", runBatch: () => ({ checkpoint: {}, done: true }) });
  const directory = join(writer.location.directory, "judge-pending"); mkdirSync(directory);
  writeFileSync(join(directory, `${shortHash(root)}.json`), JSON.stringify({ version: 1, project_id: writer.checkout(root)!.project_id, checkout: root, agent: "codex", reason: "start", generation: "1", near: [], not_before: 0 }));
});
afterEach(() => { writer.close(); rmSync(base, { recursive: true, force: true }); });
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));

it.each(["before", "after", "consume"])("recovers a process killed %s durable enqueue without losing or duplicating a request", phase => {
  const child = spawnSync(process.execPath, [bundle, writer.location.home, phase], { encoding: "utf8", timeout: 10_000 });
  expect(child.status, child.stderr).toBe(17);
  expect(judgePending(writer.location.directory)).toBe(true);
  queuePendingJudgements(writer, enqueueJob);
  expect(writer.db.prepare("SELECT count(*) n FROM jobs WHERE kind='judge'").get()!.n).toBe(1);
  expect(judgePending(writer.location.directory)).toBe(false);
});
