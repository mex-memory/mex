import { randomUUID } from "node:crypto";
import { SourceError } from "../forge.js";
import { command, PinnedTree } from "../git.js";
import { quoteCeiling } from "../plan.js";
import { Reviewers } from "../reviewers.js";
import { repository, type SourceWindow } from "../source.js";
import { addHarvestEvidence, DEFAULT_HARVEST_BUDGET, emptyHarvestEvidence, estimateHarvest, forecastCounts, projectHarvestSpend } from "./estimate.js";
import { Gaps, rankCandidates, safeRaw } from "./evidence.js";
import { templateLines } from "./description.js";
import { Familiarity } from "./familiarity.js";
import { changeCandidates, changes, discussions, observeAuthors, readyThreads, revertDiscussion, reviewedFiles, ReviewRead, search, type ForgeItem } from "./forge.js";
import { localCandidates, localInventory, readRevert } from "./local.js";
import { oid, RegionReader } from "./regions.js";
import type { Candidate, ForgeSource, HarvestBatch, HarvestCursor, HarvestDeps, HarvestEvidenceSize, HarvestLane, HarvestOptions, HarvestPlan,
  HarvestPoint, HarvestScan, HarvestSource, SearchPage } from "./types.js";

export type { Candidate, CandidateKind, HarvestBatch, HarvestCursor, HarvestDeps, HarvestOptions, HarvestPlan, Region } from "./types.js";
export { DEFAULT_HARVEST_BUDGET, estimateHarvest, forecastCounts } from "./estimate.js";
export { corroborateReviewFamiliarity } from "./familiarity.js";
export { evidenceDigest } from "./evidence.js";

const FORGE_PER_BATCH = 4;
const LOCAL_PER_BATCH = 2;
const SEARCHES_PER_BATCH = 6;
// The token budget is what the person agreed to, so it should end a run before this does. A tenth of GitHub's hourly
// allowance covers the searches and detail reads of a long window, with room for permission checks and blobs.
const DEFAULT_REQUEST_BUDGET = 512;
const FORGE_BUDGET_GAP = "Learning reached its forge request budget.";
const SECOND = 1000;
const localSources = ["revert", "cause", "adr", "doc"] as const;
const forgeSource = (source: HarvestSource): source is ForgeSource => source === "merged" || source === "closed" || source === "issue";
const documentSource = (source: string) => source === "doc" || source === "adr";
const DOCUMENT_BUDGET_GAP = "Contributor documents reached their share of the estimated token budget.";
const DESCRIPTION_BUDGET_GAP = "Pull request descriptions reached their share of the estimated token budget.";
// Private run accounting. Older cursors only have the aggregate evidence size.
type HarvestRun = NonNullable<HarvestCursor["run"]> & { documentEvidence?: HarvestEvidenceSize; descriptionEvidence?: HarvestEvidenceSize };
const byPoint = (a: HarvestPoint, b: HarvestPoint) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id, "en");

function bands(window: SourceWindow): SourceWindow[] {
  const from = Math.ceil(Date.parse(window.since) / SECOND), to = Math.floor(Date.parse(window.until) / SECOND);
  const size = Math.min(6, to - from + 1);
  if (size < 1) return [];
  return Array.from({ length: size }, (_, i) => ({
    since: new Date((from + Math.floor((to - from + 1) * i / size)) * SECOND).toISOString(),
    until: new Date((from + Math.floor((to - from + 1) * (i + 1) / size) - 1) * SECOND).toISOString(),
  })).reverse();
}

function intersects(window: SourceWindow, newer: string | undefined): SourceWindow | undefined {
  const since = newer && newer >= window.since ? new Date(Date.parse(newer) + 1).toISOString() : window.since;
  const from = Math.ceil(Date.parse(since) / SECOND) * SECOND;
  return from <= Date.parse(window.until) ? { since: new Date(from).toISOString(), until: window.until } : undefined;
}

function clientFor(plan: Pick<HarvestOptions, "source">, deps: HarvestDeps): NonNullable<HarvestDeps["client"]> | undefined {
  const client = deps.client;
  if (!client || client.anonymous || plan.source.host !== "github.com") return undefined;
  if (client.repo.host !== plan.source.host || client.repo.slug.toLowerCase() !== plan.source.slug.toLowerCase()) throw new SourceError("unavailable");
  return client;
}

