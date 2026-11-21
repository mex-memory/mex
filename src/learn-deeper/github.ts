import { ForgeClient, MAX_REVIEW_FILES, object, pinnedChangedPaths, positive, readChangedPaths, rows, SourceError,
  type Inventory, type Pull, type RepositoryAccess, type ReviewBatch, type ReviewRequest } from "./forge.js";
import { Reviewers } from "./reviewers.js";
import { redactReviews, repository, reviewSource, sourceBands, spreadPulls, validAt,
  type Repository, type ReviewSource, type SourceWindow } from "./source.js";

const PAGE_SIZE = 12;
const PULLS_PER_REQUEST = 4;

export async function githubRepository(client: ForgeClient): Promise<RepositoryAccess> {
  const metadata = object((await client.get(`/repos/${client.repo.slug}`))?.value);
  const original = metadata?.fork === true ? object(metadata.source) : metadata;
  const source = typeof original?.full_name === "string" && repository("github.com", original.full_name);
  if (!source || typeof original?.private !== "boolean" || typeof metadata?.private !== "boolean") throw new SourceError("unavailable");
  return { source, visibility: metadata.private || original.private ? "private" : "public" };
}

export async function githubInventory(client: ForgeClient, window: SourceWindow, limit: number): Promise<Inventory> {
  const access = await githubRepository(client);
  const bands = sourceBands(window);
  const perBand = Math.ceil(limit / bands.length);
  const terms = bands.map(band => `repo:${access.source.slug} is:pr is:merged merged:${band.since.slice(0, 10)}..${band.until.slice(0, 10)}`);
  const groups: Pull[][] = [];
  let more = false;
  const remember = (result: Record<string, unknown>, band: SourceWindow, graph: boolean) => {
    const list = rows(graph ? result.nodes : result.items);
    const total = graph ? result.issueCount : result.total_count;
    if ((typeof total === "number" && total > list.length) || result.incomplete_results === true) more = true;
    groups.push(list.flatMap(row => {
      const at = graph ? row.mergedAt : row.closed_at;
      return positive(row.number) && typeof at === "string" && validAt(at, band.since, band.until) ? [{ number: row.number, at }] : [];
    }));
  };
  if (!client.anonymous) {
    const args = terms.map((_, i) => `$q${i}:String!`).join(",");
    const fields = terms.map((_, i) => `b${i}:search(type:ISSUE,query:$q${i},first:${perBand}){issueCount nodes{... on PullRequest{number mergedAt}}}`).join(" ");
    const data = await client.graphql(`query LearningInventory(${args}){${fields}}`, Object.fromEntries(terms.map((term, i) => [`q${i}`, term])));
    bands.forEach((band, i) => remember(object(data[`b${i}`]) ?? {}, band, true));
  } else {
    for (const [i, band] of bands.entries()) {
      const result = (await client.get(`/search/issues?${new URLSearchParams({ q: terms[i], per_page: String(perBand), sort: "updated", order: "desc" })}`))!;
      remember(object(result.value) ?? {}, band, false);
    }
  }
  return { ...access, anonymous: client.anonymous, more, pulls: spreadPulls(groups, limit) };
}

interface Comment {
  id: string; marker: string; body: unknown; at: unknown; login: unknown; name?: unknown; human: boolean;
  writer?: boolean; association?: unknown; path?: string; topLevel: boolean; outdated: boolean;
}
interface ChangeEvidence { comments: Comment[]; changedPaths: string[]; }

// Membership and collaborator status can include read-only access. Treat them as
// fallback evidence only when GitHub cannot answer the permission check, never
// over an explicit lack of write access.
function associatedWriter(association: unknown): true | undefined {
  return association === "MEMBER" || association === "OWNER" || association === "COLLABORATOR" ? true : undefined;
}

