import { spawnSync } from "node:child_process";
import { openHooksReadOnly } from "../record/index.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { rankBinary } from "./native-rank.js";
interface Item {
  id: string;
  title: string;
  kind: string;
  level: string;
  action: string;
  detail: string;
}
export interface SessionSummary {
  session: string;
  gave: number;
  withheld: number;
  replaced: number;
  items: Item[];
  estimatedFalse: number;
  closedDeliveries: number;
  partial: boolean;
}

/** The Go projection is shared with offline replay; this command never writes. */
export function surfaces(options: KnowledgeOptions): { surfaces: Array<Record<string, unknown>>; contention?: Record<string,unknown> } {
  const binary = rankBinary();
  if (!binary) throw new Error("The native hook is unavailable. Rebuild MEX.");
  const project = knowledgeProject(options);
  const result = spawnSync(binary, ["--surfaces"], {
    input: JSON.stringify({ project: project.projectId, checkout: project.root }),
    encoding: "utf8", windowsHide: true, timeout: 2000, maxBuffer: 128 * 1024,
    env: { ...process.env, MEX_BACKGROUND: "1" },
  });
  if (result.error || result.status !== 0) throw new Error("The surface ledger is unavailable.");
  return JSON.parse(result.stdout) as { surfaces: Array<Record<string, unknown>>; contention?: Record<string,unknown> };
}
export function whatLine(s: SessionSummary): string {
  const kinds = new Map<string, number>();
  for (const it of s.items) if (it.action === "given" || it.action === "replaced") {
    const name = it.kind === "rule" && it.level === "team" ? "team rule" : it.kind === "rule" && it.level === "personal" ? "note" : it.kind;
    if (name) {
      kinds.set(name, (kinds.get(name) ?? 0) + 1);
    }
  }
  const detail = [...kinds].sort(([a], [b]) => a.localeCompare(b)).map(([name, n]) => `${n} ${name}${n === 1 ? "" : "s"}`).join(", ");
  const qualifier = s.partial ? "at least " : "";
  return `MEX · this session: gave ${qualifier}${s.gave} items${detail ? ` (${detail})` : ""} · withheld ${qualifier}${s.withheld} out of date · replaced ${qualifier}${s.replaced} long outputs · details: mex status`;
}
/** Read only: no migrations, registration or snapshot work. Old receipts have no title. */
export function what(options: KnowledgeOptions, session = ""): SessionSummary {
  if (session.length > 512 || session.includes("\0")) {
    throw Error("Invalid session");
  }
  const out: SessionSummary = {
    session,
    gave: 0,
    withheld: 0,
    replaced: 0,
    items: [],
    estimatedFalse: 0,
    closedDeliveries: 0,
    partial: false
  };
  const project = knowledgeProject(options),
    db = openHooksReadOnly(options);
  if (!db) {
    return out;
  }
  try {
    if (db.diagnostic) {
      throw Error(db.diagnostic);
    }
    if (!out.session) {
      out.session = db.get<{
        session_id: string;
      }>("SELECT session_id FROM sessions WHERE project_id=? AND checkout=? ORDER BY last_seen_at DESC,session_id LIMIT 1", project.projectId, project.root)?.session_id ?? "";
    }
    const columns = db.version >= 5 ? `d.entry_id AS id,d.title,d.kind,d.level,d.action,d.detail,e.closed,
      NOT EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id AND (f.kind NOT IN ('edit','command') OR f.detail IS NULL)) AND NOT EXISTS(SELECT 1 FROM delivery_touches t WHERE t.delivery_id=d.id) AS empty` : `d.entry_id AS id,'' AS title,'' AS kind,'' AS level,d.action,'' AS detail,0 AS closed,0 AS empty`;
    const rows = db.all<Item & {
      closed: number;
      empty: number;
    }>(`SELECT ${columns} FROM deliveries d JOIN epochs e
      ON e.session_id=d.session_id AND e.agent_id=d.agent_id AND e.epoch=d.epoch
      WHERE d.session_id=? AND d.project_id=? AND d.checkout=? AND d.moment<>'correction'
      ORDER BY d.rowid LIMIT 401`, out.session, project.projectId, project.root);
    out.partial = rows.length > 400;
    for (const {
      closed,
      empty,
      ...it
    } of rows.slice(0, 400)) {
      it.title = it.title.replace(/\s+/gu, " ").slice(0, 1024);
      out.items.push(it);
      if (["given", "replaced"].includes(it.action)) {
        out.gave++;
        if (closed) {
          out.closedDeliveries++;
          if (empty) {
            out.estimatedFalse++;
          }
        }
      } else if (it.action === "withheld" && !it.detail) {
        out.withheld++;
      }
    }
    return out;
  } finally {
    db.close();
  }
}

/** Best effort, explicit action only. Go remains the sole hooks.db writer. */
export function noteProbe(id: string, kind: "opened" | "wrong", options: KnowledgeOptions): void {
  try {
    const binary = rankBinary();
    if (!binary) {
      return;
    }
    const p = knowledgeProject(options);
    spawnSync(binary, ["--probe"], {
      input: JSON.stringify({
        entry: id,
        kind,
        session: process.env.MEX_SESSION_ID ?? "",
        project: p.projectId,
        checkout: p.root
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
      maxBuffer: 16384,
      env: {
        ...process.env,
        MEX_BACKGROUND: "1"
      }
    });
  } catch {/* Feedback must never turn a successful knowledge read into an error. */}
}
