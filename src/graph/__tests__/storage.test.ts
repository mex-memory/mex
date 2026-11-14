import { execFileSync } from "node:child_process";
import { openSqlite } from "../db/sqlite.js";
import { finalizeGraph, publishGraph } from "../storage.js";
import { loadFreshGraphReadSession } from "../read-session.js";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentGraphPath, graphLocation, readGraphPointer, graphPointerFile, collectGraphGarbage, graphTemporary, whatMexStores, enforceIndexCap, acquireGraphWriter, openCurrentGraph } from "../storage.js";
import { rebuildGraph, refreshGraph } from "../maintenance.js";
import { createGraphEngine } from "../engine-impl.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "graph-pointer-"));
  writeFileSync(join(root, "example.py"), "def answer():\n    return 1\n");
  return root;
}
afterEach(() => vi.unstubAllEnvs());
describe("graph pointer storage", () => {
  it("leaves a legacy checkout graph untouched and reports no graph", () => {
    const root = fixture(); mkdirSync(join(root,".mex")); writeFileSync(join(root,".mex","graph.db"), "legacy");
    expect(openCurrentGraph(root)).toBeUndefined();
    expect(readFileSync(join(root,".mex","graph.db"), "utf8")).toBe("legacy");
  });
  it("publishes while a reader holds the old immutable base, then collects it", async () => {
    const root = fixture();
    await rebuildGraph(root);
    const before = currentGraphPath(root), location = graphLocation(root);
    const old = openCurrentGraph(root)!;
    const oldRows = old.prepare("SELECT * FROM nodes ORDER BY id").all();
    writeFileSync(join(root,"example.py"), "def renamed():\n    return 2\n");
    // A rebuild replaces the base (a refresh would add an overlay over it).
    await rebuildGraph(root);
    const after = currentGraphPath(root);
    expect(after).not.toBe(before);
    expect(old.prepare("SELECT * FROM nodes ORDER BY id").all()).toEqual(oldRows);
    const next = openCurrentGraph(root)!;
    expect(next.prepare("SELECT name FROM nodes WHERE name='renamed'").get()).toBeTruthy();
    next.close(); old.close();
    collectGraphGarbage(location, Date.now()+120_000);
    expect(readdirSync(location.directory)).not.toContain(before.slice(before.lastIndexOf("\\")+1));
    expect(readGraphPointer(location)?.overlay).toBeNull();
  });
  it("collects a dead writer's temporary database and journals on status collection", async () => {
    const root = fixture(); await rebuildGraph(root);
    const location = graphLocation(root), pointer = readFileSync(graphPointerFile(location));
    for (const suffix of ["", "-journal", "-wal", "-shm"]) writeFileSync(join(location.directory,"graph-tmp-2147483647-interrupted.db"+suffix), "incomplete");
    collectGraphGarbage(location);
    expect(readdirSync(location.directory).filter(name => name.startsWith("graph-tmp-"))).toEqual([]);
    expect(readFileSync(graphPointerFile(location))).toEqual(pointer);
  });
  it("uses the record's injected network-home location", () => {
    const root = fixture(), home = join(root,"home"), cache = join(root,"cache");
    const location = graphLocation(root,{home,cache,isNetwork:()=>true,create:true});
    expect(location.directory.replaceAll("\\", "/").toLowerCase().startsWith(cache.replaceAll("\\", "/").toLowerCase())).toBe(true);
    expect(location.directory.endsWith("index")).toBe(true);
  });
  it("evicts the least recently used project and protects the writer and state", () => {
    const root = fixture();
    vi.stubEnv("MEX_HOME",join(root,"home"));
    const current = graphLocation(root,{create:true});
    mkdirSync(current.directory,{recursive:true});
    writeFileSync(join(current.directory,"keep.db"),Buffer.alloc(100));
    const projects = join(current.recordDirectory,"projects");
    const ids = ["f-"+"1".repeat(24),"f-"+"2".repeat(24)];
    ids.forEach((id,i) => {
      const folder = join(projects,id,"index"); mkdirSync(folder,{recursive:true});
      writeFileSync(join(folder,"base-test.db"),Buffer.alloc(100));
      writeFileSync(join(folder,"graph-state.json"),"{}");
      writeFileSync(join(folder,"last-used"),"used");
      utimesSync(join(folder,"last-used"),i+1,i+1);
    });
    expect(enforceIndexCap(current,230)).toEqual([ids[0]]);
    expect(readFileSync(join(projects,ids[0],"index","graph-state.json"),"utf8")).toBe("{}");
    expect(whatMexStores(current.recordDirectory).projects.find(p=>p.projectId===current.projectId)?.bytes).toBe(100);
  });
  it("allows one project writer and never collects its live temporary files", () => {
    const location = graphLocation(fixture(),{create:true});
    const writer = acquireGraphWriter(location);
    try {
      expect(()=>acquireGraphWriter(location)).toThrow("Another graph writer");
      const file = graphTemporary(location); writeFileSync(file,"busy");
      expect(collectGraphGarbage(location)).toBe(0);
    } finally { writer.release(); }
  });
});


