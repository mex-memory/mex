import { createHash, randomBytes } from "node:crypto";
import { lstatSync, opendirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DiagramIdSchema, StatechartArtifactSchema, STATECHART_LIMITS as L, type StatechartArtifact, type DiagramDetail, type DiagramCollection, type DiagramSavePlan } from "@mex/hub-contracts/statechart";
import { assertContainedArtifactDirectory, atomicCreateArtifact, tryReadContainedArtifact, withContainedArtifactLock } from "../team/artifacts/filesystem.js";
import { RepositoryRootGuard } from "../team/workflow/repository-root.js";
import { artifactError } from "../team/artifacts/errors.js";

const MAX_SAVE_RESPONSE_BYTES = 900 * 1024;
const LOCAL = ".mex/local/diagrams", SAVED = ".mex/diagrams";
const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
// Evidence baselines are compared, never executed; large sources stay verifiable.
const EVIDENCE_BYTES = 4 * 1024 * 1024;
/** Git line-ending conversion (core.autocrlf) must not flag shared evidence as changed. */
function sameBaseline(bytes: Uint8Array, sha256: string): boolean {
  if (hash(bytes) === sha256) return true;
  const lf = Buffer.from(bytes).toString("latin1").replace(/\r\n/gu, "\n");
  return hash(Buffer.from(lf, "latin1")) === sha256 || hash(Buffer.from(lf.replace(/\n/gu, "\r\n"), "latin1")) === sha256;
}
const freshId = () => randomBytes(16).toString("hex");
function problem(code: "NOT_FOUND" | "REVISION_CONFLICT" | "VALIDATION_FAILED", detail: string): never { throw artifactError(code, "Diagram unavailable", detail); }
function markdownText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/([\\`*_{}\[\]()#+.!|])/gu, "\\$1");
}
const RECORD_MARKER = "\n<!-- mex-statechart:v1 -->\n```json\n";
const RECORD_END = "\n```\n";
function encode(a: StatechartArtifact): string {
  // Human prose and the fenced data share one owner; companions retain inputs.
  const lines = [`# ${markdownText(a.title)}`, "", markdownText(a.summary), "", `Scope: ${markdownText(a.scope)}`, `Classification: ${a.classification}. Reader: ${markdownText(a.reader)}.`, "", "## Recorded verification", "", `Diagram: ${a.diagram.validity}. Model check: ${a.check.outcome}. Implementation reproduction: ${a.reproduction.outcome}.`, markdownText(a.check.bounds), markdownText(a.reproduction.detail), "", "Snapshot of recorded inputs; unchanged hashes do not prove semantic correctness.", "", "## Rules", ""];
  for (const r of a.rules) lines.push(`- ${markdownText(r.label)} (${r.kind}; ${a.check.results.find(x => x.rule === r.id)?.outcome ?? "incomplete"}). ${markdownText(r.provenance)}`);
  lines.push("", "## Retained evidence", "");
  for (const e of a.evidence) lines.push(`- ${markdownText(e.path)}${e.line ? `:${e.line}` : ""} (${e.kind}). ${markdownText(e.note)} Baseline: ${e.sha256 ?? "unverified"}. Explains: ${e.explains.join(", ")}.`);
  if (!a.evidence.length) lines.push("No repository evidence recorded; implementation alignment is unverified.");
  lines.push("", "## Model limits", "", ...a.omissions.map(o => `- ${markdownText(o)}`), "");
  return lines.join("\n") + RECORD_MARKER + JSON.stringify(a, null, 2) + RECORD_END;
}
function decode(bytes: Uint8Array): StatechartArtifact {
  const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/gu, "\n");
  // A retained summary may itself discuss the format. Only the final owner
  // marker is authoritative; JSON string newlines are escaped by the writer.
  const start = s.lastIndexOf(RECORD_MARKER);
  if (start < 0 || !s.endsWith(RECORD_END)) problem("VALIDATION_FAILED", "Unsupported diagram snapshot.");
  return StatechartArtifactSchema.parse(JSON.parse(s.slice(start + RECORD_MARKER.length, -RECORD_END.length)));
}

/** Feature-owned storage; constructors and ordinary reads never initialize or clean up. */
export class DiagramRepository {
  readonly root: RepositoryRootGuard;
  readonly #plans = new Map<string, DiagramSavePlan>();
  constructor(projectRoot: string, readonly now = () => new Date()) { this.root = new RepositoryRootGuard(projectRoot); }
  #assert() { this.root.assertCurrent(); if (!assertContainedArtifactDirectory(this.root.path, ".mex")) problem("NOT_FOUND", "MEX scaffold unavailable."); }
  #names(path: string, cap: number): string[] {
    this.#assert(); const dir = assertContainedArtifactDirectory(this.root.path, path); if (!dir) return [];
    const result: string[] = []; const handle = opendirSync(dir);
    try { let entry; let scanned = 0; while ((entry = handle.readSync())) { if (++scanned > cap + 32) problem("VALIDATION_FAILED", "Diagram collection scan limit reached."); if (DiagramIdSchema.safeParse(entry.name).success) { if (!entry.isDirectory() || entry.isSymbolicLink()) problem("VALIDATION_FAILED", "Unsafe diagram collection entry."); result.push(entry.name); if (result.length > cap) problem("VALIDATION_FAILED", "Diagram retention limit reached."); } } } finally { handle.closeSync(); }
    this.root.assertCurrent(); return result.sort();
  }
  #read(kind: "preview" | "saved", id: string): { artifact: StatechartArtifact; revision: string; expiresAt: string | null } | null {
    DiagramIdSchema.parse(id); this.#assert();
    const base = `${kind === "preview" ? LOCAL : SAVED}/${id}`;
    const file = tryReadContainedArtifact(this.root.path, `${base}/record.md`, L.bytes * 2, "exact");
    if (!file) return null;
    const artifact = decode(file.bytes);
    // Private expiry is immutable and independent of agent-authored timestamps.
    let expiresAt: string | null = null;
    if (kind === "preview") {
      const meta = tryReadContainedArtifact(this.root.path, `${base}/expiry.txt`, 64, "exact");
      if (!meta) problem("VALIDATION_FAILED", "Preview expiry is unavailable.");
      expiresAt = new TextDecoder().decode(meta.bytes);
      if (!Number.isFinite(Date.parse(expiresAt))) problem("VALIDATION_FAILED", "Invalid preview expiry.");
    }
    this.root.assertCurrent(); return { artifact, revision: hash(file.bytes), expiresAt };
  }
  list(): DiagramCollection {
    const items: DiagramCollection["items"] = [];
    for (const kind of ["preview", "saved"] as const) for (const id of this.#names(kind === "preview" ? LOCAL : SAVED, kind === "preview" ? L.previews : L.snapshots)) {
      // One unreadable or newer-format snapshot must not hide every other diagram;
      // opening it directly still reports the exact validation problem.
      let r: { artifact: StatechartArtifact; expiresAt: string | null } | null;
      try { r = this.#read(kind, id); } catch { this.root.assertCurrent(); continue; }
      if (!r || (r.expiresAt && Date.parse(r.expiresAt) <= +this.now())) continue;
      items.push({ id, title: r.artifact.title, summary: r.artifact.summary, outcome: r.artifact.check.outcome, kind, expiresAt: r.expiresAt });
    }
    return { items, truncated: false };
  }
  get(kind: "preview" | "saved", id: string): DiagramDetail {
    const r = this.#read(kind, id); if (!r) problem("NOT_FOUND", "The diagram is unavailable or its temporary preview has expired.");
    if (r.expiresAt && Date.parse(r.expiresAt) <= +this.now()) problem("NOT_FOUND", "This temporary diagram has expired. Ask the agent to generate a new preview.");
    const freshness = r.artifact.evidence.map(e => {
      let status: DiagramDetail["freshness"][number]["status"] = "unverified";
      try { const file = tryReadContainedArtifact(this.root.path, e.path, EVIDENCE_BYTES, "exact"); status = !file ? "missing" : e.sha256 ? sameBaseline(file.bytes, e.sha256) ? "unchanged" : "changed" : "unverified"; } catch { /* Containment/read failure is unavailable evidence, never fresh. */ }
      return { evidence: e.id, status };
    });
    const code = r.artifact.evidence.filter(e => e.kind === "code");
    const mapped = r.artifact.mapping.length > 0 && [...r.artifact.states, ...r.artifact.transitions].every(t => r.artifact.mapping.some(m => m.targets.includes(t.id) && m.evidence.some(id => code.some(e => e.id === id))));
    this.root.assertCurrent();
    return { id, kind, title: r.artifact.title, summary: r.artifact.summary, outcome: r.artifact.check.outcome, ...r, freshness, alignment: mapped ? "source-mapped" : "unverified" };
  }
  async register(input: unknown): Promise<{ id: string; route: string; expiresAt: string }> {
    const artifact = StatechartArtifactSchema.parse(input); this.#assert();
    const retained = [{ path: "record.md", content: encode(artifact) }, ...artifact.files.map(f => ({ path: f.name, content: f.content })), { path: "diagram.mmd", content: artifact.diagram.mermaid }];
    if (new Set(retained.map(f => f.path.toLowerCase())).size !== retained.length || Buffer.byteLength(JSON.stringify(retained)) > MAX_SAVE_RESPONSE_BYTES || Buffer.byteLength(retained[0]!.content) > L.bytes) problem("VALIDATION_FAILED", "Artifact exceeds the portable save-review limit or uses a reserved companion name.");
    return withContainedArtifactLock(this.root.path, LOCAL, ".write-lock", async () => {
      // Explicit write boundary owns expiry/eviction. No read performs cleanup.
      const live: { id: string; expires: number }[] = [];
      for (const id of this.#names(LOCAL, L.previews)) { const old = this.#read("preview", id); if (!old) problem("VALIDATION_FAILED", "Incomplete preview requires local inspection."); const expires = Date.parse(old.expiresAt!); if (expires <= +this.now()) this.#removePreview(id); else live.push({ id, expires }); }
      if (live.length >= L.previews) { live.sort((a, b) => a.expires - b.expires || a.id.localeCompare(b.id)); this.#removePreview(live[0]!.id); }
      const id = freshId(), expiresAt = new Date(+this.now() + L.ttlMs).toISOString();
      this.#publish(LOCAL, id, [{ path: "record.md", content: encode(artifact) }, { path: "expiry.txt", content: expiresAt }], true);
      return { id, route: `/diagrams/preview/${id}`, expiresAt };
    });
  }
  #removePreview(id: string) { const dir = assertContainedArtifactDirectory(this.root.path, `${LOCAL}/${id}`); this.root.assertCurrent(); if (dir) rmSync(dir, { recursive: true }); }
  previewSave(id: string, revision: string): DiagramSavePlan {
    const detail = this.get("preview", id); if (detail.revision !== revision) problem("REVISION_CONFLICT", "The preview changed. Review it again.");
    if (this.#names(SAVED, L.snapshots).length >= L.snapshots) problem("VALIDATION_FAILED", "Saved diagram limit reached.");
    const snapshot = freshId(), base = `${SAVED}/${snapshot}`;
    const writes = [ { path: `${base}/record.md`, content: encode(detail.artifact) }, ...detail.artifact.files.map(f => ({ path: `${base}/${f.name}`, content: f.content })), { path: `${base}/diagram.mmd`, content: detail.artifact.diagram.mermaid } ];
    if (new Set(writes.map(w => w.path.toLowerCase())).size !== writes.length) problem("VALIDATION_FAILED", "Companion files use reserved names.");
    for (const [token, p] of this.#plans) if (+new Date(p.expiresAt) <= +this.now()) this.#plans.delete(token);
    if (this.#plans.size >= L.previews) problem("VALIDATION_FAILED", "Too many pending save reviews.");
    const plan = { token: freshId(), previewId: id, revision, expiresAt: new Date(+this.now() + 5 * 60_000).toISOString(), writes };
    if (Buffer.byteLength(JSON.stringify(plan)) > MAX_SAVE_RESPONSE_BYTES) problem("VALIDATION_FAILED", "Snapshot exceeds the save-review response limit.");
    this.#plans.set(plan.token, structuredClone(plan)); return plan;
  }
  async applySave(token: string): Promise<DiagramDetail> {
    DiagramIdSchema.parse(token); const p = this.#plans.get(token); if (!p || +new Date(p.expiresAt) <= +this.now()) problem("REVISION_CONFLICT", "Save review expired. Preview the exact writes again.");
    return withContainedArtifactLock(this.root.path, SAVED, ".write-lock", () => {
      const current = this.get("preview", p.previewId); if (current.revision !== p.revision) problem("REVISION_CONFLICT", "Preview changed after review.");
      if (this.#names(SAVED, L.snapshots).length >= L.snapshots) problem("VALIDATION_FAILED", "Saved diagram limit reached.");
      const id = p.writes[0]!.path.split("/")[2]!;
      this.#publish(SAVED, id, p.writes.map(w => ({ path: w.path.split("/").at(-1)!, content: w.content })), false);
      this.#plans.delete(token); return this.get("saved", id);
    });
  }
  #publish(parent: string, id: string, files: { path: string; content: string }[], privateMode: boolean) {
    this.#assert(); const parentPath = assertContainedArtifactDirectory(this.root.path, parent)!;
    const identity = lstatSync(parentPath, { bigint: true }); const stage = `${parent}/.pending-${freshId()}`;
    try {
      for (const file of files) atomicCreateArtifact(this.root.path, `${stage}/${file.path}`, file.content, privateMode ? 0o600 : 0o644);
      this.root.assertCurrent();
      if (assertContainedArtifactDirectory(this.root.path, parent) !== parentPath) problem("REVISION_CONFLICT", "Diagram directory changed.");
      const current = lstatSync(parentPath, { bigint: true }); if (current.dev !== identity.dev || current.ino !== identity.ino) problem("REVISION_CONFLICT", "Diagram directory changed.");
      assertContainedArtifactDirectory(this.root.path, stage);
      try { lstatSync(resolve(this.root.path, parent, id)); problem("REVISION_CONFLICT", "Snapshot already exists."); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      renameSync(resolve(this.root.path, stage), resolve(parentPath, id)); this.root.assertCurrent();
    } finally {
      // Only remove a verified, still-contained unpublished directory.
      try { if (assertContainedArtifactDirectory(this.root.path, stage)) rmSync(resolve(this.root.path, stage), { recursive: true }); } catch { /* Never follow a replaced directory during recovery. */ }
    }
  }
}