function countedClient(client: NonNullable<HarvestDeps["client"]>, run: NonNullable<HarvestCursor["run"]>,
  available: () => boolean, gaps: Gaps): NonNullable<HarvestDeps["client"]> {
  return {
    repo: client.repo,
    anonymous: client.anonymous,
    async get(path, optional) {
      if (!available()) {
        gaps.messages.add(FORGE_BUDGET_GAP);
        return undefined;
      }
      run.requests++;
      return client.get(path, optional);
    },
    async graphql(query, variables) {
      if (!available()) throw new SourceError("unavailable");
      run.requests++;
      return client.graphql(query, variables);
    },
  };
}

async function openTree(options: HarvestOptions, deps: HarvestDeps): Promise<PinnedTree> {
  if (deps.tree?.root === options.checkout && deps.tree.head === options.head) return deps.tree;
  const tree = await PinnedTree.open(options.checkout, options.head);
  if (!tree) throw new Error("Learning could not read the pinned repository tree.");
  return tree;
}

/** Inventory is measured at the pinned tree and forge. The token quote is a forecast. */
export async function planHarvest(options: HarvestOptions, deps: HarvestDeps = {}, cursor?: HarvestCursor): Promise<HarvestPlan> {
  if (!Number.isFinite(Date.parse(options.since)) || !Number.isFinite(Date.parse(options.until)) || Date.parse(options.since) > Date.parse(options.until)
    || repository(options.source.host, options.source.slug)?.slug !== options.source.slug
    || safeRaw(options.source.slug) !== options.source.slug
    || options.defaultHead !== undefined && !oid.test(options.defaultHead)) throw new Error("Invalid learning harvest window or repository.");
  const budget = options.budget ?? DEFAULT_HARVEST_BUDGET;
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("Invalid learning token budget.");
  const requestBudget = options.requestBudget ?? DEFAULT_REQUEST_BUDGET;
  if (!Number.isSafeInteger(requestBudget) || requestBudget < 0) throw new Error("Invalid learning request budget.");
  const normalized = { ...options, since: new Date(options.since).toISOString(), until: new Date(options.until).toISOString() };
  const mode = options.mode ?? "backfill";
  const prior = cursor?.[mode];
  const sameWindow = prior && matchesWindow(prior, normalized);
  const gaps = new Gaps(), client = clientFor(options, deps);
  if (!client) gaps.messages.add("Review history requires an authenticated GitHub source.");
  else if (requestBudget === 0) gaps.messages.add(FORGE_BUDGET_GAP);
  const tree = await openTree(options, deps);
  const remote = !options.defaultHead && (await command(options.checkout, "git", ["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"]))?.trim();
  const defaultHead = options.defaultHead ?? (remote && oid.test(remote) ? remote : options.head);
  const sources: ForgeSource[] = options.issues ? ["merged", "closed", "issue"] : ["merged", "closed"];
  const requests = client && requestBudget > 0 ? sources.flatMap(source => bands(normalized).flatMap(window => {
    const boundary = sameWindow ? prior.boundary[source] : cursor?.sources[source]?.[mode === "weekly" ? "newest" : "oldest"];
    const clipped = intersects(window, mode === "weekly" ? boundary?.at : undefined);
    if (clipped && mode === "backfill" && boundary && boundary.at < clipped.until) clipped.until = boundary.at;
    if (clipped && clipped.since > clipped.until) return [];
    return clipped ? [{ source, page: { window: clipped } }] : [];
  })) : [];
  // Use two independent reads. A large repo must not turn the inventory
  // into an unbounded sequence of provider or git calls.
  const [counts, local] = await Promise.all([
    client ? search(client, requests, true) : [],
    localInventory(normalized, defaultHead, tree, gaps),
  ]);
  const inventory = { ...local, bands: requests.map(({ source, page }, i) => ({ ...page.window, source, count: counts[i]!.count })) };
  const count = (source: ForgeSource) => {
    const found = inventory.bands.filter(band => band.source === source).reduce((sum, band) => sum + band.count, 0);
    if (sameWindow) return Math.max(0, found - (prior.completed[source] ?? 0));
    const carriesWork = prior && containsWindow(normalized, prior.window)
      && (prior.lanes.some(lane => lane.source === source && (lane.ready.length || lane.remaining.length))
        || prior.partial.some(item => item.source === source));
    return found + (carriesWork && prior ? Math.max(0, (prior.totals[source] ?? 0) - (prior.completed[source] ?? 0)) : 0);
  };
  const localCount = (source: keyof typeof local.local) => {
    if (sameWindow) return prior.lanes.filter(lane => lane.source === source).reduce((sum, lane) => sum + lane.ready.length, 0)
      + prior.partial.filter(item => item.source === source).length;
    return local.local[source].filter(point =>
      mode !== "weekly" || !cursor?.sources[source] || point.at > cursor.sources[source]!.newest.at).length;
  };
  const projected = estimateHarvest(forecastCounts({ merged: count("merged"), closed: count("closed"), issue: options.issues ? count("issue") : 0,
    revert: localCount("revert"), cause: localCount("cause"), adr: localCount("adr"), doc: localCount("doc") }), options.agent).total;
  const estimate = Math.min(projected, budget);
  return { ...normalized, id: randomUUID(), mode, budget, requestBudget, defaultHead, inventory, gaps: gaps.list(), estimate, ceiling: quoteCeiling(estimate) };
}

