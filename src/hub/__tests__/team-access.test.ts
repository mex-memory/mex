import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHubApp } from "../app.js";
import { createLocalHubReadServices } from "../services.js";
import { HubSessionManager } from "../security/session.js";
import type { HubTelemetrySink } from "../telemetry.js";
import type { GitCommit, GitPort } from "../../team/contracts/git.js";

const ORIGIN = "http://127.0.0.1:48126";
const HOST = "127.0.0.1:48126";
const TOKEN = Buffer.alloc(32, 5).toString("base64url");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function commit(email: string | null, name: string | null = null): GitCommit {
  return { hash: "a".repeat(40), parents: [], author: { name, email }, authoredAt: "2026-10-01T00:00:00Z",
    committer: { name, email }, committedAt: "2026-10-01T00:00:00Z", subject: "work" };
}

/** History served in pages of the requested size, as the real Git port does. */
function history(commits: GitCommit[]) {
  const getHistory = vi.fn(async (request: { limit?: number; cursor?: string } = {}) => {
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    const limit = request.limit ?? 50;
    const items = commits.slice(offset, offset + limit);
    const next = offset + limit < commits.length ? String(offset + limit) : null;
    return { items, nextCursor: next, truncated: next !== null };
  });
  return { getHistory } as unknown as GitPort & { getHistory: typeof getHistory };
}

async function hub(git: GitPort, telemetry?: HubTelemetrySink) {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-team-access-"));
  roots.push(root);
  mkdirSync(join(root, ".mex"));
  const unused = async (): Promise<never> => { throw new Error("Team access must not consult Team workflows."); };
  const app = createHubApp({ security: new HubSessionManager({ bootstrapToken: TOKEN, expectedOrigin: ORIGIN }), telemetry,
    services: createLocalHubReadServices({ projectRoot: root, scaffoldId: "team-access-fixture", git, jobs: { list: () => ({ items: [] }) },
      team: { getMember: unused, listMembers: unused, getCurrentActor: unused, getActivity: unused,
        listActivity: unused, previewIdentityActivity: unused, applyIdentityActivity: unused } }) });
  const bootstrap = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, { method: "POST",
    headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  const session = await app.request(`${ORIGIN}/api/v1/session`, { headers: { host: HOST, cookie } });
  const { csrfToken } = await session.json() as { csrfToken: string };
  return {
    contributors: () => app.request(`${ORIGIN}/api/v1/repository/contributors`, { headers: { host: HOST, cookie } }),
    step: (body: unknown) => app.request(`${ORIGIN}/api/v1/telemetry/team-access`, { method: "POST",
      headers: { host: HOST, cookie, origin: ORIGIN, "content-type": "application/json", "x-mex-csrf": csrfToken }, body: JSON.stringify(body) }),
  };
}

describe("repository contributors", () => {
  it("reports one author, case-insensitively, as not more than one", async () => {
    const git = history([commit("ada@example.com"), commit("ADA@example.com"), commit("ada@example.com")]);
    const response = await (await hub(git)).contributors();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ moreThanOne: false });
  });

  it("stops at the second distinct author and returns no author details", async () => {
    const git = history([commit("ada@example.com"), commit("grace@example.com"), ...Array.from({ length: 500 }, () => commit("x@example.com"))]);
    const response = await (await hub(git)).contributors();
    const body = await response.json();
    expect(body).toEqual({ moreThanOne: true });
    expect(JSON.stringify(body)).not.toContain("example.com");
    expect(git.getHistory).toHaveBeenCalledOnce();
  });

  it("reads only a bounded window of recent history", async () => {
    const git = history([...Array.from({ length: 1_500 }, () => commit("ada@example.com")), commit("grace@example.com")]);
    expect(await (await (await hub(git)).contributors()).json()).toEqual({ moreThanOne: false });
    expect(git.getHistory).toHaveBeenCalledTimes(5);
  });

  it("falls back to the author name when Git has no email", async () => {
    const git = history([commit(null, "Ada"), commit(null, "Grace")]);
    expect(await (await (await hub(git)).contributors()).json()).toEqual({ moreThanOne: true });
  });
});

describe("team-access telemetry route", () => {
  it("accepts the four fixed steps and refuses anything else", async () => {
    const sink = vi.fn();
    const client = await hub(history([]), sink);
    for (const step of ["card_viewed", "button_clicked", "dialog_opened", "submitted"]) {
      expect((await client.step({ step })).status).toBe(204);
    }
    expect((await client.step({ step: "email_typed" })).status).toBe(400);
    expect((await client.step({ step: "submitted", email: "ada@example.com" })).status).toBe(400);
    expect(sink.mock.calls.filter(([name]) => name === "hub.team_access").map(([, attributes]) => attributes)).toEqual([
      { step: "card_viewed" }, { step: "button_clicked" }, { step: "dialog_opened" }, { step: "submitted" },
    ]);
  });
});

describe("Overview sharing signals", () => {
  it("reports a second real commit author and no Relay without exposing either", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-hub-sharing-"));
    roots.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    mkdirSync(join(root, ".mex"));
    for (const [name, email] of [["Ada", "ada@example.com"], ["Grace", "grace@example.com"]] as const) {
      writeFileSync(join(root, `${name}.txt`), name);
      git("add", "-A");
      git("-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", name);
    }
    const unavailable = async (): Promise<never> => { throw new Error("Team reads are not under test."); };
    const services = createLocalHubReadServices({ projectRoot: root, scaffoldId: "sharing-fixture", jobs: { list: () => ({ items: [] }) },
      team: { getMember: unavailable, listMembers: unavailable, getCurrentActor: unavailable, getActivity: unavailable,
        listActivity: unavailable, previewIdentityActivity: unavailable, applyIdentityActivity: unavailable } });
    const overview = await services.overview!();
    expect(overview.sharing).toEqual({ relayPublished: false, moreThanOneContributor: true });
    expect(await services.repositoryContributors!()).toEqual({ moreThanOne: true });
  });
});
