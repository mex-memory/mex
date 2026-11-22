import { ForgeClient, object, positive, readChangedPaths, rows, SourceError,
  type Inventory, type Pull, type RepositoryAccess, type ReviewBatch, type ReviewRequest } from "./forge.js";
import { Reviewers } from "./reviewers.js";
import { redactReviews, repository, reviewSource, sourceBands, spreadPulls, validAt, type ReviewSource, type SourceWindow } from "./source.js";

const PAGE_SIZE = 12;
const projectPath = (slug: string) => `/projects/${encodeURIComponent(slug)}`;

export async function gitlabRepository(client: ForgeClient): Promise<RepositoryAccess> {
  let target = client.repo.slug;
  let privateSource = false;
  const seen = new Set<string>();
  for (let i = 0; i < 4 && !seen.has(target); i++) {
    seen.add(target);
    const project = object((await client.get(projectPath(target)))?.value);
    const source = typeof project?.path_with_namespace === "string" && repository("gitlab.com", project.path_with_namespace);
    if (!source || typeof project?.visibility !== "string" || !["public", "private", "internal"].includes(project.visibility)) throw new SourceError("unavailable");
    privateSource ||= project.visibility !== "public";
    const upstream = object(project.forked_from_project);
    if (!upstream) return { source, visibility: privateSource ? "private" : "public" };
    if (!positive(upstream.id)) throw new SourceError("unavailable");
    target = String(upstream.id);
  }
  throw new SourceError("unavailable");
}

export async function gitlabInventory(client: ForgeClient, window: SourceWindow, limit: number): Promise<Inventory> {
  const access = await gitlabRepository(client);
  const bands = sourceBands(window);
  const perBand = Math.ceil(limit / bands.length);
  const groups: Pull[][] = [];
  let more = false;
  for (const band of bands) {
    const query = new URLSearchParams({ state: "merged", scope: "all", merged_after: band.since, merged_before: band.until,
      per_page: String(perBand), order_by: "updated_at", sort: "desc" });
    const page = (await client.get(`${projectPath(access.source.slug)}/merge_requests?${query}`))!;
    more ||= page.more;
    groups.push(rows(page.value).flatMap(row => row.state === "merged" && positive(row.iid) && typeof row.merged_at === "string"
      && validAt(row.merged_at, band.since, band.until) ? [{ number: row.iid, at: row.merged_at }] : []));
  }
  return { ...access, more, anonymous: client.anonymous, pulls: spreadPulls(groups, limit) };
}

export async function gitlabReviews(client: ForgeClient, request: ReviewRequest): Promise<ReviewBatch> {
  const prefix = projectPath(request.source.slug);
  const reviewers = new Reviewers(), gaps = new Set<string>(), reviews: ReviewSource[] = [];
  const permissions = new Map<number, boolean | undefined>();
  const changed = new Map<string, boolean>();
  const { since, until, tree } = request;
  let checked = 0;
  for (const { number: pull } of request.pulls) {
    const mrPath = `${prefix}/merge_requests/${pull}`;
    const mr = object((await client.get(mrPath, true))?.value);
    if (mr?.state !== "merged" || typeof mr.merged_at !== "string" || !validAt(mr.merged_at, since, until)) {
      gaps.add("Some merged changes were no longer readable."); continue;
    }
    const page = await client.get(`${mrPath}/discussions?per_page=${PAGE_SIZE}`, client.anonymous);
    if (!page) gaps.add("Some GitLab discussions need a login.");
    if (page?.more) gaps.add("Some review threads exceeded the page limit.");
    const discussions = page ? rows(page.value).flatMap(discussion => rows(discussion.notes)) : [];
    const notes = [{ ...mr, body: mr.description, description: true }, ...discussions] as Record<string, unknown>[];
    for (const note of notes) {
      const author = object(note.author);
      const login = author?.username;
      if (typeof login === "string") reviewers.add(login, author?.name);
      if (note.system === true || author?.bot === true || typeof login !== "string" || /(?:\[bot\]|_bot|^project_\d+_bot_\w+)$/iu.test(login)
        || !positive(author?.id) || !positive(note.id) || typeof note.body !== "string" || typeof note.created_at !== "string"
        || !validAt(note.created_at, since, until)) continue;
      const position = object(note.position);
      const path = typeof position?.new_path === "string" ? position.new_path : undefined;
      if (position && (!path || !tree.has(path))) continue;
      const id = note.description === true ? `gitlab:description:${note.id}` : `gitlab:note:${note.id}`;
      const link = `https://gitlab.com/${request.source.slug}/-/merge_requests/${pull}${note.description === true ? "" : `#note_${note.id}`}`;
      const candidate = reviewSource(note.body, { id, link, at: note.created_at, pull, writer: false, topLevel: !position, outdated: false,
        ...(path ? { path } : {}) }, gaps);
      if (!candidate) continue;
      const authorId = author.id;
      if (!client.anonymous && !permissions.has(authorId) && checked++ < PAGE_SIZE) {
        const member = object((await client.get(`${prefix}/members/all/${authorId}`, true))?.value);
        const active = member?.state === undefined || member.state === "active";
        const access = member?.access_level;
        permissions.set(authorId, typeof access === "number" ? active && access >= 30 : undefined);
      }
      const writer = permissions.get(authorId);
      if (writer === undefined) gaps.add("Some review authors' write access could not be checked.");
      const oldHead = position?.head_sha;
      let outdated = false;
      if (path && typeof oldHead === "string") {
        const key = `${oldHead}:${path}`;
        if (!changed.has(key) && changed.size < 24) changed.set(key, await tree.changedSince(path, oldHead));
        outdated = changed.get(key) === true;
      }
      reviews.push({ ...candidate, writer: writer === true, outdated });
    }
  }
  const kept = redactReviews(reviews, reviewers, gaps, request.preferred, request.preferDistinctPulls);
  const files = new Map<number, string[]>();
  for (const source of kept) {
    if (!source.writer || files.has(source.pull)) continue;
    files.set(source.pull, await readChangedPaths(client, `${prefix}/merge_requests/${source.pull}/diffs`, "new_path", tree));
  }
  return { reviews: kept.map(source => {
    const changedPaths = source.writer ? files.get(source.pull) : undefined;
    return changedPaths?.length ? { ...source, changedPaths } : source;
  }), reviewers, gaps: [...gaps] };
}