describe("per-file graph coverage", () => {
  it("keeps good-file answers beside oversized, binary, ignored and broken sources", async () => {
    const root = fixture();
    writeFileSync(join(root,"good.py"), "def good():\n    return 1\n");
    writeFileSync(join(root,"large.py"), " ".repeat(2*1024*1024+1));
    writeFileSync(join(root,"binary.py"), Buffer.from([0,1,2,0,3]));
    const garbage = "def broken(:\n  ((( ]] }} :: ,, \n  ))) [[ {{ ;; ..\n";
    writeFileSync(join(root,"broken.py"), garbage);
    writeFileSync(join(root,"partial.py"), "def kept():\n    return 1\n" + "def kept_too():\n    return 2\n".repeat(20) + "def oops(:\n");
    writeFileSync(join(root,".gitignore"), "ignored.py\n");
    writeFileSync(join(root,"ignored.py"), "def hidden():\n    return 1\n");
    await rebuildGraph(root);
    const graph = createGraphEngine({rootDir:root, readOnly:true});
    try {
      expect(graph.coverageFor("good.py")).toEqual({indexed:true});
      expect(graph.coverageFor("large.py")).toEqual({indexed:false,reason:"too big"});
      expect(graph.coverageFor("binary.py")).toEqual({indexed:false,reason:"binary"});
      expect(graph.coverageFor("broken.py")).toEqual({indexed:false,reason:"parse failed"});
      // Mostly valid source with one syntax error keeps the nodes it recovers, as in 0.8.
      expect(graph.coverageFor("partial.py")).toEqual({indexed:true});
      expect(graph.searchNodes("kept").some(node=>node.name==="kept")).toBe(true);
      expect(graph.coverageFor("ignored.py")).toEqual({indexed:false,reason:"excluded"});
      expect(graph.searchNodes("good").some(node=>node.name==="good")).toBe(true);
      expect(graph.searchNodes("hidden")).toEqual([]);
    } finally { graph.close(); }
    const loaded = await loadFreshGraphReadSession(root);
    expect(loaded.session).toBeTruthy();
    try { expect(loaded.session!.graph.searchNodes("good").some(node=>node.name==="good")).toBe(true); expect(loaded.session!.graph.searchNodes("broken")).toEqual([]); }
    finally { loaded.session?.close(); }
    writeFileSync(join(root,"good.py"), garbage);
    await refreshGraph(root);
    const updated = createGraphEngine({rootDir:root,readOnly:true});
    try {
      expect(updated.coverageFor("good.py")).toEqual({indexed:false,reason:"parse failed"});
      expect(updated.searchNodes("answer").length).toBeGreaterThan(0);
    } finally { updated.close(); }
  });
});


describe("interrupted candidate publication", () => {
  it("preserves the pointer and readable base after a real worker is killed on progress", async () => {
    const root = fixture(); await rebuildGraph(root);
    const location = graphLocation(root), pointer = readFileSync(graphPointerFile(location));
    const before = readFileSync(currentGraphPath(root));
    const baselineReader = openCurrentGraph(root)!;
    const baselineRows = baselineReader.prepare("SELECT * FROM nodes ORDER BY id").all(); baselineReader.close();
    for (let i=0;i<80;i++) writeFileSync(join(root, `file-${i}.py`), `def value_${i}():\n    return ${i}\n`);
    let pid = 0, killed = false;
    await expect(rebuildGraph(root, {
      candidateExecution:"process",
      onProgress(progress) {
        if (!killed && pid && (progress.phase === "parse" || progress.phase === "resolve")) {
          killed = true; process.kill(pid,"SIGKILL");
        }
      },
      __internal: { candidateProcess: { onSpawn(worker: number) { pid = worker; } } },
    } as Parameters<typeof rebuildGraph>[1])).rejects.toThrow();
    expect(killed).toBe(true);
    expect(readFileSync(graphPointerFile(location))).toEqual(pointer);
    expect(readFileSync(currentGraphPath(root))).toEqual(before);
    const reader = openCurrentGraph(root)!;
    expect(reader.prepare("SELECT * FROM nodes ORDER BY id").all()).toEqual(baselineRows); reader.close();
    collectGraphGarbage(location);
    expect(readdirSync(location.directory).filter(name=>name.startsWith("graph-tmp-"))).toEqual([]);
  });
});


it("shares one project index between real worktrees with independent pointers", () => {
  const root = fixtureRepository(), second = join(mkdtempSync(join(tmpdir(), "graph-worktrees-")), "second");
  git(root, "worktree", "add", "--detach", second, "HEAD");
  try {
    const locations = [graphLocation(root,{create:true}), graphLocation(second,{create:true})];
    expect(locations[0].projectId).toBe(locations[1].projectId);
    expect(locations[0].directory).toBe(locations[1].directory);
    expect(locations[0].key).not.toBe(locations[1].key);
    for (const [index, location] of locations.entries()) {
      const writer = acquireGraphWriter(location);
      try {
        const file=graphTemporary(location), db=openSqlite(file);
        db.exec("CREATE TABLE marker(value INTEGER)"); db.prepare("INSERT INTO marker VALUES(?)").run(index); db.close();
        finalizeGraph(file); publishGraph(location,file,{head:null,files:0,nodes:0,edges:0,build:{}});
      } finally {writer.release();}
    }
    expect(currentGraphPath(root)).not.toBe(currentGraphPath(second));
    for (const [index, checkout] of [root,second].entries()) {
      const db = openCurrentGraph(checkout)!;
      try {expect(db.prepare("SELECT value FROM marker").get()).toEqual({value:index});} finally {db.close();}
    }
  } finally {git(root,"worktree","remove",second);}
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}
function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "graph-repo-"));
  writeFileSync(join(root, "a.ts"), "export function a(): number { return 1; }\n");
  git(root, "init", "-q");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  return root;
}
