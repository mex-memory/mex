import { useRef, useState } from "react";
import type { MachineProject } from "@mex/hub-contracts/machine";
import type { FixtureVariant, KnowledgeFixture } from "./fixtures";
import type {
  ForgottenItem, KnowledgeCreate, KnowledgeDetail, KnowledgeEdit, KnowledgeEditResult, KnowledgeFilters,
  KnowledgeForget, KnowledgeForgetResult, KnowledgeItem, KnowledgePageData, KnowledgePreview,
} from "./types";

const fixturePageSize = 20;

function listItem({ id, key, repoId, oneLine, kind, audience, status, lastUsedAt }: KnowledgeDetail): KnowledgeItem {
  return { id, key, repoId, oneLine, kind, audience, status, lastUsedAt };
}

function pageOf(fixture: KnowledgeFixture, filters: KnowledgeFilters, cursor?: string): KnowledgePageData {
  const scoped = fixture.items.filter(({ repoId }) => !filters.scopeId || repoId === filters.scopeId);
  const statusCounts = { upToDate: 0, codeChanged: 0, outOfDate: 0, notChecked: 0 };
  const kindCounts: KnowledgePageData["kindCounts"] = {};
  const audienceCounts: KnowledgePageData["audienceCounts"] = {};
  const words = filters.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const matches: KnowledgeItem[] = [];

  for (const item of scoped) {
    statusCounts[item.status]++;
    kindCounts[item.kind] = (kindCounts[item.kind] ?? 0) + 1;
    audienceCounts[item.audience] = (audienceCounts[item.audience] ?? 0) + 1;
    if (filters.repoId && item.repoId !== filters.repoId) continue;
    if (filters.kind && item.kind !== filters.kind) continue;
    if (filters.audience && item.audience !== filters.audience) continue;
    if (filters.status && item.status !== filters.status) continue;
    const searchable = `${item.oneLine} ${item.text} ${item.scope.join(" ")}`.toLocaleLowerCase();
    if (words.every((word) => searchable.includes(word))) matches.push(listItem(item));
  }

  const start = cursor === undefined ? 0 : Number(cursor);
  const end = start + fixturePageSize;
  return {
    items: matches.slice(start, end),
    total: matches.length,
    nextCursor: end < matches.length ? String(end) : null,
    statusCounts, kindCounts, audienceCounts,
    generatedAt: fixture.generatedAt,
    updatingSince: fixture.updatingSince,
  };
}

function teamFile(item: KnowledgeDetail, retiredAt?: string, reason?: string) {
  return [
    "---",
    "mex:",
    `  id: ${item.id}`,
    `  kind: ${item.kind}`,
    `  status: ${retiredAt ? "retired" : "active"}`,
    ...(retiredAt ? ["  retired:", `    at: ${retiredAt.slice(0, 10)}`, `    reason: ${JSON.stringify(reason ?? "Forgotten in the Hub")}`] : []),
    `  one_line: ${JSON.stringify(item.oneLine)}`,
    "  scope:",
    ...item.scope.map((pattern) => `    - ${JSON.stringify(pattern)}`),
    "---",
    "",
    ...item.text.split("\n"),
  ];
}

