// Acceptance evidence for the old-process recovery explanation. This exercises
// Node's actual module loader, not the full MEX setup/rebuild failure.
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const scratch = mkdtempSync(join(tmpdir(), "mex-statechart-recovery-"));
try {
  const entry = join(scratch, "entry.mjs");
  writeFileSync(entry, 'export const open = () => import("./hub-old.mjs");\n');
  writeFileSync(join(scratch, "hub-old.mjs"), "export const ready = true;\n");
  const loaded = await import(pathToFileURL(entry).href);
  unlinkSync(join(scratch, "hub-old.mjs"));
  writeFileSync(join(scratch, "hub-new.mjs"), "export const ready = true;\n");
  writeFileSync(entry, 'export const open = () => import("./hub-new.mjs");\n');
  const attempts = [];
  for (let i = 0; i < 2; i++) {
    try { await loaded.open(); attempts.push("unexpected-success"); } catch (e) { attempts.push(e.code); }
  }
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `const x = await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log((await x.open()).ready);`], { encoding: "utf8", timeout: 10_000, maxBuffer: 65_536 });
  const result = { scope: "Node module replacement mechanism; full MEX setup failure not reproduced", attempts, freshProcess: { exitCode: run.status, ready: run.stdout.trim() === "true" } };
  console.log(JSON.stringify(result, null, 2));
  if (attempts.some(x => x !== "ERR_MODULE_NOT_FOUND") || run.status !== 0 || !result.freshProcess.ready) process.exitCode = 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
