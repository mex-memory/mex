import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { openRecordReadOnly, recordLocation, projectIdentity, type CheckoutRow } from "../record/index.js";
import type { LocationOptions } from "../record/location.js";
import { realPath } from "../record/project.js";
import { KnowledgeError } from "./contract.js";
import { retiredIds } from "./state.js";

export interface KnowledgeOptions extends LocationOptions {
  projectPath: string; consumerAgent?: string; env?: NodeJS.ProcessEnv; userHome?: string;
}
/** A pure snapshot; no registration, schema migration, folder or pointer creation. */
export function knowledgeProject(options: KnowledgeOptions) {
  const location = recordLocation({ ...options, create: false });
  const reader = existsSync(location.home) ? openRecordReadOnly(options) : undefined;
  try {
    if (reader?.diagnostic) throw new KnowledgeError("RECORD_UNAVAILABLE", reader.diagnostic);
    const start = realPath(options.projectPath);
    let current = start, registered: CheckoutRow | undefined;
    while (reader) {
      const row = reader.get<CheckoutRow>("SELECT * FROM checkouts WHERE path=?", current);
      if (row && (current === start || row.project_id.startsWith("g-") || row.provisional || existsSync(join(current, ".git")))) { registered = row; break; }
      if (existsSync(join(current, ".git"))) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const identity = registered ? undefined : projectIdentity(options.projectPath);
    const projectId = registered?.project_id ?? identity!.id;
    if (!/^[gf]-[a-f0-9]{24}$/u.test(projectId)) throw new KnowledgeError("UNSAFE_STORE", "Invalid registered project identity.");
    return { location, projectId, root: registered?.path ?? identity!.rootPath, retired: retiredIds(reader, projectId) };
  } finally { reader?.close(); }
}
export type KnowledgeProject = ReturnType<typeof knowledgeProject>;