function scanFor(plan: HarvestPlan, cursor: HarvestCursor): HarvestScan {
  const old = cursor[plan.mode];
  const sameWindow = old && matchesWindow(old, plan);
  if (old && !sameWindow && containsWindow(plan, old.window) && scanHasWork(old, plan)) return old;
  if (sameWindow && (!plan.issues || old.lanes.some(lane => lane.source === "issue"))) return old;
  const boundary = Object.fromEntries(Object.entries(cursor.sources).map(([source, range]) => [
    source, range[plan.mode === "weekly" ? "newest" : "oldest"],
  ]));
  const forge: HarvestLane[] = [];
  const totals: HarvestScan["totals"] = {};
  for (const { source, count, ...window } of plan.inventory.bands) {
    if (sameWindow && source !== "issue") continue;
    const boundary = cursor.sources[source];
    const clipped = intersects(window, plan.mode === "weekly" ? boundary?.newest.at : undefined);
    if (!clipped || !count) continue;
    // On a new backfill window keep the boundary second so ties can be ordered by ID.
    if (plan.mode === "backfill" && boundary && boundary.oldest.at < clipped.until) clipped.until = boundary.oldest.at;
    if (clipped.since <= clipped.until) {
      forge.push({ source, remaining: [{ window: clipped }], ready: [] });
      totals[source] = (totals[source] ?? 0) + count;
    }
  }
  if (sameWindow) {
    old.lanes.push(...forge);
    Object.assign(old.totals, totals);
    return old;
  }
  const local: HarvestLane[] = localSources.map(source => {
    const boundary = cursor.sources[source];
    const ready = plan.inventory.local[source].filter(point => !boundary ||
      (plan.mode === "weekly" ? point.at > boundary.newest.at : byPoint(point, boundary.oldest) < 0)).sort((a, b) => byPoint(b, a));
    return { source, ready, remaining: [] };
  });
  // Round-robin time bands while making room for local evidence in each batch.
  const lanes = [...forge.filter(lane => lane.source === "merged"), ...local, ...forge.filter(lane => lane.source !== "merged")];
  return { window: { since: plan.since, until: plan.until }, head: plan.head, lanes, next: 0, partial: [], boundary, completed: {}, totals };
}

function matchesWindow(scan: HarvestScan, window: SourceWindow): boolean {
  return scan.window.since === window.since && scan.window.until === window.until;
}

function containsWindow(outer: SourceWindow, inner: SourceWindow): boolean {
  return outer.since <= inner.since && outer.until >= inner.until;
}

function active(scan: HarvestScan, plan: HarvestPlan): HarvestLane[] {
  const lanes = scan.lanes.filter(lane => lane.ready.length || lane.remaining.length);
  const primary = lanes.filter(lane => lane.source !== "issue");
  return primary.length || scan.partial.some(item => item.source !== "issue") ? primary
    : plan.issues ? lanes : [];
}

function scanHasWork(scan: HarvestScan, plan: HarvestPlan): boolean {
  return active(scan, plan).length > 0 || scan.partial.some(item => item.source !== "issue" || plan.issues);
}

