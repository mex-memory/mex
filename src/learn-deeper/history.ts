import { ForgeClient, object, positive, rows } from "./forge.js";
import { command, type PinnedTree } from "./git.js";
import type { Reviewers } from "./reviewers.js";
import { cleanSourceText, sourceDigest, validAt, type ContextSource, type Repository, type SourceWindow } from "./source.js";

const contextLimit = 3;

async function issues(client: ForgeClient, repo: Repository, window: SourceWindow, reviewers: Reviewers): Promise<ContextSource[]> {
  const github = repo.host === "github.com";
  const base = github ? `/repos/${repo.slug}` : `/projects/${encodeURIComponent(repo.slug)}`;
  const query = new URLSearchParams(github ? { state: "closed", per_page: "8", since: window.since }
    : { state: "closed", per_page: "8", scope: "all", updated_after: window.since });
  const page = await client.get(`${base}/issues?${query}`, true);
  if (!page) return [];
  const inputs = rows(page.value);
  for (const issue of inputs) {
    const author = object(github ? issue.user : issue.author);
    const login = github ? author?.login : author?.username;
    if (typeof login === "string") reviewers.add(login, author?.name);
  }
  const result: ContextSource[] = [];
  for (const issue of inputs) {
    const number = github ? issue.number : issue.iid;
    const author = object(github ? issue.user : issue.author);
    if (!positive(number) || issue.pull_request || author?.bot === true || author?.type === "Bot" || typeof issue.updated_at !== "string"
      || !validAt(issue.updated_at, window.since, window.until)) continue;
    const raw = github ? issue.body : issue.description;
    const text = typeof raw === "string" ? cleanSourceText(raw, reviewers)?.slice(0, 1200) : undefined;
    if (typeof raw !== "string" || !text) continue;
    result.push({ kind: "context", id: `issue:${repo.host}:${number}`, hash: sourceDigest(raw), text,
      link: `https://${repo.host}/${repo.slug}/${github ? "" : "-/"}issues/${number}` });
    if (result.length === contextLimit) break;
  }
  return result;
}

async function rationale(tree: PinnedTree, repo: Repository, window: SourceWindow, reviewers: Reviewers): Promise<ContextSource[]> {
  const log = await command(tree.root, "git", ["log", "--no-merges", "-n", "24", `--since=${window.since}`, `--until=${window.until}`,
    "--format=%H%x00%B%x00", tree.head], undefined, 128 << 10);
  const records = (log ?? "").split("\0");
  const result: ContextSource[] = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const hash = records[i].trim(), raw = records[i + 1];
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(hash) || !/\b(?:because|rationale|so that|in order to|to prevent|why:)\b/iu.test(raw)) continue;
    const text = cleanSourceText(raw, reviewers)?.slice(0, 1200);
    if (!text) continue;
    result.push({ kind: "context", id: `commit:${hash}`, hash: sourceDigest(raw), text,
      link: `https://${repo.host}/${repo.slug}/${repo.host === "gitlab.com" ? "-/" : ""}commit/${hash}` });
    if (result.length === contextLimit) break;
  }
  return result;
}

export async function contextSources(client: ForgeClient, source: Repository, checkout: Repository, tree: PinnedTree, window: SourceWindow,
  reviewers: Reviewers, gaps: Set<string>): Promise<ContextSource[]> {
  const discussions = await issues(client, source, window, reviewers).catch(() => { gaps.add("Some issue context could not be read."); return []; });
  return [...discussions, ...await rationale(tree, checkout, window, reviewers)];
}
