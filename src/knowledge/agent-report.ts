import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash } from "../judge/evidence.js";
import type { JudgeParams } from "../judge/pending.js";
import { openHooksReadOnly, openRecord } from "../record/index.js";
import { knowledgeProject, type KnowledgeOptions } from "./context.js";
import { KnowledgeError, parseEntry } from "./entry.js";
import { containedDirectory, readBoundedTextFile, readEntryFile } from "./files.js";
import { assertNoSecrets, stripHidden } from "./gates.js";
import { repoFile } from "./references.js";
import { expand } from "./store.js";
import { stageUpkeep } from "./upkeep.js";
import { noteProbe } from "./what.js";

const ReasonKind = z.enum(["contradicted", "rejected-by-ci", "not-applicable", "other"]);
const StoredReasonKind = z.enum([...ReasonKind.options, "outdated", "wrong-scope", "noisy"]);
const Report = z.object({ version: z.literal(1), type: z.literal("agent-report"), reason: z.string().min(1).max(400), kind: ReasonKind,
  entry_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u), invocation: z.string().uuid(), file: z.string().max(360).optional() }).strict();
type Reason = Pick<z.infer<typeof Report>, "kind" | "reason" | "file">;
const StoredReport = Report.extend({ kind: StoredReasonKind });
type StoredReason = Pick<z.infer<typeof StoredReport>, "kind" | "reason" | "file">;

export function parseWrongReason(raw: string, checkout: string, report = true): Reason {
  const value = raw.trim();
  if (/^contradicted(?:\s|$)/u.test(value)) {
    const match = /^contradicted ([^\r\n]+):([1-9]\d*)$/u.exec(value);
    const path = match?.[1]?.replace(/^\.\//u, ""), line = Number(match?.[2]);
    const bad = () => new KnowledgeError("INVALID_ENTRY", "Use contradicted <file:line> with a line in this checkout.");
    if (!path || !Number.isSafeInteger(line) || path.length > 360) throw bad();
    let text: string | undefined;
    try {
      const file = repoFile(checkout, path);
      if (file) text = readBoundedTextFile(file, 1 << 20);
    } catch { throw bad(); }
    if (!text || line > text.replace(/(?:\r\n|\r|\n)$/u, "").split(/\r\n|\r|\n/u).length) throw bad();
    assertNoSecrets(path);
    return { kind: "contradicted", reason: `contradicted ${path}:${line}`, file: path };
  }
  if (!report) return { kind: "other", reason: raw };
  const cleaned = stripHidden(value).replace(/\s+/gu, " ");
  if (!cleaned) throw new KnowledgeError("INVALID_ENTRY", "Use contradicted <file:line>, rejected-by-ci, not-applicable, or free text.");
  if (Buffer.byteLength(cleaned) > 400) throw new KnowledgeError("INVALID_ENTRY", "Give a reason of 400 bytes or fewer.");
  assertNoSecrets(cleaned);
  const kind = ReasonKind.safeParse(cleaned === "wrong-scope" ? "not-applicable" : cleaned);
  return { kind: kind.success ? kind.data : "other", reason: cleaned };
}

export async function reportWrong(id: string, reason: Reason, options: KnowledgeOptions): Promise<string> {
  const project = knowledgeProject(options);
  const { entry, level } = expand(id, options);
  if (level === "hint" || entry.mex.status !== "active") throw new KnowledgeError("INVALID_ENTRY", "Report an active rule by its id.");
  const home = project.location.home;
  const base = level === "personal" ? containedDirectory(home, ["projects", project.projectId, "notes"]) : project.root;
  const paths = level === "personal" ? [`${id}.md`] : [`.mex/learned/${id}.md`, `.mex/learned/${entry.mex.kind}/${id}.md`];
  const path = base && paths.map(relative => repoFile(base, relative)).find(Boolean);
  const raw = path && readEntryFile(path);
  const saved = raw && parseEntry(raw);
  if (!path || !raw || !saved || saved.mex.id !== id || saved.mex.status !== "active") throw new KnowledgeError("NOT_FOUND", "The rule changed. Read it again before reporting it.");
  const entryHash = hash(raw);
  const invocation = randomUUID();
  const detail = Report.parse({ ...reason, version: 1, type: "agent-report", entry_hash: entryHash, invocation });
  const writer = openRecord({ ...options, projectPath: project.root });
  let jobId: string;
  try {
    if (!noteProbe(id, "wrong", options, detail)) throw new KnowledgeError("STORE_UNAVAILABLE", "MEX could not save the agent report. Try again.");
    stageUpkeep(writer, project.projectId, { kind: "report", checkout: project.root, id, path, level, entryHash },
      `An agent reported this rule wrong: ${reason.reason}`, invocation, Date.now());
    const { queueJob } = await import("../record/background.js");
    const env = options.env ?? process.env;
    const params: JudgeParams = { checkout: project.root, agent: (env.CLAUDECODE || env.CLAUDE_CODE_CHILD_SESSION) ? "claude" : "codex",
      near: reason.file ? [reason.file] : [], report: true };
    jobId = queueJob(writer, { kind: "judge", projectId: project.projectId, params }).job.id;
  } finally { writer.close(); }
  return jobId;
}

export function agentReports(home: string, project: string, checkout: string): Map<string, StoredReason> {
  const reports = new Map<string, StoredReason>(), hooks = openHooksReadOnly({ home });
  try {
    if (!hooks || hooks.diagnostic) return reports;
    const rows = hooks.all<{ entry_id: string; detail: string }>(`SELECT d.entry_id,f.detail FROM followups f JOIN deliveries d ON d.id=f.delivery_id
      WHERE d.project_id=? AND d.checkout=? AND f.kind='wrong' AND length(CAST(f.detail AS BLOB))<=1024 AND f.detail LIKE '%"agent-report"%'
      ORDER BY f.id DESC LIMIT 5000`, project, checkout);
    for (const row of rows) {
      try {
        const parsed = StoredReport.safeParse(JSON.parse(row.detail));
        if (!parsed.success) continue;
        const { kind, reason, file, entry_hash } = parsed.data;
        const key = `${row.entry_id}:${entry_hash}`;
        if (!reports.has(key)) reports.set(key, { kind, reason, file });
      } catch { /* Incomplete evidence cannot challenge the rule. */ }
    }
  } catch { /* Missing or busy observation data can be read on the next pass. */ }
  finally { hooks?.close(); }
  return reports;
}