function divide(page: SearchPage): SearchPage[] | undefined {
  if (page.after) return undefined;
  const lo = Date.parse(page.window.since), hi = Date.parse(page.window.until);
  if (hi <= lo) return undefined;
  const middle = lo + Math.floor((hi - lo) / (SECOND * 2)) * SECOND;
  return [
    { window: { since: new Date(middle + SECOND).toISOString(), until: page.window.until } },
    { window: { since: page.window.since, until: new Date(middle).toISOString() } },
  ];
}

async function fill(plan: HarvestPlan, cursor: HarvestCursor, scan: HarvestScan, client: ReturnType<typeof clientFor>, gaps: Gaps,
  describe: boolean): Promise<void> {
  const pending = active(scan, plan).filter((lane): lane is HarvestLane & { source: ForgeSource } =>
    forgeSource(lane.source) && !lane.ready.length && lane.remaining.length > 0).slice(0, SEARCHES_PER_BATCH);
  if (!client) {
    if (pending.length) throw new SourceError("login");
    return;
  }
  const replies = await search(client, pending.map(lane => ({ source: lane.source, page: lane.remaining[0]! })), false, describe);
  for (const [i, lane] of pending.entries()) {
    const page = lane.remaining.shift()!;
    const { points, next, count } = replies[i]!;
    // GitHub Search does not sort by close or merge time. Split crowded
    // windows before consuming the first page, preserving newest-first order.
    const halves = next && divide(page);
    if (halves) { lane.remaining.unshift(...halves); continue; }
    if (next) {
      lane.remaining.unshift({ ...page, after: next });
      if (count > 1000) gaps.messages.add("GitHub search can expose at most 1,000 changes at the same timestamp.");
    }
    const initial = scan.boundary[lane.source];
    const other = plan.mode === "weekly" ? cursor.backfill : cursor.weekly;
    const excluded = new Set(other?.partial.filter(item => item.source === lane.source).map(item => item.point.id));
    const found = [...new Map(points.map(point => [point.id, point])).values()]
      .filter(point => !excluded.has(point.id) && (!initial ||
        (plan.mode === "weekly" ? point.at > initial.at : byPoint(point, initial) < 0)))
      .sort((a, b) => byPoint(b, a));
    for (const { silent, ...point } of found) {
      if (!silent) { lane.ready.push(point); continue; }
      // Nothing to read in it, so it costs no request.
      finished(cursor, lane.source, point);
      scan.completed[lane.source] = (scan.completed[lane.source] ?? 0) + 1;
    }
  }
}

function take(scan: HarvestScan, plan: HarvestPlan): HarvestScan["partial"] {
  const partial = scan.partial.filter(item => item.source !== "issue" || plan.issues);
  if (partial.length) return partial;
  const allowed = new Set(active(scan, plan));
  let forge = 0, local = 0;
  const work: HarvestScan["partial"] = [];
  for (let steps = 0; steps < scan.lanes.length && (forge < FORGE_PER_BATCH || local < LOCAL_PER_BATCH); steps++) {
    const index = (scan.next + steps) % scan.lanes.length;
    const lane = scan.lanes[index]!;
    if (!allowed.has(lane) || !lane.ready.length) continue;
    if (forgeSource(lane.source)) {
      if (forge >= FORGE_PER_BATCH) continue;
      forge++;
    } else {
      if (local >= LOCAL_PER_BATCH) continue;
      local++;
    }
    work.push({ source: lane.source, point: lane.ready.shift()!, emitted: [] });
  }
  if (scan.lanes.length) scan.next = (scan.next + 1) % scan.lanes.length;
  scan.partial.push(...work);
  return work;
}

function finished(cursor: HarvestCursor, source: HarvestSource, point: HarvestPoint): void {
  const prior = cursor.sources[source];
  cursor.sources[source] = {
    oldest: !prior || byPoint(point, prior.oldest) < 0 ? point : prior.oldest,
    newest: !prior || byPoint(point, prior.newest) > 0 ? point : prior.newest,
  };
}

const itemKey = (item: HarvestScan["partial"][number]) => item.source + ":" + item.point.id;

