import { setTimeout as sleep } from "node:timers/promises";
import { hasSecret, stripHidden } from "../knowledge/gates.js";
import { command, repoPath, type PinnedTree } from "./git.js";
import type { Reviewers } from "./reviewers.js";
import type { Repository, ReviewSource, SourceWindow } from "./source.js";

const MAX_RESPONSE = 2 << 20;
const MAX_TOKEN_LENGTH = 4096;
export const MAX_REVIEW_FILES = 8;

export type FetchProblem = "login" | "offline" | "rate-limit" | "unavailable" | "moved";
export class SourceError extends Error {
  constructor(readonly problem: FetchProblem, readonly retryAt?: number) {
    super({ login: "Sign in to the source host before learning can continue.", offline: "The source host could not be reached.",
      "rate-limit": "The source host's request limit needs to reset.", unavailable: "The source host returned incomplete repository data.",
      moved: "The repository moved." }[problem]);
  }
}

export interface Pull { number: number; at: string; }
export interface Inventory { source: Repository; visibility: "public" | "private"; pulls: Pull[]; more: boolean; anonymous: boolean; }
export interface ReviewBatch { reviews: ReviewSource[]; reviewers: Reviewers; gaps: string[]; }
export type RepositoryAccess = Pick<Inventory, "source" | "visibility">;
export interface ReviewRequest extends SourceWindow {
  source: Repository; pulls: readonly Pull[]; tree: PinnedTree; preferred: readonly string[];
  preferDistinctPulls?: boolean;
}
export interface SourceHost {
  access(client: ForgeClient): Promise<RepositoryAccess>;
  inventory(client: ForgeClient, window: SourceWindow, limit: number): Promise<Inventory>;
  reviews(client: ForgeClient, request: ReviewRequest): Promise<ReviewBatch>;
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(row => !object(row))) throw new SourceError("unavailable");
  return value as Record<string, unknown>[];
}
export function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// GitHub's associations can include read-only access. Use them only when the permission check is unavailable.
export function associatedWriter(association: unknown): true | undefined {
  return association === "MEMBER" || association === "OWNER" || association === "COLLABORATOR" ? true : undefined;
}

export function pinnedChangedPaths(value: unknown, field: string, tree: Pick<PinnedTree, "has">): string[] {
  if (!Array.isArray(value)) return [];
  const paths = value.slice(0, MAX_REVIEW_FILES).flatMap(value => {
    const path = object(value)?.[field];
    return repoPath(path) && tree.has(path) && stripHidden(path) === path && !hasSecret(path) ? [path] : [];
  });
  return [...new Set(paths)];
}

/** Changed-file metadata is optional evidence. Keep existing sources if it is unavailable. */
export async function readChangedPaths(client: ForgeClient, route: string, field: string, tree: Pick<PinnedTree, "has">): Promise<string[]> {
  const page = await client.get(route + "?per_page=" + MAX_REVIEW_FILES, true).catch(error => {
    if (!(error instanceof SourceError)) throw error;
    return undefined;
  });
  return pinnedChangedPaths(page?.value, field, tree);
}

function validToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token && token.length <= MAX_TOKEN_LENGTH && /^[\x21-\x7e]+$/u.test(token) ? token : undefined;
}

export async function hostToken(root: string, repo: Repository, env = process.env): Promise<string | undefined> {
  const github = repo.host === "github.com";
  const explicit = github ? validToken(env.GH_TOKEN) ?? validToken(env.GITHUB_TOKEN)
    : validToken(env.GITLAB_TOKEN) ?? validToken(env.GL_TOKEN);
  if (explicit) return explicit;
  const cli = github ? await command(root, "gh", ["auth", "token", "--hostname", repo.host])
    : await command(root, "glab", ["config", "get", "token", "--host", repo.host]);
  const token = validToken(cli);
  if (token) return token;
  const credential = await command(root, "git", ["credential", "fill"], `protocol=https\nhost=${repo.host}\npath=${repo.slug}.git\n\n`);
  return validToken(/^password=(.+)$/mu.exec(credential ?? "")?.[1]);
}

export interface Page { value: unknown; more: boolean; }

const MAX_API_REDIRECTS = 3;

/** Only fixed HTTPS origins. A same-host API redirect is followed a few times. Anything else is a moved repository, with no location in the error. */
export class ForgeClient {
  private nextRequest = 0;
  private redirects = 0;
  /** Set when a same-host redirect resolved this name to a different repository slug. */
  renamed?: Repository;
  readonly anonymous: boolean;
  constructor(public repo: Repository, private readonly token?: string, private readonly request = fetch,
    private readonly anonymousDelayMs = 1100) { this.anonymous = !token; }

  redirectCount(): number { return this.redirects; }

  async get(path: string, optional = false): Promise<Page | undefined> {
    return this.read(path, optional);
  }

  async graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.anonymous || this.repo.host !== "github.com") throw new SourceError("login");
    const response = object((await this.read("/graphql", false, JSON.stringify({ query, variables })))?.value);
    const data = object(response?.data);
    if (!data || Array.isArray(response?.errors) && response.errors.length > 0) throw new SourceError("unavailable");
    return data;
  }

  private async read(path: string, optional: boolean, body?: string): Promise<Page | undefined> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new SourceError("unavailable");
    const github = this.repo.host === "github.com";
    const base = github ? "https://api.github.com" : "https://gitlab.com/api/v4";
    if (!this.token) await sleep(Math.max(0, this.nextRequest - Date.now()));
    this.nextRequest = Date.now() + this.anonymousDelayMs;
    const headers: Record<string, string> = github
      ? { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
      : { Accept: "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const api = new URL(base);
    let url = base + path;
    let response!: Response;
    for (let followed = 0; ; ) {
      try { response = await this.request(url, { headers, ...(body === undefined ? {} : { method: "POST", body }), redirect: "manual", signal: AbortSignal.timeout(8000) }); }
      catch { throw new SourceError("offline"); }
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      let next: URL;
      try { next = new URL(location ?? "", url); } catch { throw new SourceError("moved"); }
      if (body !== undefined || !location || next.protocol !== "https:" || next.host !== api.host || followed >= MAX_API_REDIRECTS) throw new SourceError("moved");
      followed++;
      this.redirects++;
      url = next.toString();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const retry = Number(response.headers.get("retry-after"));
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0"
        || response.status === 403 && retry > 0) {
        throw new SourceError("rate-limit", Math.max(Date.now() + (retry > 0 ? retry * 1000 : 60_000), reset));
      }
      if (optional && (response.status === 403 || response.status === 404 || this.anonymous && response.status === 401)) return undefined;
      if (response.status === 401 || response.status === 403 || response.status === 404) throw new SourceError("login");
      throw new SourceError(response.status >= 500 ? "offline" : "unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SourceError("unavailable");
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_RESPONSE) { await reader.cancel(); throw new SourceError("unavailable"); }
        chunks.push(Buffer.from(value));
      }
    } catch (error) { throw error instanceof SourceError ? error : new SourceError("offline"); }
    finally { reader.releaseLock(); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new SourceError("unavailable"); }
    return { value, more: /\brel="next"/u.test(response.headers.get("link") ?? "") || Number(response.headers.get("x-next-page")) > 0 };
  }
}
