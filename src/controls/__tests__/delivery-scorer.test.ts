import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord } from "../../record/index.js";
import { setCaptureEnabled, setDeliveryScorer, setDeliverySurface, setGlobalEnabled } from "../index.js";

describe("delivery scorer settings", () => {
 it("preserves scorer and surface choices through independent writes and repair",()=>{
  const home=mkdtempSync(join(tmpdir(),"mex-surface-home-"));
  const project=mkdtempSync(join(tmpdir(),"mex-surface-project-"));
  let writer=openRecord({home,projectPath:project,isNetwork:()=>false});
  const id=writer.checkout(project)!.project_id;
  try {
   setDeliveryScorer(writer,"risk",project);setDeliverySurface(writer,"read-pitfall","shadow",project);setDeliverySurface(writer,"prompt","off",project);
   setDeliverySurface(writer,"rescue-search","off");setGlobalEnabled(writer,false);
   expect(JSON.parse(readFileSync(join(home,"hook-delivery",id+".json"),"utf8"))).toEqual({version:1,scorer:"risk",surfaces:{"read-pitfall":"shadow",prompt:"off"}});
   expect(JSON.parse(readFileSync(join(home,"controls.json"),"utf8")).surfaces).toEqual({"rescue-search":"off"});
   expect(()=>setDeliverySurface(writer,"invented","on")).toThrow("Unknown");
   expect(()=>setDeliverySurface(writer,"prompt","invalid")).toThrow("on, shadow or off");
   expect(()=>setDeliverySurface(writer,"prompt","on",home)).toThrow("not registered");
   writer.close();writeFileSync(join(home,"hook-delivery",id+".json"),"{}");writer=openRecord({home,isNetwork:()=>false});
   expect(JSON.parse(readFileSync(join(home,"hook-delivery",id+".json"),"utf8")).surfaces).toEqual({"read-pitfall":"shadow",prompt:"off"});
  }finally{writer.close()}
 });
 it("persists machine and project choices through independent control writes and repair", () => {
  const home=mkdtempSync(join(tmpdir(),"mex-scorer-home-"));
  const project=mkdtempSync(join(tmpdir(),"mex-scorer-project-"));
  let writer=openRecord({home,projectPath:project,isNetwork:()=>false});
  const id=writer.checkout(project)!.project_id;
  try {
   expect(setDeliveryScorer(writer,"bm25")).toBe("global");
   expect(setDeliveryScorer(writer,"risk",project)).toBe(id);
   setCaptureEnabled(writer,false);setGlobalEnabled(writer,false);
   expect(JSON.parse(readFileSync(join(home,"controls.json"),"utf8"))).toEqual({version:1,off:true,capture:false,scorer:"bm25"});
   expect(JSON.parse(readFileSync(join(home,"hook-delivery",id+".json"),"utf8"))).toEqual({version:1,scorer:"risk"});
   writer.close();
   writeFileSync(join(home,"controls.json"),"{}");
   writeFileSync(join(home,"hook-delivery",id+".json"),"{}");
   writer=openRecord({home,isNetwork:()=>false});
   expect(writer.setting("global","delivery.scorer")).toBe("bm25");
   expect(writer.setting(id,"delivery.scorer")).toBe("risk");
   expect(JSON.parse(readFileSync(join(home,"controls.json"),"utf8")).scorer).toBe("bm25");
   expect(JSON.parse(readFileSync(join(home,"hook-delivery",id+".json"),"utf8")).scorer).toBe("risk");
   for(const value of ["tiers","bm25","fcfs","risk"]) {
    setDeliveryScorer(writer,value);
    expect(writer.setting("global","delivery.scorer")).toBe(value);
   }
  } finally {writer.close()}
 });
 it("rejects invalid values and unregistered projects and rolls back failed publication",()=>{
  const home=mkdtempSync(join(tmpdir(),"mex-scorer-failure-"));
  const writer=openRecord({home,isNetwork:()=>false});
  try {
   expect(()=>setDeliveryScorer(writer,"invalid")).toThrow("tiers");
   expect(()=>setDeliveryScorer(writer,"risk",home)).toThrow("not registered");
   expect(writer.setting("global","delivery.scorer")).toBeUndefined();
   setDeliveryScorer(writer,"tiers");
   writeFileSync(join(home,"controls.json"),"x".repeat(4097));
   expect(()=>setDeliveryScorer(writer,"risk")).toThrow();
   expect(writer.setting("global","delivery.scorer")).toBe("tiers");
  }finally{writer.close()}
 });
});