export async function harvestBatch(plan: HarvestPlan, cursor: HarvestCursor | undefined, deps: HarvestDeps = {}): Promise<HarvestBatch> {
  const next: HarvestCursor = structuredClone(cursor ?? { sources: {} });
  // All search totals come from a single inventory request.
  const run: HarvestRun = next.run?.id === plan.id ? next.run : {
    id: plan.id, evidence: emptyHarvestEvidence, documentEvidence: emptyHarvestEvidence, descriptionEvidence: emptyHarvestEvidence, requests: Number(plan.inventory.bands.length > 0),
  };
  next.run = run;
  const already = projectHarvestSpend(run.evidence, plan.agent);
  const scan = next[plan.mode] = scanFor(plan, next);
  const hasReviewHistory = plan.inventory.bands.some(band => band.count > 0 && (band.source === "merged" || band.source === "closed"))
    || (scan.totals.merged ?? 0) > 0 || (scan.totals.closed ?? 0) > 0;
  const documentLimit = hasReviewHistory ? Math.floor(plan.budget / 4) : undefined;
  // An older checkpoint has no source breakdown, so reserve its prior spend.
  let documentEvidence = run.documentEvidence ??= run.evidence;
  const canFitDocument = (evidence: HarvestEvidenceSize) =>
    documentLimit === undefined || projectHarvestSpend(evidence, plan.agent) <= documentLimit;
  const canReadDocs = canFitDocument(addHarvestEvidence(documentEvidence, { text: "" }));
  // A description was written by the change's own author and reviewed by nobody, so it can't crowd out the reviews.
  let descriptionEvidence = run.descriptionEvidence ??= run.evidence;
  const canFitDescription = (evidence: HarvestEvidenceSize) => projectHarvestSpend(evidence, plan.agent) <= plan.budget / 4;
  const descriptions = { decisions: 0, plain: 0 };
  const gaps = new Gaps();
  if (already === 0) for (const gap of plan.gaps) gaps.messages.add(gap);
  const candidates: Candidate[] = [];
  let spent = already;
  let budgetStopped = false;
  const result = (): HarvestBatch => ({ candidates: candidates.sort(rankCandidates), cursor: next,
    spentEstimate: spent - already, gaps: gaps.list(), descriptions, done: budgetStopped || !scanHasWork(scan, plan) && matchesWindow(scan, plan) });
  const minimumNext = projectHarvestSpend(addHarvestEvidence(run.evidence, { text: "" }), plan.agent);
  if (scanHasWork(scan, plan) && minimumNext > plan.budget) {
    gaps.messages.add("Learning reached its estimated token budget.");
    budgetStopped = true;
    return result();
  }
  const available = () => run.requests < plan.requestBudget;
  const rawClient = clientFor(plan, deps);
  const client = rawClient && countedClient(rawClient, run, available, gaps);
  if (client && !available() && (active(scan, plan).some(lane => forgeSource(lane.source))
    || scan.partial.some(item => forgeSource(item.source) && (item.source !== "issue" || plan.issues)))) {
    gaps.messages.add(FORGE_BUDGET_GAP);
    budgetStopped = true;
    return result();
  }
  if (!scan.partial.some(item => item.source !== "issue" || plan.issues)) await fill(plan, next, scan, client, gaps,
    canFitDescription(addHarvestEvidence(descriptionEvidence, { text: "" })));
  const work = take(scan, plan);
  if (!work.length) return result();
  const forge = work.filter((item): item is typeof item & ForgeItem => forgeSource(item.source));
  if (forge.length && !client) throw new SourceError("login");
  if (forge.length && !available()) {
    gaps.messages.add(FORGE_BUDGET_GAP);
    budgetStopped = true;
    return result();
  }
  const tree = await openTree(plan, deps);
  const docTree = scan.head !== tree.head && canReadDocs && work.some(item => documentSource(item.source))
    ? await openTree({ ...plan, head: scan.head }, deps) : tree;
  const read = client ? new ReviewRead(client, gaps, run.access ??= {}) : undefined;
  const reviewers = read?.reviewers ?? new Reviewers();
  const reader = new RegionReader(tree.root, client && reviewedFiles(client, available, gaps));
  const changesByPull = client ? await changes(client, forge, gaps, available) : [];
  const familiarity = changesByPull.some(change => change.threads.length)
    ? await Familiarity.open(plan.source.slug, tree, next.familiarity ??= {}, deps.teams) : undefined;
  const reverts = new Map<string, Awaited<ReturnType<typeof readRevert>>>();
  for (const item of work) if (item.source === "revert") reverts.set(item.point.id, await readRevert(plan, item.point));
  const relatedPulls = [...new Set([...reverts.values()].flatMap(revert => revert && !revert.reason ? revert.reasonPulls : []))];
  if (client && relatedPulls.length && !available()) gaps.messages.add(FORGE_BUDGET_GAP);
  const related = client && available() ? await revertDiscussion(client, relatedPulls, gaps) : new Map();
  const threads = new Map<string, Awaited<ReturnType<typeof readyThreads>>>();
  if (read) {
    observeAuthors(read, changesByPull, related);
    if (familiarity) for (const change of changesByPull) {
      threads.set(itemKey({ ...change.item, emitted: [] }), await readyThreads(change, read, familiarity));
    }
  }
  const template = changesByPull.length ? await templateLines(tree) : new Set<string>();
  const byItem = new Map(changesByPull.map(change => [change.item, change]));
  const foundByItem = new Map<typeof work[number], Candidate[]>();
  for (const item of work) {
    if (!canReadDocs && documentSource(item.source)) {
      gaps.messages.add(DOCUMENT_BUDGET_GAP);
      foundByItem.set(item, []);
      continue;
    }
    const change = byItem.get(item as ForgeItem);
    const revert = reverts.get(item.point.id);
    let discussion;
    if (revert && !revert.reason && read) for (const pull of revert.reasonPulls) {
      const pr = related.get(pull);
      const comments = pr && await read.comments(discussions(pr), revert.record.at);
      if (comments?.length) { discussion = read.discussion(comments); break; }
    }
    const found = change && read ? await changeCandidates(plan, change, threads.get(itemKey(item)) ?? [], read, familiarity, reader, deps, gaps,
        template, item.emitted.length ? undefined : descriptions)
      : await localCandidates(plan, item.source, item.point, docTree, reader, gaps, reviewers, revert, discussion);
    foundByItem.set(item, found);
  }
  if (reader.limitReached) gaps.messages.add("Some code regions exceeded the local read limit.");
  const ranked = [...foundByItem].flatMap(([item, found]) =>
    found.filter(candidate => !item.emitted.includes(candidate.id)).map(candidate => ({ item, candidate })))
    .sort((a, b) => rankCandidates(a.candidate, b.candidate));
  const skipped = new Set<Candidate>();
  for (const { item, candidate } of ranked) {
    if (item.emitted.includes(candidate.id)) continue;
    const projectedDocuments = documentSource(candidate.kind) ? addHarvestEvidence(documentEvidence, candidate) : undefined;
    if (projectedDocuments && !canFitDocument(projectedDocuments)) {
      gaps.messages.add(DOCUMENT_BUDGET_GAP);
      skipped.add(candidate);
      continue;
    }
    const projectedDescriptions = candidate.kind === "pr-text" ? addHarvestEvidence(descriptionEvidence, candidate) : undefined;
    if (projectedDescriptions && !canFitDescription(projectedDescriptions)) {
      gaps.messages.add(DESCRIPTION_BUDGET_GAP);
      skipped.add(candidate);
      continue;
    }
    const evidence = addHarvestEvidence(run.evidence, candidate);
    const estimate = projectHarvestSpend(evidence, plan.agent);
    if (estimate > plan.budget) {
      gaps.messages.add("Learning reached its estimated token budget.");
      if (projectedDocuments && documentLimit !== undefined) {
        skipped.add(candidate);
        continue;
      }
      budgetStopped = true;
      break;
    }
    run.evidence = evidence;
    if (projectedDocuments) documentEvidence = run.documentEvidence = projectedDocuments;
    if (projectedDescriptions) descriptionEvidence = run.descriptionEvidence = projectedDescriptions;
    spent = estimate;
    candidates.push(candidate);
    item.emitted.push(candidate.id);
  }
  for (const [item, found] of foundByItem) {
    if (found.some(candidate => !item.emitted.includes(candidate.id) && !skipped.has(candidate))) continue;
    finished(next, item.source, item.point);
    scan.completed[item.source] = (scan.completed[item.source] ?? 0) + 1;
    scan.partial = scan.partial.filter(pending => pending !== item);
  }
  return result();
}
