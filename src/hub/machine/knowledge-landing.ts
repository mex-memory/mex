import type { MachineKnowledgeLandingSchema } from "@mex/hub-contracts/machine";
import type { z } from "zod";
import { RULE_CHANGE_LIMITS, ruleChangeKey, type RuleSnapshot } from "../../judge/rule-change.js";
import { hasSecret, stripHidden } from "../../knowledge/gates.js";
import { openRecordReadOnly, type RecordReader } from "../../record/index.js";
import type { KnowledgeData } from "./knowledge.js";
import { compareRows, emptyStatusCounts, ensureRepo, itemSummary, needsLook, partialNotes, scopedRows } from "./knowledge-list.js";
import type { KnowledgeRow } from "./knowledge-snapshot.js";
import { boundedSetting, readStore } from "./read.js";

type Landing = z.infer<typeof MachineKnowledgeLandingSchema>;
type Kind = KnowledgeRow["kind"];
const kinds: readonly Kind[] = ["rule", "decision", "recipe", "pitfall", "procedure", "fact", "hint"];
const MAX_SCANNED_AREAS = 2_048;
const MAX_SHOWN_AREAS = 48;

function emptyGroup() {
  return { count: 0, statusCounts: emptyStatusCounts(), topItems: [] as KnowledgeRow[] };
}
type Group = ReturnType<typeof emptyGroup>;

function insertTop(top: KnowledgeRow[], row: KnowledgeRow, compare = compareRows) {
  if (top.length === 3 && compare(row, top[2]) >= 0) return;
  top.push(row);
  top.sort(compare);
  if (top.length > 3) top.pop();
}

function addToGroup(group: Group, row: KnowledgeRow) {
  group.count++;
  group.statusCounts[row.status]++;
  insertTop(group.topItems, row);
}

function summarize({ topItems, ...counts }: Group) {
  return { ...counts, topItems: topItems.map(itemSummary) };
}

function compareAttention(a: KnowledgeRow, b: KnowledgeRow) {
  return Number(b.status === "outOfDate") - Number(a.status === "outOfDate")
    || (a.checkedAt ?? "\uffff").localeCompare(b.checkedAt ?? "\uffff") || compareRows(a, b);
}

function why(reader: RecordReader | undefined, row: KnowledgeRow): string {
  if (reader && row.checkout) {
    const saved = boundedSetting(reader, row.repoId, ruleChangeKey(row.checkout), RULE_CHANGE_LIMITS.snapshot);
    if (saved) {
      try {
        const signal = JSON.parse(saved) as RuleSnapshot;
        if (signal.version === 1 && signal.checkout === row.checkout && Array.isArray(signal.entries)) {
          const reason = signal.entries.find((item) => item?.id === row.id && item.entry_hash === "sha256:" + row.revision)?.reasons?.[0];
          if (typeof reason === "string" && reason.length <= 512 && !hasSecret(reason) && stripHidden(reason).trim()) return stripHidden(reason);
        }
      } catch { /* Invalid cached evidence falls back to the saved status. */ }
    }
  }
  return row.status === "outOfDate" ? "A check no longer holds" : "The code it checks has changed";
}

export function readKnowledgeLanding(data: KnowledgeData, repo?: string): Landing {
  ensureRepo(data.location, repo);
  const { snapshot, generatedAt, updatingSince } = data.get();
  const areas = new Map<string, { pattern: string; repoId?: string; group: Group }>();
  const byKind = new Map<Kind, Group>();
  const attention: KnowledgeRow[] = [];
  let needsAttention = 0;
  let omittedAreas = false;
  for (const row of scopedRows(snapshot, repo)) {
    let kind = byKind.get(row.kind);
    if (!kind) byKind.set(row.kind, kind = emptyGroup());
    addToGroup(kind, row);

    for (const pattern of new Set(row.scope)) {
      const repoId = pattern === "**" ? undefined : row.repoId;
      const key = repoId ? repoId + ":" + pattern : pattern;
      let area = areas.get(key);
      if (!area) {
        if (areas.size >= MAX_SCANNED_AREAS) { omittedAreas = true; continue; }
        areas.set(key, area = { pattern, repoId, group: emptyGroup() });
      }
      addToGroup(area.group, row);
    }

    if (needsLook(row)) {
      needsAttention++;
      insertTop(attention, row, compareAttention);
    }
  }
  let items: Landing["needsLook"]["items"];
  try {
    items = attention.length ? readStore(openRecordReadOnly, data.location, (reader) =>
      attention.map((row) => ({ ...itemSummary(row), why: why(reader, row) }))) : [];
  } catch {
    items = attention.map((row) => ({ ...itemSummary(row), why: why(undefined, row) }));
  }

  const partial = partialNotes(snapshot, repo) ?? [];
  if (omittedAreas || areas.size > MAX_SHOWN_AREAS) partial.push({ note: "Some areas aren’t shown. Browse all items to see their full scope." });
  return {
    generatedAt, updatingSince, partial: partial.length ? partial : undefined,
    needsLook: { total: needsAttention, items },
    groups: {
      byKind: kinds.flatMap((kind) => byKind.has(kind) ? [{ kind, ...summarize(byKind.get(kind)!) }] : []),
      byArea: [...areas.values()]
        .sort((a, b) => Number(b.pattern === "**") - Number(a.pattern === "**") || b.group.count - a.group.count
          || a.pattern.localeCompare(b.pattern) || (a.repoId ?? "").localeCompare(b.repoId ?? ""))
        .slice(0, MAX_SHOWN_AREAS)
        .map(({ pattern, repoId, group }) => ({ pattern, repoId, ...summarize(group) })),
    },
  };
}
