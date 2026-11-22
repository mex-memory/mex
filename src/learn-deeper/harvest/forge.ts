import { object, positive, rows, SourceError } from "../forge.js";
import { Reviewers } from "../reviewers.js";
import { repository, sourceDigest, validAt, type SourceWindow } from "../source.js";
import { cleanText, newCandidate, PR_BYTES, reviewerKey, safePath, safeRaw, type Gaps } from "./evidence.js";
import type { Familiarity } from "./familiarity.js";
import { MAX_BLOB, oid, reviewRegions, type ReadReviewedFile, type RegionReader } from "./regions.js";
import type { Candidate, ForgeSource, HarvestDeps, HarvestPlan, HarvestPoint, SearchPage } from "./types.js";

const THREAD_PAGE = 12;
const COMMENT_PAGE = 12;
const REPLIES = 4;
const FILE_PAGE = 24;
const SEARCH_PAGE = 32;
const MAX_PERMISSION_READS = 12;
// Share these reads across all threads in a batch. Allow a few missing fork
// objects without turning a busy review into a long chain of requests.
const MAX_REVIEWED_FILE_REQUESTS = 8;
const actor = "author{__typename login ... on User{name}}";
const common = `id fullDatabaseId body createdAt isMinimized ${actor}`;
const discussionFields = `comments(last:${COMMENT_PAGE}){pageInfo{hasPreviousPage} nodes{${common}}}
reviews(last:${COMMENT_PAGE},states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){
  pageInfo{hasPreviousPage} nodes{${common} submittedAt authorCanPushToRepository isCopilotCodeReview}
}`;
const threadFields = `id path isResolved isOutdated line originalLine startLine originalStartLine diffSide startDiffSide
comments(first:${REPLIES}){totalCount pageInfo{hasNextPage} nodes{
  ${common} diffHunk originalLine originalStartLine originalCommit{oid} commit{oid} isCopilotCodeReview
  pullRequestReview{authorCanPushToRepository author{login}}
}}`;
const closureFields = `labels(first:30){pageInfo{hasNextPage} nodes{name}}
timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{createdAt actor{__typename login ... on User{name}}}}}`;
const inactivity = /\b(?:stale|inactiv(?:e|ity)|no (?:recent )?activity)\b/iu;
const rootCause = /\b(?:root cause|regression (?:from|in|since)|caused by|broken by)\b/iu;
const notPlanned = /\b(?:not[ -]planned|won['’]?t[ -]fix|will not fix)\b/iu;
const loginPattern = /^(?:[A-Za-z0-9_-]{1,100}|[A-Za-z0-9_-]{1,100}\[bot\])$/u;
const nodePattern = /^[A-Za-z0-9_+=/-]{1,200}$/u;
type Client = NonNullable<HarvestDeps["client"]>;
type Raw = Record<string, unknown>;
export type ForgeItem = { source: ForgeSource; point: HarvestPoint };

function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function timestamp(value: unknown): string | undefined {
  const text = string(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}T/u.test(text) || !Number.isFinite(Date.parse(text))) return undefined;
  return new Date(text).toISOString();
}
const nodeId = (value: unknown) => typeof value === "string" && nodePattern.test(value) ? value : undefined;
const gitId = (value: unknown) => typeof value === "string" && oid.test(value) ? value : undefined;
const databaseId = (value: unknown) => positive(value) ? String(value)
  : typeof value === "string" && /^[1-9]\d{0,21}$/u.test(value) ? value : undefined;

interface Person { login: string; human: boolean; }
function person(value: unknown, reviewers?: Reviewers): Person | undefined {
  const user = object(value), login = string(user?.login);
  if (!login || !loginPattern.test(login)) return undefined;
  reviewers?.add(login, user?.name);
  return { login: login.toLowerCase(), human: user?.__typename === "User" && !/\[bot\]$|^copilot(?:-code-review)?$/iu.test(login) };
}

interface Connection { nodes: Raw[]; more: boolean; end?: string; total?: number; }
function connection(value: unknown): Connection {
  const body = object(value), page = object(body?.pageInfo), count = body?.totalCount;
  return { nodes: body?.nodes == null ? [] : rows(body.nodes), more: page?.hasNextPage === true || page?.hasPreviousPage === true,
    end: string(page?.endCursor), total: typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined };
}

function contentsText(value: unknown, path: string): string | undefined {
  const file = object(value);
  const size = file?.size;
  if (file?.type !== "file" || file.path !== path || file.encoding !== "base64"
    || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB
    || typeof file.content !== "string") return undefined;
  const encoded = file.content.replace(/[\r\n]/gu, "");
  if (encoded.length !== Math.ceil(size / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== size || bytes.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return undefined; }
}

export function reviewedFiles(client: Client, canRequest: () => boolean, gaps: Gaps): ReadReviewedFile {
  const cache = new Map<string, Promise<string | undefined>>();
  let requests = 0, unavailable = false;

  async function read(commit: string, path: string, headRepo?: string): Promise<string | undefined> {
    if (unavailable) return undefined;
    const fork = headRepo && repository("github.com", headRepo);
    const repos = [client.repo.slug];
    if (fork && fork.slug.toLowerCase() !== client.repo.slug.toLowerCase() && safeRaw(fork.slug) === fork.slug) repos.unshift(fork.slug);
    for (const repo of repos) {
      if (!canRequest() || requests >= MAX_REVIEWED_FILE_REQUESTS) {
        gaps.messages.add("Some reviewed files exceeded the forge request budget.");
        return undefined;
      }
      requests++;
      const file = path.split("/").map(segment => encodeURIComponent(segment)).join("/");
      try {
        const reply = await client.get(`/repos/${repo}/contents/${file}?ref=${commit}`, true);
        const text = contentsText(reply?.value, path);
        if (text !== undefined) return text;
      } catch (error) {
        if (!(error instanceof SourceError)) throw error;
        unavailable = error.problem === "offline" || error.problem === "rate-limit";
        if (unavailable) break;
      }
    }
    gaps.messages.add("Some reviewed files could not be read from GitHub.");
    return undefined;
  }

  return (commit, path, headRepo) => {
    if (!oid.test(commit) || !safePath(path)) return Promise.resolve(undefined);
    const key = `${commit}:${path}`;
    let reply = cache.get(key);
    if (!reply) {
      reply = read(commit, path, headRepo);
      cache.set(key, reply);
    }
    return reply;
  };
}

export async function search(client: Client, requests: Array<{ source: ForgeSource; page: SearchPage }>, countsOnly = false):
Promise<Array<{ count: number; points: HarvestPoint[]; next?: string }>> {
  if (!requests.length) return [];
  const variables: Record<string, unknown> = {};
  const params: string[] = [], fields: string[] = [];
  for (const [i, { source, page }] of requests.entries()) {
    const date = source === "merged" ? "merged" : "closed";
    const kind = source === "issue" ? "is:issue is:closed" : source === "merged" ? "is:pr is:merged" : "is:pr is:closed is:unmerged";
    const boundary = (date: string) => date.replace(/\.\d{3}Z$/u, "Z");
    variables[`q${i}`] = `repo:${client.repo.slug} ${kind} ${date}:${boundary(page.window.since)}..${boundary(page.window.until)}`;
    variables[`a${i}`] = page.after ?? null;
    params.push(`$q${i}:String!,$a${i}:String`);
    const nodes = source === "issue" ? "nodes{... on Issue{number closedAt}}"
      : `nodes{... on PullRequest{number ${source === "merged" ? "mergedAt" : "closedAt"}}}`;
    fields.push(`s${i}:search(type:ISSUE,query:$q${i},first:${countsOnly ? 1 : SEARCH_PAGE},after:$a${i}){
      issueCount pageInfo{hasNextPage endCursor} ${countsOnly ? "" : nodes}}`);
  }
  const data = await client.graphql(`query HarvestSearch(${params.join(",")}){${fields.join("\n")}}`, variables);
  return requests.map(({ source, page }, i) => {
    const result = object(data[`s${i}`]), count = result?.issueCount;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new SourceError("unavailable");
    const links = connection(result);
    if (links.more && (!links.end || links.end === page.after)) throw new SourceError("unavailable");
    const points = links.nodes.flatMap(row => {
      const at = timestamp(source === "merged" ? row.mergedAt : row.closedAt);
      return positive(row.number) && at && validAt(at, page.window.since, page.window.until) ? [{ id: String(row.number), at }] : [];
    });
    return { count, points, next: links.more ? links.end : undefined };
  });
}

interface Comment { id: string; databaseId?: string; at: string; raw: string; login: string; }
export interface Discussion { raw: string; reviewers: string[]; nodeIds: string[]; commentHashes: Record<string, string>; }

function directPermission(row: Raw, login: string): boolean | undefined {
  if (typeof row.authorCanPushToRepository === "boolean") return row.authorCanPushToRepository;
  const review = object(row.pullRequestReview);
  if (string(object(review?.author)?.login)?.toLowerCase() === login && typeof review?.authorCanPushToRepository === "boolean") {
    return review.authorCanPushToRepository;
  }
}

export class ReviewRead {
  readonly reviewers = new Reviewers();
  private readonly permissions = new Map<string, boolean>();
  private permissionReads = 0;

  constructor(private readonly client: Client, private readonly gaps: Gaps) {}

  observe(row: Raw): void {
    const author = person(row.author, this.reviewers);
    const permission = author?.human ? directPermission(row, author.login) : undefined;
    if (author && permission !== undefined && this.permissions.get(author.login) !== false) this.permissions.set(author.login, permission);
  }

  private async writer(row: Raw, login: string): Promise<boolean> {
    const known = directPermission(row, login) ?? this.permissions.get(login);
    if (known !== undefined) return known;
    if (this.permissionReads >= MAX_PERMISSION_READS) {
      this.gaps.messages.add("Some author permissions exceeded the lookup limit.");
      return false;
    }
    this.permissionReads++;
    const reply = await this.client.get(`/repos/${this.client.repo.slug}/collaborators/${encodeURIComponent(login)}/permission`, true);
    const permission = string(object(reply?.value)?.permission);
    if (!permission) this.gaps.messages.add("Some authors' write access could not be verified.");
    const writer = ["write", "maintain", "admin"].includes(permission ?? "");
    this.permissions.set(login, writer);
    return writer;
  }

  async comments(rows: Raw[], start?: string): Promise<Comment[]> {
    const result: Comment[] = [];
    for (const row of rows) {
      const author = person(row.author), id = nodeId(row.id), raw = string(row.body);
      const at = timestamp(row.submittedAt ?? row.createdAt);
      if (!author?.human || !id || !raw?.trim() || !at || start && at <= start
        || row.isMinimized === true || row.isCopilotCodeReview === true) continue;
      if (safeRaw(raw) === undefined) { this.gaps.withheld(false); continue; }
      if (await this.writer(row, author.login)) result.push({ id, at, raw, login: author.login, databaseId: databaseId(row.fullDatabaseId) });
    }
    return result;
  }

  discussion(comments: Comment[]): Discussion {
    const used = [...new Map(comments.map(comment => [comment.id, comment])).values()];
    return { raw: used.map(comment => comment.raw).join("\n\n"), reviewers: [...new Set(used.map(comment => reviewerKey(this.client.repo.slug, comment.login)))],
      nodeIds: used.map(comment => comment.id), commentHashes: Object.fromEntries(used.map(comment => [comment.id, sourceDigest(comment.raw)])) };
  }
}

export interface Change { item: ForgeItem; row: Raw; threads: Raw[]; }

function addDiscussionGaps(row: Raw, gaps: Gaps): void {
  if (connection(row.comments).more || connection(row.reviews).more) gaps.messages.add("Some discussion comments or reviews exceeded the page limit.");
  if (connection(row.files).more) gaps.messages.add("Some changed paths exceeded the file page limit.");
}

export async function changes(client: Client, items: ForgeItem[], gaps: Gaps, pageMore: () => boolean): Promise<Change[]> {
  if (!items.length) return [];
  const [owner, name] = client.repo.slug.split("/");
  const fields = items.map(({ source, point }, i) => {
    const number = Number(point.id);
    if (!positive(number) || String(number) !== point.id) throw new SourceError("unavailable");
    if (source === "issue") return `p${i}:issue(number:${number}){id number title body stateReason closedAt ${actor}
      ${closureFields} comments(last:${COMMENT_PAGE}){pageInfo{hasPreviousPage} nodes{${common}}}}`;
    return `p${i}:pullRequest(number:${number}){id number title body mergedAt closedAt state mergeCommit{oid} headRefOid
      changedFiles ${actor} files(first:${FILE_PAGE}){pageInfo{hasNextPage} nodes{path}}
      ${discussionFields} ${source === "closed" ? closureFields : `headRepository{nameWithOwner} reviewThreads(first:${THREAD_PAGE}){
        totalCount pageInfo{hasNextPage endCursor} nodes{${threadFields}}}`}}`;
  });
  const data = object((await client.graphql(`query HarvestChanges($owner:String!,$name:String!){repository(owner:$owner,name:$name){
    ${fields.join("\n")}
  }}`, { owner, name })).repository);
  if (!data) throw new SourceError("unavailable");
  const extra: Array<{ index: number; number: number; after: string }> = [];
  const result = items.flatMap((item, index) => {
    const row = object(data[`p${index}`]);
    const at = timestamp(item.source === "merged" ? row?.mergedAt : row?.closedAt);
    if (!row || !positive(row.number) || String(row.number) !== item.point.id || at !== item.point.at) {
      gaps.messages.add("Some changes were no longer readable at the inventoried time.");
      return [];
    }
    addDiscussionGaps(row, gaps);
    const page = connection(row.reviewThreads);
    if (page.more && pageMore() && page.end) extra.push({ index, number: row.number, after: page.end });
    return [{ item, row, threads: page.nodes }];
  });
  if (extra.length) {
    const query = extra.map(({ index, number }) => `p${index}:pullRequest(number:${number}){
      reviewThreads(first:${THREAD_PAGE},after:$a${index}){totalCount pageInfo{hasNextPage endCursor} nodes{${threadFields}}}
    }`).join("\n");
    const args = extra.map(({ index }) => `$a${index}:String!`).join(",");
    const vars = Object.fromEntries(extra.map(({ index, after }) => [`a${index}`, after]));
    const more = object((await client.graphql(`query HarvestThreadPages($owner:String!,$name:String!,${args}){
      repository(owner:$owner,name:$name){${query}}
    }`, { owner, name, ...vars })).repository);
    if (!more) throw new SourceError("unavailable");
    for (const { index, number } of extra) {
      const change = result.find(({ item }) => item.point.id === String(number) && item.source === "merged");
      const row = object(more[`p${index}`]);
      if (!row?.reviewThreads || !change) throw new SourceError("unavailable");
      change.threads.push(...connection(row.reviewThreads).nodes);
    }
  }
  let cut = 0;
  for (const change of result) {
    const page = connection(change.row.reviewThreads);
    if (page.more) cut += Math.max(0, (page.total ?? change.threads.length + 1) - change.threads.length);
    if (change.threads.some(thread => connection(thread.comments).more)) gaps.messages.add("Some thread replies exceeded the reply limit.");
  }
  if (cut) gaps.messages.add(`The thread page limit left ${cut} review threads unread.`);
  return result;
}

export async function revertDiscussion(client: Client, pulls: number[], gaps: Gaps):
Promise<Map<number, Raw>> {
  if (!pulls.length) return new Map();
  const [owner, name] = client.repo.slug.split("/");
  const fields = pulls.map(pull => `p${pull}:pullRequest(number:${pull}){${discussionFields}}`).join("\n");
  const data = object((await client.graphql(`query HarvestRevertDiscussion($owner:String!,$name:String!){repository(owner:$owner,name:$name){
    ${fields}
  }}`, { owner, name })).repository);
  if (!data) throw new SourceError("unavailable");
  return new Map(pulls.flatMap(pull => {
    const row = object(data[`p${pull}`]);
    if (!row) return [];
    addDiscussionGaps(row, gaps);
    return [[pull, row] as const];
  }));
}

export function discussions(row: Raw): Raw[] {
  return [...connection(row.comments).nodes, ...connection(row.reviews).nodes];
}

export function observeAuthors(read: ReviewRead, items: Change[], related: ReadonlyMap<number, Raw>): void {
  for (const { row, threads } of items) {
    read.observe(row);
    for (const comment of [...discussions(row), ...threads.flatMap(thread => connection(thread.comments).nodes)]) read.observe(comment);
    for (const event of connection(row.timelineItems).nodes) person(event.actor, read.reviewers);
  }
  for (const row of related.values()) for (const comment of discussions(row)) read.observe(comment);
}

interface ReadyThread { row: Raw; root: Raw; path: string; id: string; comments: Comment[]; }
export async function readyThreads(change: Change, read: ReviewRead, familiarity: Familiarity): Promise<ReadyThread[]> {
  const ready: ReadyThread[] = [];
  for (const row of change.threads) {
    const id = nodeId(row.id), path = row.path;
    if (!id || !safePath(path)) continue;
    const nodes = connection(row.comments).nodes, root = nodes[0];
    // A human reply cannot make a bot's or a minimized root eligible.
    if (!root || !person(root.author)?.human || root.isMinimized === true || root.isCopilotCodeReview === true) continue;
    const comments = await read.comments(nodes);
    if (!comments.length || comments[0]!.id !== root.id) continue;
    for (const comment of comments) familiarity.observe(comment.login, path, Number(change.item.point.id), change.item.point.at);
    ready.push({ row, root, path, id, comments });
  }
  return ready;
}

export async function changeCandidates(plan: HarvestPlan, change: Change, threads: ReadyThread[], read: ReviewRead,
  familiarity: Familiarity | undefined, reader: RegionReader, deps: HarvestDeps, gaps: Gaps): Promise<Candidate[]> {
  const { row, item: { source, point } } = change;
  const pull = Number(point.id);
  const link = `https://github.com/${plan.source.slug}/${source === "issue" ? "issues" : "pull"}/${pull}`;
  const title = cleanText(string(row.title) ?? "", gaps, read.reviewers, 256);
  const rawDescription = string(row.body) ?? "";
  const prText = cleanText(rawDescription, gaps, read.reviewers, PR_BYTES);
  const changedPaths = [...new Set(connection(row.files).nodes.map(file => file.path).filter(safePath))];
  const smallPr = typeof row.changedFiles === "number" && Number.isSafeInteger(row.changedFiles) && row.changedFiles >= 0 && row.changedFiles < 20;
  const base = { at: point.at, title, changedPaths, ...(source === "issue" ? {} : { pull }) };
  if (source !== "merged") {
    if (source === "closed" && row.state !== "CLOSED") return [];
    const events = connection(row.timelineItems).nodes;
    const closure = events.at(-1), closer = person(closure?.actor);
    if (source === "closed" && !closer) {
      gaps.messages.add("Some closed changes had no verifiable closing actor.");
      return [];
    }
    if (closer && !closer.human) return [];
    const labels = connection(row.labels);
    if (labels.more) {
      gaps.messages.add("Some closed changes exceeded the label page limit.");
      return [];
    }
    const facts = discussions(row).sort((a, b) => (timestamp(b.submittedAt ?? b.createdAt) ?? "")
      .localeCompare(timestamp(a.submittedAt ?? a.createdAt) ?? ""));
    const distance = (value: unknown) => Date.parse(timestamp(value) ?? "") - Date.parse(point.at);
    const closing = facts.filter(fact => {
      const author = person(fact.author);
      const near = distance(fact.submittedAt ?? fact.createdAt);
      return author?.login === closer?.login && near >= -24 * 60 * 60 * 1000 && near <= 60_000;
    }).sort((a, b) => Math.abs(distance(a.submittedAt ?? a.createdAt)) - Math.abs(distance(b.submittedAt ?? b.createdAt)))[0];
    if (labels.nodes.some(label => inactivity.test(string(label.name) ?? "")) || inactivity.test(string(closing?.body) ?? "")) return [];
    const comments = await read.comments(closing ? [closing, ...facts.filter(fact => fact !== closing)] : facts);
    const followed = read.discussion(comments);
    if (source === "closed" && !comments.length) return [];
    if (source === "issue" && !(comments.length && (row.stateReason === "NOT_PLANNED" || notPlanned.test(followed.raw))
      || rootCause.test((prText ? rawDescription : "") + "\n" + followed.raw))) return [];
    const description = prText && comments.length ? "\n\n" + prText : prText ?? "";
    const text = cleanText(followed.raw + description, gaps, read.reviewers);
    if (!text) return [];
    return [newCandidate({ ...base, ...followedFields(followed), id: `gh:${source}:${pull}`, kind: source === "closed" ? "closed-pr" : "issue",
      link, hash: sourceDigest(followed.raw + (prText ? "\n\n" + rawDescription : "")), text, prText }, { smallPr })];
  }

  const candidates: Candidate[] = [];
  if (prText && person(row.author)?.human) candidates.push(newCandidate({ ...base, id: `gh:pr:${pull}`, kind: "pr-text", link,
    text: prText, prText, hash: sourceDigest(rawDescription), nodeIds: [], reviewers: [] }, { smallPr }));
  for (const thread of threads) {
    const { row: position, root, path, id, comments } = thread;
    const followed = read.discussion(comments);
    const text = cleanText(followed.raw, gaps, read.reviewers);
    if (!text) continue;
    const hunk = string(root.diffHunk);
    if (hunk && safeRaw(hunk) !== hunk) { gaps.withheld(true); continue; }
    const orig = gitId(object(root.originalCommit)?.oid);
    const original = orig ?? (position.isOutdated !== true ? gitId(object(root.commit)?.oid) ?? gitId(row.headRefOid) : undefined);
    const last = orig ? root.originalLine ?? position.originalLine ?? position.line : position.line;
    const first = orig ? root.originalStartLine ?? position.originalStartLine ?? last : position.startLine ?? last;
    const side = string(position.diffSide);
    const location = hunk && original && side && positive(first) && positive(last)
      && (position.startDiffSide == null || position.startDiffSide === side)
      ? await reviewRegions({ path, side, first, last, original, hunk, merge: gitId(object(row.mergeCommit)?.oid),
        head: plan.head, changedPaths, headRepo: string(object(row.headRepository)?.nameWithOwner) }, reader, gaps) : { actedOn: false };
    if (location.withheld) continue;
    const afterPath = location.code?.after?.path;
    const familiar = !!familiarity && comments.some(comment => familiarity.knows(comment.login, path, pull, point.at)
      || afterPath !== undefined && afterPath !== path && familiarity.knows(comment.login, afterPath, pull, point.at));
    const number = comments[0]?.databaseId;
    candidates.push(newCandidate({ ...base, ...followedFields(followed), id: `gh:thread:${id}`, kind: "review-thread",
      link: number ? `${link}#discussion_r${number}` : link, path, text, prText, hash: sourceDigest(followed.raw), code: location.code },
    { actedOn: location.actedOn, familiar, smallPr, hotUnknown: plan.inventory.hotPaths.includes(afterPath ?? path)
      && !deps.knownPaths?.has(afterPath ?? path) }));
  }
  return candidates;
}

function followedFields({ reviewers, nodeIds, commentHashes }: Discussion): Pick<Candidate, "reviewers" | "nodeIds" | "commentHashes"> {
  return { reviewers, nodeIds, commentHashes };
}
