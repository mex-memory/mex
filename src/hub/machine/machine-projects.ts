import { basename, isAbsolute } from "node:path";
import type { CheckoutRow, ProjectRow, RecordReader } from "../../record/index.js";

export const MACHINE_PROJECT_LIMIT = 128;
const CHECKOUT_LIMIT = 64;
const PROJECT_ID = /^[gf]-[a-f0-9]{24}$/u;

export function machinePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !path.includes("\0") && isAbsolute(path);
}

export function machineTime(value: string | number | undefined | null): string | null {
  const at = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(at) && at >= -62_167_219_200_000 && at < 253_402_300_800_000 ? new Date(at).toISOString() : null;
}

export interface MachineProject {
  id: string;
  name: string;
  kind: ProjectRow["kind"];
  checkouts: CheckoutRow[];
}

export function machineCheckouts(reader: Pick<RecordReader, "all">, projectId: string): { checkouts: CheckoutRow[]; partial: boolean } {
  const rows = reader.all<CheckoutRow>("SELECT project_id,path,state,off_until,provisional FROM checkouts WHERE project_id=? ORDER BY path LIMIT ?", projectId, CHECKOUT_LIMIT + 1);
  return { checkouts: rows.slice(0, CHECKOUT_LIMIT).filter(({ path }) => machinePath(path)), partial: rows.length > CHECKOUT_LIMIT };
}

export function machineProjects(reader: RecordReader | undefined): { projects: MachineProject[]; partial: boolean } {
  const rows = reader?.all<ProjectRow>("SELECT id,root_path,kind FROM projects ORDER BY root_path,id LIMIT ?", MACHINE_PROJECT_LIMIT + 1) ?? [];
  let partial = rows.length > MACHINE_PROJECT_LIMIT;
  const projects = rows.slice(0, MACHINE_PROJECT_LIMIT).filter(({ id }) => PROJECT_ID.test(id)).map(row => {
    const sample = machineCheckouts(reader!, row.id);
    partial ||= sample.partial;
    return { id: row.id, name: (basename(row.root_path) || row.id).slice(0, 512), kind: row.kind, checkouts: sample.checkouts };
  });
  return { projects, partial };
}