function collectGraphComments(value: unknown, pull: Pull, request: ReviewRequest, gaps: Set<string>): ChangeEvidence {
  const pr = object(value);
  if (!pr || pr.number !== pull.number || typeof pr.mergedAt !== "string" || !validAt(pr.mergedAt, request.since, request.until)) {
    gaps.add("Some merged changes were no longer readable."); return { comments: [], changedPaths: [] };
  }
  const comments: Comment[] = [];
  const connection = (value: unknown) => {
    const data = object(value);
    if (!data) { gaps.add("Some review data was unavailable."); return []; }
    if (object(data.pageInfo)?.hasNextPage === true) gaps.add("Some review threads exceeded the page limit.");
    return rows(data.nodes);
  };
  const add = (node: Record<string, unknown>, marker: string, topLevel: boolean, path?: string, outdated = false) => {
    const actor = object(node.author);
    const databaseId = node.fullDatabaseId;
    const id = positive(databaseId) ? String(databaseId) : typeof databaseId === "string" && /^\d{1,22}$/u.test(databaseId) ? databaseId : undefined;
    if (!id || node.isCopilotCodeReview === true || node.isMinimized === true) return;
    comments.push({ id, marker, body: node.body, at: node.submittedAt ?? node.createdAt, login: actor?.login,
      name: actor?.name, human: actor?.__typename === "User", writer: typeof node.authorCanPushToRepository === "boolean"
        ? node.authorCanPushToRepository : undefined, association: node.authorAssociation, topLevel, ...(path ? { path } : {}), outdated });
  };
  add(pr, "description", true);
  for (const item of connection(pr.reviews)) add(item, "pullrequestreview-", true);
  for (const item of connection(pr.comments)) add(item, "issuecomment-", true);
  for (const thread of connection(pr.reviewThreads)) {
    if (typeof thread.path !== "string" || !request.tree.has(thread.path)) continue;
    for (const item of connection(thread.comments)) add(item, "discussion_r", false, thread.path, thread.isOutdated === true);
  }
  return { comments, changedPaths: pinnedChangedPaths(object(pr.files)?.nodes, "path", request.tree) };
}

async function graphComments(client: ForgeClient, request: ReviewRequest, gaps: Set<string>): Promise<ChangeEvidence[]> {
  if (!request.pulls.length) return [];
  const [owner, name] = request.source.slug.split("/");
  const actor = "author{__typename login ... on User{name}}";
  const common = `fullDatabaseId body createdAt authorAssociation ${actor}`;
  const page = "pageInfo{hasNextPage}";
  const groups: ChangeEvidence[] = [];
  // Keep the same bounded response per request when a model batch spans more PRs.
  for (let offset = 0; offset < request.pulls.length; offset += PULLS_PER_REQUEST) {
    const pulls = request.pulls.slice(offset, offset + PULLS_PER_REQUEST);
    const fields = pulls.map((pull, i) => `p${i}:pullRequest(number:${pull.number}){number mergedAt ${common}
    files(first:${MAX_REVIEW_FILES}){nodes{path}}
    reviews(first:${PAGE_SIZE},states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){${page} nodes{${common} submittedAt authorCanPushToRepository isMinimized isCopilotCodeReview}}
    comments(first:${PAGE_SIZE}){${page} nodes{${common} isMinimized}}
    reviewThreads(first:${PAGE_SIZE}){${page} nodes{path isOutdated comments(first:4){${page} nodes{${common} isMinimized isCopilotCodeReview}}}}}`).join(" ");
    const data = object((await client.graphql(`query LearningReviews($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`, { owner, name })).repository);
    if (!data) throw new SourceError("unavailable");
    groups.push(...pulls.map((pull, i) => collectGraphComments(data[`p${i}`], pull, request, gaps)));
  }
  return groups;
}