function unifiedDiff(path: string, before: string[], after: string[]) {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let sharedEnd = 0;
  while (
    sharedEnd < Math.min(before.length, after.length) - start &&
    before.at(-sharedEnd - 1) === after.at(-sharedEnd - 1)
  ) sharedEnd++;
  const contextStart = Math.max(0, start - 2);
  const beforeEnd = before.length - sharedEnd;
  const afterEnd = after.length - sharedEnd;
  const contextEnd = Math.min(sharedEnd, 2);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${contextStart + 1},${beforeEnd + contextEnd - contextStart} +${contextStart + 1},${afterEnd + contextEnd - contextStart} @@`,
    ...before.slice(contextStart, start).map((line) => ` ${line}`),
    ...before.slice(start, beforeEnd).map((line) => `-${line}`),
    ...after.slice(start, afterEnd).map((line) => `+${line}`),
    ...after.slice(afterEnd, afterEnd + contextEnd).map((line) => ` ${line}`),
  ].join("\n");
}

export function useFixtureKnowledge(initial: KnowledgeFixture, projects: readonly MachineProject[], variant: FixtureVariant): KnowledgePreview {
  const [fixture, setFixture] = useState(initial);
  const current = useRef(initial);
  const sequence = useRef(1);
  const conflictShown = useRef(false);
  const pending = useRef<{ revision: string; signature: string } | null>(null);
  const revision = () => `r${++sequence.current}`;

  function publish(next: KnowledgeFixture) {
    current.current = next;
    setFixture(next);
  }

  function replace(item: KnowledgeDetail, at: string) {
    publish({
      ...current.current, generatedAt: at,
      items: current.current.items.map((old) => old.key === item.key ? item : old),
    });
  }

  function getCurrent(key: string) {
    const item = current.current.items.find((item) => item.key === key);
    if (!item) throw new Error("This item is no longer available.");
    return item;
  }

  function createNote(request: KnowledgeCreate) {
    const { repoId, kind, scope, text } = request;
    if (!projects.some(({ id }) => id === repoId)) throw new Error("Choose a repo for this note.");
    const at = new Date().toISOString();
    const noteRevision = revision();
    const id = `mx_hubnote${noteRevision.slice(1)}`;
    const item: KnowledgeDetail = {
      id, key: `${repoId}:personal:${id}`, repoId, audience: "personal", kind, scope, text,
      oneLine: text.split("\n")[0].trim().slice(0, 1024),
      revision: noteRevision, status: "notChecked", checks: [],
      source: { type: "note", via: "hub", at }, lastUsedAt: null, useCount30Days: 0, history: [{ type: "added", at }],
    };
    publish({ ...current.current, generatedAt: at, items: [item, ...current.current.items] });
    return { type: "ok" as const, item };
  }

  function teamPreview(item: KnowledgeDetail, request: KnowledgeEdit | KnowledgeForget, after: string[]) {
    if (item.source.type !== "team") return;
    const { confirmRevision, ...draft } = request;
    const signature = JSON.stringify([draft, after]);
    if (pending.current && confirmRevision === pending.current.revision && signature === pending.current.signature) {
      pending.current = null;
      return;
    }
    const { path, checkout } = item.source;
    const previewRevision = revision();
    pending.current = { revision: previewRevision, signature };
    return { type: "preview" as const, diff: unifiedDiff(path, teamFile(item), after), path, checkout, revision: previewRevision };
  }

  function editNote(request: KnowledgeEdit): KnowledgeEditResult {
    let item = getCurrent(request.key);
    const at = new Date().toISOString();
    if (variant === "conflict" && !conflictShown.current && item.key === "storefront:personal:mx_checkout") {
      conflictShown.current = true;
      item = {
        ...item, revision: revision(),
        text: "Parse the request at the API boundary. Validate the shipping address against the saved cart before contacting the payment provider.\n\nReturn field errors in the same format for both checkout paths.",
        history: [{ type: "edited", at }, ...item.history],
      };
      replace(item, at);
    }
    if (item.revision !== request.expectedRevision) return { type: "conflict", current: item, attempted: request };
    if (item.audience === "hint") throw new Error("Edit this hint in your agent’s memory.");
    const { oneLine, text, kind, scope } = request;
    const updated: KnowledgeDetail = {
      ...item, oneLine, text, kind, scope,
      status: "notChecked", checks: [],
      source: item.audience === "personal" ? { type: "note", at, via: "hub", edited: true } : item.source,
      evidence: item.audience === "personal" ? undefined : item.evidence,
      history: [{ type: "edited", at }, ...item.history],
    };
    const preview = teamPreview(item, request, teamFile(updated));
    if (preview) return preview;
    updated.revision = revision();
    replace(updated, at);
    return { type: "ok", item: updated };
  }

  function forgetItem(request: KnowledgeForget): KnowledgeForgetResult {
    const item = getCurrent(request.key);
    if (item.revision !== request.expectedRevision) return { type: "conflict", current: item, attempted: request };
    const at = new Date().toISOString();
    const preview = teamPreview(item, request, teamFile(item, at, request.reason));
    if (preview) return preview;
    const forgotten: ForgottenItem = { id: item.id, repoId: item.repoId, audience: item.audience, at };
    publish({
      ...current.current,
      generatedAt: at,
      items: current.current.items.filter(({ key }) => key !== item.key),
      forgotten: [forgotten, ...current.current.forgotten],
    });
    return { type: "ok", item: forgotten };
  }

  return {
    getPage: (filters, cursor) => pageOf(fixture, filters, cursor),
    getDetail: (key) => fixture.items.find((item) => item.key === key),
    forgotten: fixture.forgotten,
    createNote,
    editNote,
    forgetItem,
  };
}
