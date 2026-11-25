import { opendirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { checkoutOn } from "../controls/index.js";
import { knowledgeProject, type KnowledgeOptions } from "../knowledge/context.js";
import { containedDirectory, readBoundedTextFile } from "../knowledge/files.js";
import { hasSecret, stripHidden } from "../knowledge/gates.js";
import { clickedApprovalsOn } from "../knowledge/session-learning.js";
import { openRecordReadOnly } from "../record/index.js";
import { shortHash } from "../record/project.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u);
const index = z.number().int().min(1).max(8);
const safeText = (text: string) => stripHidden(text) === text && !hasSecret(text) && !/<private/iu.test(text);
const Choice = z.object({ question: index, option: index,
  label: z.string().min(1).max(256).refine(safeText).optional(), text: z.string().max(12_000).refine(safeText),
  preview: z.string().min(1).max(2048).refine(safeText).optional(),
}).strict();
const Approval = z.object({ version: z.literal(1), project_id: z.string(), checkout: z.string(),
  agent: z.enum(["claude-code", "codex"]), session_id: id, call_id: id,
  tool: z.enum(["AskUserQuestion", "ExitPlanMode", "request_user_input"]), at: z.string().datetime({ offset: true }),
  kind: z.literal("approval"), level: z.literal("personal"), strength: z.literal("weak"), author: z.literal("agent"),
  choices: z.array(Choice).min(1).max(64),
}).strict().refine(item => {
  if (item.agent === "codex" ? item.tool !== "request_user_input" : item.tool === "request_user_input") return false;
  const keys = new Set(item.choices.map(choice => `${choice.question}.${choice.option}`));
  return keys.size === item.choices.length && (item.tool === "ExitPlanMode"
    ? item.choices.length === 1 && keys.has("1.1") && item.choices[0]!.label === undefined && item.choices[0]!.preview === undefined && !!item.choices[0]!.text.trim()
    : item.choices.every(choice => choice.label?.trim() && Buffer.byteLength(choice.text) <= 2048));
});
export type ClickedApproval = z.infer<typeof Approval>;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const SCAN_LIMIT = 256;

/** Private Review data. It never supplies a typed quote, an entry or team evidence. */
export function clickedApprovals(options: KnowledgeOptions, now = Date.now()): ClickedApproval[] {
  const project = knowledgeProject(options), reader = openRecordReadOnly(options);
  if (!reader) return [];
  try {
    const checkout = reader.checkout(project.root), scope = project.projectId;
    if (reader.diagnostic || !clickedApprovalsOn(reader) || process.env.MEX_OFF === "1"
      || reader.setting("global", "enabled") === "false" || !checkoutOn(checkout ?? {}, now)
      || reader.setting("global", "capture.enabled") === "false" || reader.setting(scope, "capture.enabled") === "false") return [];
    const folder = containedDirectory(project.location.directory, ["filter-approvals", shortHash(scope + "\0" + project.root)]);
    if (!folder) return [];
    const approvals: ClickedApproval[] = [], entries = opendirSync(folder);
    try {
      for (let i = 0; i < SCAN_LIMIT; i++) {
        const entry = entries.readSync();
        if (!entry) break;
        if (!entry.isFile() || !/^[a-f0-9]{24}\.json$/u.test(entry.name)) continue;
        let item: ClickedApproval;
        try {
          const raw = readBoundedTextFile(join(folder, entry.name), 16 << 10);
          if (!raw) continue;
          item = Approval.parse(JSON.parse(raw));
        } catch { continue; }
        if (item.checkout !== project.root || item.project_id !== scope) continue;
        const seen = Date.parse(item.at);
        if (seen > now || seen <= now - RETENTION_MS) continue;
        const name = shortHash([scope, project.root, item.agent, item.session_id, item.call_id].join("\0")) + ".json";
        if (name === entry.name) approvals.push(item);
      }
    } finally { entries.closeSync(); }
    return approvals.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.call_id.localeCompare(b.call_id));
  } finally { reader.close(); }
}