async function restComments(client: ForgeClient, request: ReviewRequest, gaps: Set<string>): Promise<ChangeEvidence[]> {
  const prefix = `/repos/${request.source.slug}`;
  const groups: ChangeEvidence[] = [];
  for (const pull of request.pulls) {
    const pr = object((await client.get(`${prefix}/pulls/${pull.number}`, true))?.value);
    if (!pr || typeof pr.merged_at !== "string" || !validAt(pr.merged_at, request.since, request.until)) {
      gaps.add("Some merged changes were no longer readable."); groups.push({ comments: [], changedPaths: [] }); continue;
    }
    const comments: Comment[] = [];
    const add = (entry: Record<string, unknown>, marker: string, topLevel: boolean, path?: string, outdated = false) => {
      const user = object(entry.user);
      if (!positive(entry.id) || entry.is_copilot_code_review === true) return;
      comments.push({ id: String(entry.id), marker, body: entry.body, at: entry.submitted_at ?? entry.created_at,
        login: user?.login, name: user?.name, human: user?.type === "User", association: entry.author_association,
        topLevel, ...(path ? { path } : {}), outdated });
    };
    add(pr, "description", true);
    for (const [path, marker, inline] of [[`pulls/${pull.number}/reviews`, "pullrequestreview-", false],
      [`pulls/${pull.number}/comments`, "discussion_r", true], [`issues/${pull.number}/comments`, "issuecomment-", false]] as const) {
      const page = (await client.get(`${prefix}/${path}?per_page=${PAGE_SIZE}`))!;
      if (page.more) gaps.add("Some review threads exceeded the page limit.");
      for (const entry of rows(page.value)) {
        const file = typeof entry.path === "string" ? entry.path : undefined;
        if (inline && (!file || !request.tree.has(file))) continue;
        add(entry, marker, !inline, file, inline && (entry.position === null || entry.line === null));
      }
    }
    const changedPaths = positive(pr.changed_files) && comments.some(comment => comment.human && associatedWriter(comment.association))
      ? await readChangedPaths(client, `${prefix}/pulls/${pull.number}/files`, "filename", request.tree) : [];
    groups.push({ comments, changedPaths });
  }
  return groups;
}

function pullLink(source: Repository, pull: number, comment: Comment): string {
  return `https://github.com/${source.slug}/pull/${pull}${comment.marker === "description" ? "" : `#${comment.marker}${comment.id}`}`;
}

export async function githubReviews(client: ForgeClient, request: ReviewRequest): Promise<ReviewBatch> {
  const reviewers = new Reviewers(), gaps = new Set<string>(), reviews: ReviewSource[] = [];
  const permissions = new Map<string, boolean | null | undefined>();
  const groups = client.anonymous ? await restComments(client, request, gaps) : await graphComments(client, request, gaps);
  for (const { comments } of groups) for (const comment of comments) {
    if (typeof comment.login !== "string") continue;
    reviewers.add(comment.login, comment.name);
    if (comment.human && comment.writer !== undefined && permissions.get(comment.login) !== false) permissions.set(comment.login, comment.writer);
  }
  let checked = 0;
  const permissionLimit = PAGE_SIZE * Math.ceil(request.pulls.length / PULLS_PER_REQUEST);
  for (const [index, { comments, changedPaths }] of groups.entries()) {
    const pull = request.pulls[index].number;
    for (const comment of comments) {
      if (typeof comment.login !== "string" || !comment.human || /\[bot\]$/iu.test(comment.login)
        || typeof comment.body !== "string" || typeof comment.at !== "string" || !validAt(comment.at, request.since, request.until)) continue;
      const candidate = reviewSource(comment.body, { id: `github:${comment.marker}:${comment.id}`, link: pullLink(request.source, pull, comment),
        at: comment.at, pull, writer: false, topLevel: comment.topLevel, outdated: comment.outdated, ...(comment.path ? { path: comment.path } : {}) }, gaps);
      if (!candidate) continue;
      let writer = comment.writer ?? permissions.get(comment.login);
      if (writer === undefined && !client.anonymous && !permissions.has(comment.login) && checked < permissionLimit && /^[A-Za-z0-9-]{1,100}$/u.test(comment.login)) {
        checked++;
        const page = await client.get(`/repos/${request.source.slug}/collaborators/${comment.login}/permission`, true);
        const permission = object(page?.value)?.permission;
        writer = page === undefined ? null : typeof permission === "string" ? ["write", "maintain", "admin"].includes(permission) : undefined;
        permissions.set(comment.login, writer);
      }
      if (writer === null || (writer === undefined && client.anonymous)) writer = associatedWriter(comment.association);
      if (writer === undefined) gaps.add("Some review authors' write access could not be checked.");
      reviews.push({ ...candidate, writer: writer === true, ...(writer && changedPaths.length ? { changedPaths } : {}) });
    }
  }
  return { reviews: redactReviews(reviews, reviewers, gaps, request.preferred, request.preferDistinctPulls), reviewers, gaps: [...gaps] };
}
