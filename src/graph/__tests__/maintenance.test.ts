import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireGraphMaintenanceLease, GraphMaintenanceError, rebuildGraph, refreshGraph, repairGraph, type GraphMaintenanceExecutionOptions } from "../maintenance.js";
import { currentGraphPath, graphLocation, graphPointerFile, readGraphPointer } from "../storage.js";
import { inspectGraphStatus } from "../status.js";
import { openSqlite } from "../db/sqlite.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "graph-maintenance-"));
  writeFileSync(join(root,"example.py"),"def answer():\n    return 1\n");
  return root;
}
function options(hooks: Record<string,unknown>): GraphMaintenanceExecutionOptions {
  return { __internal: hooks } as GraphMaintenanceExecutionOptions;
}
function leftovers(root: string): string[] {
  return readdirSync(graphLocation(root).directory).filter(name=>name.startsWith("graph-tmp-") || name==="graph.lock");
}
function change(root: string): void { writeFileSync(join(root,"example.py"),"def changed():\n    return 2\n"); }
function bytes(root: string): Buffer { return readFileSync(currentGraphPath(root)); }

afterEach(() => vi.unstubAllEnvs());

describe("immutable graph maintenance", () => {
  it("builds a missing graph through a validated candidate without leftovers", async () => {
    const root = fixture(); const result = await rebuildGraph(root);
    expect(result.state).toBe("succeeded"); expect(result.status.status).toBe("fresh");
    expect(leftovers(root)).toEqual([]); expect(existsSync(join(root,".mex","graph.db"))).toBe(false);
    expect(readGraphPointer(graphLocation(root))).toMatchObject({files:1,nodes:2,edges:1,overlay:null});
  });
  it("refreshes edited source while preserving the exact prior base", async () => {
    const root=fixture(); await rebuildGraph(root); const old=currentGraphPath(root), before=bytes(root); change(root);
    const result=await refreshGraph(root);
    expect(result.status.status).toBe("fresh"); expect(currentGraphPath(root)).not.toBe(old);
    expect(readFileSync(old)).toEqual(before); expect(result.refresh?.publication).toBe("delta");
    expect(leftovers(root)).toEqual([]);
  });
  it("publishes nothing when refresh has no changes", async () => {
    const root=fixture(); await rebuildGraph(root); const pointer=readFileSync(graphPointerFile(graphLocation(root))), before=bytes(root);
    const result=await refreshGraph(root); expect(result.filesIndexed).toBe(0);
    expect(readFileSync(graphPointerFile(graphLocation(root)))).toEqual(pointer); expect(bytes(root)).toEqual(before);
    expect(leftovers(root)).toEqual([]);
  });
  it("refuses refresh and repair without a published pointer", async () => {
    const root=fixture();
    await expect(refreshGraph(root)).rejects.toMatchObject({code:"GRAPH_INDEX_MISSING"});
    await expect(repairGraph(root)).rejects.toMatchObject({code:"GRAPH_INDEX_MISSING"});
  });
  it("preserves the pointer when cancellation occurs before publication", async () => {
    const root=fixture(); await rebuildGraph(root); const before=bytes(root), pointer=readFileSync(graphPointerFile(graphLocation(root)));
    const abort=new AbortController(); change(root);
    await expect(refreshGraph(root,{signal:abort.signal,...options({afterCandidateValidated(){abort.abort();}})})).rejects.toMatchObject({code:"GRAPH_MAINTENANCE_CANCELLED"});
    expect(bytes(root)).toEqual(before); expect(readFileSync(graphPointerFile(graphLocation(root)))).toEqual(pointer); expect(leftovers(root)).toEqual([]);
  });
  it("rejects a candidate changed after validation", async () => {
    const root=fixture(); await rebuildGraph(root); const before=bytes(root); change(root);
    await expect(refreshGraph(root,options({afterCandidateValidated(path:string){writeFileSync(path,"replacement");}}))).rejects.toMatchObject({code:"GRAPH_MAINTENANCE_RACE"});
    expect(bytes(root)).toEqual(before); expect(leftovers(root)).toEqual([]);
  });
  it("rejects same-size snapshot tampering even with restored mtime", async () => {
    vi.stubEnv("MEX_GRAPH_STORAGE", "v4");
    const root=fixture(); await rebuildGraph(root); const before=bytes(root); change(root);
    await expect(refreshGraph(root,options({afterCandidateValidated(path:string){
      const data=readFileSync(path); const marker=Buffer.from('"indexedAt":"'); const at=data.indexOf(marker)+marker.length;
      expect(at).toBeGreaterThan(marker.length); data[at]=data[at]===50?49:50;
      const {mtimeMs,atimeMs}=requireStat(path); writeFileSync(path,data); utimesSync(path,atimeMs/1000,mtimeMs/1000);
    }}))).rejects.toMatchObject({code:"GRAPH_MAINTENANCE_RACE"});
    expect(bytes(root)).toEqual(before); expect(leftovers(root)).toEqual([]);
  });
  it("does not overwrite a live base changed at the final boundary", async () => {
    const root=fixture(); await rebuildGraph(root); change(root); const replacement=Buffer.from("independent replacement");
    await expect(refreshGraph(root,options({beforeLiveRevalidation(){writeFileSync(currentGraphPath(root),replacement);}}))).rejects.toMatchObject({code:"GRAPH_MAINTENANCE_RACE"});
    expect(bytes(root)).toEqual(replacement); expect(leftovers(root)).toEqual([]);
  });
  it("rejects nonempty candidate WAL after validation", async () => {
    const root=fixture(); await rebuildGraph(root); const before=bytes(root); change(root);
    await expect(refreshGraph(root,options({afterCandidateValidated(path:string){writeFileSync(path+"-wal","active");}}))).rejects.toMatchObject({code:"GRAPH_MAINTENANCE_LOCKED"});
    expect(bytes(root)).toEqual(before); expect(leftovers(root)).toEqual([]);
  });
  it("keeps corrupt old bytes intact until collection while publishing a fresh base", async () => {
    const root=fixture(); await rebuildGraph(root); const old=currentGraphPath(root); writeFileSync(old,"corrupt");
    const result=await rebuildGraph(root); expect(result.status.status).toBe("fresh"); expect(readFileSync(old,"utf8")).toBe("corrupt"); expect(currentGraphPath(root)).not.toBe(old);
  });
  it("holds one project writer across repeated lease operations", async () => {
    const root=fixture(); await rebuildGraph(root); const lease=acquireGraphMaintenanceLease(root);
    try {
      await expect(refreshGraph(root)).rejects.toMatchObject({code:"GRAPH_MAINTENANCE_LOCKED"});
      change(root); const before=lease.databasePath; await lease.refresh(); expect(lease.databasePath).not.toBe(before);
      expect(lease.databasePath).toBe(currentGraphPath(root)); await lease.refresh();
    } finally {lease.release();}
    expect(leftovers(root)).toEqual([]);
  });
  it("takes over a lock only after its recorded process is dead", async () => {
    const root=fixture(); await rebuildGraph(root); const lock=join(graphLocation(root).directory,"graph.lock");
    writeFileSync(lock,JSON.stringify({pid:process.pid,token:"live"}));
    await expect(refreshGraph(root)).rejects.toMatchObject({code:"GRAPH_MAINTENANCE_LOCKED"}); unlinkSync(lock);
    writeFileSync(lock,JSON.stringify({pid:2147483647,token:"dead"}));
    await refreshGraph(root); expect(existsSync(lock)).toBe(false);
  });
  it("refuses a candidate symlink without touching its target", async () => {
    const root=fixture(); await rebuildGraph(root); const target=join(root,"outside.db"); writeFileSync(target,"protected"); const before=bytes(root); change(root);
    await expect(refreshGraph(root,options({afterCandidateBuilt(path:string){unlinkSync(path); symlinkSync(target,path,"file");}}))).rejects.toThrow();
    expect(readFileSync(target,"utf8")).toBe("protected"); expect(bytes(root)).toEqual(before);
  });
  it("fails closed if a callback replaces the bound index directory", async () => {
    const root=fixture(); await rebuildGraph(root); const location=graphLocation(root); const saved=location.directory+"-saved";
    try {
      await expect(refreshGraph(root,options({afterLockAcquired(){renameSync(location.directory,saved); mkdirSync(location.directory);}}))).rejects.toThrow();
      expect(readdirSync(location.directory)).toEqual([]);
    } finally { /* Test directories remain under the run-local temporary root. */ }
  });
});
import { statSync as requireStat } from "node:fs";
