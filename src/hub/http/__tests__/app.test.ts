import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HealthResponse,
  HomeResponse,
  HubCapabilities,
  HubJobSnapshot,
  InboxDraftDetail,
  InboxDraftListResponse,
  InboxOperationApplyResponse,
  InboxOperationPreviewRequest,
  InboxOperationPreviewResponse,
  InboxProposalDetail,
  InboxProposalListResponse,
  OverviewResponse,
  RelayDetail,
  RelayDraftDetail,
  RelayDraftListResponse,
  RelayListResponse,
  RelayOperationApplyResponse,
  RelayOperationPreviewRequest,
  RelayOperationPreviewResponse,
  SearchRequest,
  SearchResponse,
  SpecDetailResponse,
  SpecListResponse,
  TeamMember,
  TeamOperationApplyResponse,
  TeamOperationPreviewRequest,
  TeamOperationPreviewResponse,
  TeamWorkstream,
} from "@mex/hub-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createHubApp,
  type HubJobEvent,
  type HubJobService,
  type HubReadServices,
} from "../../app.js";
import { HubSessionManager } from "../../security/session.js";
import { HubAssetManifest } from "../../static/assets.js";
import type { HubTelemetrySink } from "../../telemetry.js";

const ORIGIN = "http://127.0.0.1:48123";
const HOST = "127.0.0.1:48123";
const BOOTSTRAP = Buffer.alloc(32, 7).toString("base64url");
const JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TEAM_MEMBER_ID = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TEAM_EVENT_ID = "event_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const TEAM_WORKSTREAM_ID = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAC";
const SPEC_ID = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAD";
const REQUIREMENT_ID = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAE";
const INBOX_DRAFT_ID = "inbox_00000000000000000000000000000001";
const INBOX_PROPOSAL_ID = "proposal_01000000000000000000001720";
const RELAY_DRAFT_ID = "relay-draft-01";
const RELAY_ID = "relay_01000000000000000000000001";
const TEAM_NOW = "2026-08-27T04:05:06.000Z";
const RELAY_DIRTY_PUBLICATION_WARNING = "MEX recorded that local changes existed when this Relay was published; it did not record their paths, diff, or contents.";

describe("Project Hub HTTP application", () => {
  it("authenticates migration previews and forwards only the reviewed job revision", async () => {
    const previewWikiMigration = vi.fn(async () => ({ revision: "a".repeat(64), report: "Files scanned: 1", canApply: true }));
    const assertJobStartAllowed = vi.fn();
    const app = fixtureApp({ services: { ...readServices(), previewWikiMigration, assertJobStartAllowed }, jobs: jobService() });
    const path = `${ORIGIN}/api/v1/jobs/wiki-migration/preview`;
    expect((await app.request(path, mutation({}))).status).toBe(401);
    expect(previewWikiMigration).not.toHaveBeenCalled();
    const { cookie, csrfToken } = await authenticatedSession(app);
    const headers = { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json", "x-mex-csrf": csrfToken };
    expect((await app.request(path, { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect(previewWikiMigration).toHaveBeenCalledOnce();
    expect((await app.request(path, { method: "POST", headers, body: '{"path":"private"}' })).status).toBe(400);
    await app.request(`${ORIGIN}/api/v1/jobs`, { method: "POST", headers, body: JSON.stringify({ kind: "wiki_rebuild", migrationPreview: "a".repeat(64) }) });
    expect(assertJobStartAllowed).toHaveBeenCalledWith("wiki_rebuild", "a".repeat(64));
  });
  it("accepts only authenticated bounded page categories and never treats reads as telemetry", async () => {
    const telemetry = vi.fn();
    const app = fixtureApp({ telemetry });
    const path = `${ORIGIN}/api/v1/telemetry/page`;
    expect((await app.request(path, mutation({ page: "home" }))).status).toBe(401);
    const { cookie, csrfToken } = await authenticatedSession(app);
    const headers = { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken };
    for (const endpoint of ["session", "home", "health"]) {
      expect((await app.request(`${ORIGIN}/api/v1/${endpoint}`, { headers })).status).toBe(200);
    }
    expect(telemetry).not.toHaveBeenCalled();
    const post = (body: unknown, overrides: Record<string, string> = {}) => app.request(path, {
      method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body),
    });
    expect((await post({ page: "home" }, { origin: "https://outside.example" })).status).toBe(403);
    expect((await post({ page: "home" }, { "x-mex-csrf": "wrong" })).status).toBe(403);
    expect((await post({ page: "home" }, { "content-type": "text/plain" })).status).toBe(400);
    for (const body of [{ page: "/private/source.ts" }, { page: "home", url: "/secret" },
      { page: "home", memberId: TEAM_MEMBER_ID }, { event: "hub.session_started" }, { page: null }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await app.request(path, { method: "POST", headers,
      body: JSON.stringify({ page: "home" }) + " ".repeat(128) })).status).toBe(400);
    expect((await app.request(`${path}?query=private`, {
      method: "POST", headers, body: JSON.stringify({ page: "home" }),
    })).status).toBe(400);
    expect(telemetry).not.toHaveBeenCalled();
    const accepted = await post({ page: "knowledge_detail" });
    expect(accepted.status).toBe(204);
    expect(await accepted.text()).toBe("");
    expect(accepted.headers.get("cache-control")).toContain("no-store");
    expect(telemetry.mock.calls).toEqual([["hub.page_viewed", { page: "knowledge_detail" }]]);
  });

  it.each(["team", "inbox", "relays"] as const)(
    "projects validated %s actions, trusted replay outcomes, and failures without payload data",
    async (family) => {
      const telemetry = vi.fn();
      const services = family === "team" ? teamReadServices() : family === "inbox" ? inboxReadServices() : relayReadServices();
      const request = family === "team" ? teamPreviewRequest() : family === "inbox" ? inboxPreviewRequest() : relayPreviewRequest();
      let replayed = false;
      let fail = false;
      const apply = async () => {
        if (fail) throw new Error("private@example.test /Users/private/project");
        const result = family === "team" ? teamApplyResult() : family === "inbox" ? inboxApplyResult() : relayApplyResult();
        return { ...result, idempotentReplay: replayed };
      };
      const applyKey = family === "team" ? "applyTeamOperation" : family === "inbox" ? "applyInboxOperation" : "applyRelayOperation";
      // The existing independently validated family fixtures supply each exact
      // response shape; the wrapper changes only the trusted replay outcome.
      const app = fixtureApp({ telemetry, services: { ...services, [applyKey]: apply } });
      const { cookie, csrfToken } = await authenticatedSession(app);
      const headers = { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken };
      const post = (stage: string, body: unknown) => app.request(`${ORIGIN}/api/v1/${family}/operations/${stage}`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      expect((await post("preview", { ...request, actor: "private" })).status).toBe(400);
      expect(telemetry).not.toHaveBeenCalled();
      const preview = await post("preview", request);
      expect(preview.status).toBe(200);
      const envelope = await preview.json();
      expect((await post("apply", envelope)).status).toBe(200);
      replayed = true;
      expect((await post("apply", envelope)).status).toBe(200);
      fail = true;
      expect((await post("apply", envelope)).status).toBe(500);
      expect(telemetry.mock.calls).toEqual([
        ["hub.action_completed", { action: request.action.kind, stage: "preview", outcome: "success", duration_ms: expect.any(Number) }],
        ["hub.action_completed", { action: request.action.kind, stage: "apply", outcome: "success", duration_ms: expect.any(Number), replayed: false }],
        ["hub.action_completed", { action: request.action.kind, stage: "apply", outcome: "success", duration_ms: expect.any(Number), replayed: true }],
        ["hub.action_completed", { action: request.action.kind, stage: "apply", outcome: "failure", duration_ms: expect.any(Number) }],
      ]);
      expect(JSON.stringify(telemetry.mock.calls)).not.toMatch(/private|Ada|@|member_|proposal_|receipt|operationId|revision|\.mex/);
    },
  );

  it("exchanges the bootstrap once and protects every ordinary API route", async () => {
    const app = fixtureApp();
    const unauthenticated = await app.request(`${ORIGIN}/api/v1/home`, {
      headers: { host: HOST },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("content-type")).toContain("application/problem+json");

    const wrongBootstrapMethod = await app.request(
      `${ORIGIN}/api/v1/session/bootstrap`,
      { headers: { host: HOST } },
    );
    expect(wrongBootstrapMethod.status).toBe(401);

    const unknownVersion = await app.request(`${ORIGIN}/api/v2/unknown`, {
      headers: { host: HOST },
    });
    expect(unknownVersion.status).toBe(401);

    const bootstrap = await bootstrapSession(app);
    expect(bootstrap.response.status).toBe(201);
    expect(bootstrap.response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(bootstrap.response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(bootstrap.response.headers.get("set-cookie")).toContain("Path=/api/v1");
    expect(await bootstrap.response.text()).not.toContain(BOOTSTRAP);

    const session = await app.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie: bootstrap.cookie },
    });
    expect(session.status).toBe(200);
    expect((await session.json() as { csrfToken: string }).csrfToken).toMatch(/^[\w-]{43}$/);

    const authenticatedUnknownVersion = await app.request(`${ORIGIN}/api/v2/unknown`, {
      headers: { host: HOST, cookie: bootstrap.cookie },
    });
    expect(authenticatedUnknownVersion.status).toBe(404);

    const replay = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, mutation({
      token: BOOTSTRAP,
    }));
    expect(replay.status).toBe(401);
    expect((await replay.json() as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("keeps loopback sessions isolated across independent Hub processes", async () => {
    const first = fixtureApp({
      randomStart: 20,
      sessionCookieSuffix: Buffer.alloc(16, 1).toString("base64url"),
    });
    const second = fixtureApp({
      randomStart: 40,
      sessionCookieSuffix: Buffer.alloc(16, 2).toString("base64url"),
    });
    const firstSession = await bootstrapSession(first);
    const secondSession = await bootstrapSession(second);

    expect(firstSession.cookie.split("=", 1)[0]).not.toBe(
      secondSession.cookie.split("=", 1)[0],
    );
    const cookies = `${firstSession.cookie}; ${secondSession.cookie}`;
    expect((await first.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie: cookies },
    })).status).toBe(200);
    expect((await second.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie: cookies },
    })).status).toBe(200);
  });

  it("rejects Host spoofing and forwarded proxy requests", async () => {
    const app = fixtureApp();
    const spoofed = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, {
      ...mutation({ token: BOOTSTRAP }),
      headers: {
        ...mutationHeaders(),
        host: "localhost:48123",
      },
    });
    expect(spoofed.status).toBe(400);
    expect(spoofed.headers.get("x-frame-options")).toBe("DENY");

    const forwarded = await app.request(`${ORIGIN}/`, {
      headers: {
        host: HOST,
        "x-forwarded-host": "attacker.invalid",
      },
    });
    expect(forwarded.status).toBe(400);
  });

  it("requires exact Origin, CSRF, and strict JSON for mutations", async () => {
    const app = fixtureApp({ jobs: jobService() });
    const { cookie } = await bootstrapSession(app);
    const sessionResponse = await app.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie },
    });
    const { csrfToken } = await sessionResponse.json() as { csrfToken: string };

    const noOrigin = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { host: HOST, cookie, "content-type": "application/json", "x-mex-csrf": csrfToken },
      body: JSON.stringify({ kind: "graph_refresh" }),
    });
    expect(noOrigin.status).toBe(403);

    const wrongCsrf = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": "wrong" },
      body: JSON.stringify({ kind: "graph_refresh" }),
    });
    expect(wrongCsrf.status).toBe(403);

    const started = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken },
      body: JSON.stringify({ kind: "graph_refresh" }),
    });
    expect(started.status).toBe(202);

    const nonEmptyCancel = await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/cancel`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken },
      body: JSON.stringify({ force: true }),
    });
    expect(nonEmptyCancel.status).toBe(400);

    const wrongType = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken, "content-type": "text/plain" },
      body: JSON.stringify({ kind: "graph_refresh" }),
    });
    expect(wrongType.status).toBe(400);
  });

  it("returns bounded plain resources and independently unavailable search groups", async () => {
    const app = fixtureApp();
    const { cookie } = await bootstrapSession(app);
    const search = await app.request(`${ORIGIN}/api/v1/search?q=router`, {
      headers: { host: HOST, cookie },
    });
    expect(search.status).toBe(200);
    const body = await search.json() as SearchResponse;
    expect(body.groups.wiki.status).toBe("unavailable");
    expect(body.groups.symbols.status).toBe("available");
    expect(body).not.toHaveProperty("data");

    const duplicate = await app.request(`${ORIGIN}/api/v1/search?q=a&q=b`, {
      headers: { host: HOST, cookie },
    });
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json() as { code: string }).code).toBe("VALIDATION_FAILED");
    const unknown = await app.request(`${ORIGIN}/api/v1/search?q=a&unsafe=x`, {
      headers: { host: HOST, cookie },
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { code: string }).code).toBe("VALIDATION_FAILED");
  });

  it("authenticates and strictly validates composite Code workspace reads", async () => {
    const services = readServices();
    const codeSymbol = vi.fn(services.codeSymbol!);
    const app = fixtureApp({ services: { ...services, codeSymbol } });

    expect((await app.request(`${ORIGIN}/api/v1/code/symbols/function:router`, {
      headers: { host: HOST },
    })).status).toBe(401);
    const { cookie } = await bootstrapSession(app);
    const response = await app.request(
      `${ORIGIN}/api/v1/code/symbols/function:router?view=callers&limit=25`,
      { headers: { host: HOST, cookie } },
    );
    expect(response.status).toBe(200);
    expect(codeSymbol).toHaveBeenCalledWith("function:router", { view: "callers", limit: 25 });
    expect(await response.json()).toMatchObject({
      symbol: { id: "function:router" },
      traversal: { view: "callers" },
    });

    const invalidId = await app.request(`${ORIGIN}/api/v1/code/symbols/function%20router`, {
      headers: { host: HOST, cookie },
    });
    expect(invalidId.status).toBe(400);
    expect((await invalidId.json() as { code: string }).code).toBe("VALIDATION_FAILED");

    for (const path of [
      "function%2Frouter",
      "..",
      "%2500",
      "function:router?view=overview&cursor=unexpected",
      "function:router?view=callers&depth=2",
      "function:router?unknown=true",
    ]) {
      const invalid = await app.request(`${ORIGIN}/api/v1/code/symbols/${path}`, {
        headers: { host: HOST, cookie },
      });
      expect([400, 404], path).toContain(invalid.status);
    }
  });

  it("authenticates and strictly validates every read-only Knowledge route", async () => {
    const id = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
    const target = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJE";
    const services = readServices();
    const summary = wikiSummary(id);
    const page = {
      indexedRevision: "d".repeat(64),
      observedAt: "2026-08-26T00:00:00.000Z",
      items: [summary],
      nextCursor: null,
      truncated: false,
    };
    const wikiEntities = vi.fn(() => page);
    const wikiEntity = vi.fn(() => ({
      indexedRevision: page.indexedRevision,
      observedAt: page.observedAt,
      entity: summary,
      body: { content: "Durable body\n", totalBytes: 13, truncated: false },
      provenance: null,
      sources: { items: [], total: 0, truncated: false },
      groundings: { items: [], total: 0, truncated: false },
      relationCount: 1,
      backlinkCount: 0,
    }));
    const relation = {
      type: "depends_on",
      source: { id, kind: "architecture", title: "Durable queue" },
      target: { id: target, kind: "component", title: "Worker" },
      note: null,
    } as const;
    const wikiRelations = vi.fn(() => ({
      ...page,
      items: [{ direction: "outgoing" as const, relation, entity: wikiSummary(target) }],
    }));
    const wikiBacklinks = vi.fn(() => ({ ...page, items: [relation] }));
    const codeKnowledge = vi.fn(() => ({
      ...page,
      items: [{ entity: summary, matchedNodes: ["function:router"] }],
    }));
    const app = fixtureApp({
      services: {
        ...services,
        wikiEntities,
        wikiEntity,
        wikiRelations,
        wikiBacklinks,
        codeKnowledge,
      },
    });

    expect((await app.request(`${ORIGIN}/api/v1/wiki/entities`, {
      headers: { host: HOST },
    })).status).toBe(401);
    const { cookie } = await bootstrapSession(app);
    const headers = { host: HOST, cookie };
    const list = await app.request(
      `${ORIGIN}/api/v1/wiki/entities?kind=architecture&lifecycle=promoted&limit=5`,
      { headers },
    );
    expect(list.status).toBe(200);
    expect(wikiEntities).toHaveBeenCalledWith({ kind: "architecture", lifecycle: "promoted", limit: 5 });
    expect((await list.json() as { items: unknown[] }).items).toHaveLength(1);
    expect((await app.request(`${ORIGIN}/api/v1/wiki/entities/${id}`, { headers })).status).toBe(200);
    expect(wikiEntity).toHaveBeenCalledWith(id);
    expect((await app.request(
      `${ORIGIN}/api/v1/wiki/entities/${id}/relations?direction=outgoing&type=depends_on`,
      { headers },
    )).status).toBe(200);
    expect(wikiRelations).toHaveBeenCalledWith(id, {
      direction: "outgoing",
      type: "depends_on",
      limit: 25,
    });
    expect((await app.request(
      `${ORIGIN}/api/v1/wiki/entities/${target}/backlinks?limit=5`,
      { headers },
    )).status).toBe(200);
    expect((await app.request(
      `${ORIGIN}/api/v1/code/symbols/function:router/knowledge?limit=5`,
      { headers },
    )).status).toBe(200);
    expect(codeKnowledge).toHaveBeenCalledWith("function:router", { limit: 5 });

    for (const path of [
      "/api/v1/wiki/entities?kind=a&kind=b",
      "/api/v1/wiki/entities?unknown=true",
      `/api/v1/wiki/entities/${id}?unexpected=true`,
      "/api/v1/wiki/entities/not-an-id",
      `/api/v1/wiki/entities/${id}/relations?limit=51`,
      "/api/v1/code/symbols/function%2Frouter/knowledge",
    ]) {
      const invalid = await app.request(`${ORIGIN}${path}`, { headers });
      expect([400, 404], path).toContain(invalid.status);
    }
  });

  it("revalidates graph job eligibility before creating a durable job", async () => {
    const services = readServices();
    const assertJobStartAllowed = vi.fn(() => {
      const error = new Error("Unsafe graph state with /Users/alice/private details.") as Error & {
        problem: Record<string, unknown>;
      };
      error.problem = {
        status: 503,
        code: "CAPABILITY_UNAVAILABLE",
        title: "unsafe title",
        detail: error.message,
      };
      throw error;
    });
    const jobs = jobService();
    const start = vi.spyOn(jobs, "start");
    const app = fixtureApp({ services: { ...services, assertJobStartAllowed }, jobs });
    const { cookie } = await bootstrapSession(app);
    const session = await app.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie },
    });
    const csrf = (await session.json() as { csrfToken: string }).csrfToken;
    const response = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrf },
      body: JSON.stringify({ kind: "graph_rebuild" }),
    });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(start).not.toHaveBeenCalled();
    expect(body).not.toContain("/Users/alice");
  });

  it("authenticates and strictly validates bounded Activity reads", async () => {
    const services = readServices();
    const activity = vi.fn(services.activity);
    const app = fixtureApp({ services: { ...services, activity } });

    expect((await app.request(`${ORIGIN}/api/v1/activity`, {
      headers: { host: HOST },
    })).status).toBe(401);

    const { cookie } = await bootstrapSession(app);
    const since = "2026-08-22T00:00:00.000Z";
    const response = await app.request(
      `${ORIGIN}/api/v1/activity?source=legacy&since=${encodeURIComponent(since)}&limit=1`,
      { headers: { host: HOST, cookie } },
    );
    expect(response.status).toBe(200);
    expect(activity).toHaveBeenCalledWith({ source: "legacy", since, limit: 1 });
    expect(await response.json()).not.toHaveProperty("data");

    for (const query of [
      "source=activity&source=legacy",
      "source=wiki",
      "since=2026-08-22",
      "limit=101",
      "unsafe=true",
    ]) {
      const invalid = await app.request(`${ORIGIN}/api/v1/activity?${query}`, {
        headers: { host: HOST, cookie },
      });
      expect(invalid.status, query).toBe(400);
      expect((await invalid.json() as { code: string }).code).toBe("INVALID_REQUEST");
    }
  });

  it("authenticates and strictly validates bounded member and current-actor reads", async () => {
    const services = teamReadServices();
    const members = vi.fn(services.members!);
    const member = vi.fn(services.member!);
    const currentActor = vi.fn(services.currentActor!);
    const app = fixtureApp({ services: { ...services, members, member, currentActor } });

    for (const path of [
      "/api/v1/members",
      `/api/v1/members/${TEAM_MEMBER_ID}`,
      "/api/v1/actor/current",
    ]) {
      const response = await app.request(`${ORIGIN}${path}`, { headers: { host: HOST } });
      expect(response.status, path).toBe(401);
    }

    const { cookie } = await bootstrapSession(app);
    const headers = { host: HOST, cookie };
    expect(await (await app.request(`${ORIGIN}/api/v1/capabilities`, { headers })).json())
      .toMatchObject({
        activityRecord: { availability: "available" },
        members: {
          read: { availability: "available" },
          canonicalMutation: { availability: "available" },
          localSelection: { availability: "available" },
        },
      });
    const list = await app.request(`${ORIGIN}/api/v1/members?active=false&limit=1`, { headers });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(members).toHaveBeenCalledWith({ active: false, limit: 1 });
    expect(await list.json()).toMatchObject({
      items: [{ id: TEAM_MEMBER_ID }],
      truncated: false,
    });

    const detail = await app.request(`${ORIGIN}/api/v1/members/${TEAM_MEMBER_ID}`, { headers });
    expect(detail.status).toBe(200);
    expect(member).toHaveBeenCalledWith(TEAM_MEMBER_ID);
    expect(await detail.json()).toMatchObject({ id: TEAM_MEMBER_ID });

    const actor = await app.request(`${ORIGIN}/api/v1/actor/current`, { headers });
    expect(actor.status).toBe(200);
    expect(currentActor).toHaveBeenCalledTimes(1);
    expect(await actor.json()).toMatchObject({
      source: "configured-member",
      selection: { memberId: TEAM_MEMBER_ID },
    });

    members.mockClear();
    member.mockClear();
    currentActor.mockClear();
    for (const path of [
      "/api/v1/members?active=yes",
      "/api/v1/members?active=true&active=false",
      "/api/v1/members?limit=101",
      "/api/v1/members?unexpected=true",
      "/api/v1/members/not-a-member",
      `/api/v1/members/${TEAM_MEMBER_ID}?unexpected=true`,
      "/api/v1/actor/current?unexpected=true",
    ]) {
      const invalid = await app.request(`${ORIGIN}${path}`, { headers });
      expect(invalid.status, path).toBe(400);
    }
    expect(members).not.toHaveBeenCalled();
    expect(member).not.toHaveBeenCalled();
    expect(currentActor).not.toHaveBeenCalled();
  });

  it("authenticates and strictly validates Workstream and read-only Spec routes", async () => {
    const services = teamReadServices();
    const workstreamValue = teamWorkstream();
    const workstreams = vi.fn(() => ({
      items: [workstreamValue],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "4".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    }));
    const workstream = vi.fn((id: string) => id === TEAM_WORKSTREAM_ID ? workstreamValue : null);
    const specs = vi.fn(() => specListResponse());
    const spec = vi.fn(() => specDetailResponse());
    const app = fixtureApp({
      services: { ...services, workstreams, workstream, specs, spec },
    });

    for (const path of [
      "/api/v1/workstreams",
      `/api/v1/workstreams/${TEAM_WORKSTREAM_ID}`,
      "/api/v1/specs",
      `/api/v1/specs/${SPEC_ID}`,
    ]) {
      expect((await app.request(`${ORIGIN}${path}`, { headers: { host: HOST } })).status, path)
        .toBe(401);
    }

    const { cookie } = await bootstrapSession(app);
    const headers = { host: HOST, cookie };
    const workstreamList = await app.request(
      `${ORIGIN}/api/v1/workstreams?state=archived&includeArchived=true&limit=5`,
      { headers },
    );
    expect(workstreamList.status).toBe(200);
    expect(workstreams).toHaveBeenCalledWith({
      state: "archived",
      includeArchived: true,
      limit: 5,
    });
    expect(await workstreamList.json()).toMatchObject({
      items: [{ id: TEAM_WORKSTREAM_ID }],
    });
    expect((await app.request(`${ORIGIN}/api/v1/workstreams/${TEAM_WORKSTREAM_ID}`, { headers })).status)
      .toBe(200);

    const specList = await app.request(
      `${ORIGIN}/api/v1/specs?lifecycleStates=in_flight,promoted&groundingHealth=fresh,missing&topics=${SPEC_ID},${REQUIREMENT_ID}&limit=5`,
      { headers },
    );
    expect(specList.status).toBe(200);
    expect(specs).toHaveBeenCalledWith({
      lifecycleStates: ["in_flight", "promoted"],
      groundingHealth: ["fresh", "missing"],
      topics: [SPEC_ID, REQUIREMENT_ID],
      limit: 5,
    });
    expect(await specList.json()).toMatchObject({
      availability: "ready",
      page: { items: [{ id: SPEC_ID, kind: "spec" }] },
    });
    expect((await app.request(`${ORIGIN}/api/v1/specs/${SPEC_ID}`, { headers })).status)
      .toBe(200);

    workstreams.mockClear();
    specs.mockClear();
    for (const path of [
      "/api/v1/workstreams?state=paused",
      "/api/v1/workstreams?state=active&state=blocked",
      "/api/v1/workstreams?limit=101",
      "/api/v1/specs?lifecycleStates=in_flight,unknown",
      "/api/v1/specs?lifecycleStates=in_flight&lifecycleStates=promoted",
      "/api/v1/specs?groundingHealth=fresh,fresh",
      "/api/v1/specs?unexpected=true",
    ]) {
      expect((await app.request(`${ORIGIN}${path}`, { headers })).status, path).toBe(400);
    }
    expect(workstreams).not.toHaveBeenCalled();
    expect(specs).not.toHaveBeenCalled();
  });

  it("protects team preview/apply and never invokes services for invalid authority", async () => {
    const services = teamReadServices();
    const previewTeamOperation = vi.fn(services.previewTeamOperation!);
    const applyTeamOperation = vi.fn(services.applyTeamOperation!);
    const app = fixtureApp({
      services: { ...services, previewTeamOperation, applyTeamOperation },
    });
    const request = teamPreviewRequest();

    expect((await app.request(`${ORIGIN}/api/v1/team/operations/preview`, mutation(request))).status)
      .toBe(401);

    const { cookie, csrfToken } = await authenticatedSession(app);
    const authenticatedHeaders = {
      ...mutationHeaders(),
      cookie,
      "x-mex-csrf": csrfToken,
    };
    const noOrigin = await app.request(`${ORIGIN}/api/v1/team/operations/preview`, {
      method: "POST",
      headers: {
        host: HOST,
        cookie,
        "content-type": "application/json",
        "x-mex-csrf": csrfToken,
      },
      body: JSON.stringify(request),
    });
    expect(noOrigin.status).toBe(403);
    const wrongCsrf = await app.request(`${ORIGIN}/api/v1/team/operations/preview`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": "wrong" },
      body: JSON.stringify(request),
    });
    expect(wrongCsrf.status).toBe(403);
    const wrongType = await app.request(`${ORIGIN}/api/v1/team/operations/preview`, {
      method: "POST",
      headers: { ...authenticatedHeaders, "content-type": "text/plain" },
      body: JSON.stringify(request),
    });
    expect(wrongType.status).toBe(400);
    expect(previewTeamOperation).not.toHaveBeenCalled();

    for (const invalid of [
      { ...request, actor: { kind: "unknown" } },
      { ...request, occurredAt: TEAM_NOW },
      { ...request, repoState: { branch: null, head: null, dirty: false } },
      { ...request, unexpected: true },
      {
        operationId: "hub_activity_metadata",
        action: {
          kind: "activity.record",
          activity: {
            action: "review.completed",
            subjects: [],
            metadata: { prompt: "must not cross" },
          },
        },
        expectedRevisions: [],
      },
    ]) {
      const response = await app.request(`${ORIGIN}/api/v1/team/operations/preview`, {
        method: "POST",
        headers: authenticatedHeaders,
        body: JSON.stringify(invalid),
      });
      expect(response.status).toBe(400);
    }
    expect(previewTeamOperation).not.toHaveBeenCalled();

    const preview = await app.request(`${ORIGIN}/api/v1/team/operations/preview`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify(request),
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(previewTeamOperation).toHaveBeenCalledWith(request);
    const envelope = await preview.json();

    const invalidApply = await app.request(`${ORIGIN}/api/v1/team/operations/apply`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify({ ...(envelope as object), unexpected: true }),
    });
    expect(invalidApply.status).toBe(400);
    expect(applyTeamOperation).not.toHaveBeenCalled();

    const applied = await app.request(`${ORIGIN}/api/v1/team/operations/apply`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify(envelope),
    });
    expect(applied.status).toBe(200);
    expect(applied.headers.get("cache-control")).toBe("no-store");
    expect(applyTeamOperation).toHaveBeenCalledWith(envelope);
    expect(await applied.json()).toMatchObject({
      operationId: request.operationId,
      applied: true,
      members: [{ id: TEAM_MEMBER_ID }],
      events: [{ action: "member.added" }],
    });
  });

  it("serves strict Inbox summaries/details and applies only the complete reviewed envelope", async () => {
    const services = inboxReadServices();
    const inboxDrafts = vi.fn(services.inboxDrafts!);
    const inboxDraft = vi.fn(services.inboxDraft!);
    const inboxProposals = vi.fn(services.inboxProposals!);
    const inboxProposal = vi.fn(services.inboxProposal!);
    const previewInboxOperation = vi.fn(services.previewInboxOperation!);
    const applyInboxOperation = vi.fn(services.applyInboxOperation!);
    const app = fixtureApp({
      services: {
        ...services,
        inboxDrafts,
        inboxDraft,
        inboxProposals,
        inboxProposal,
        previewInboxOperation,
        applyInboxOperation,
      },
    });
    const { cookie, csrfToken } = await authenticatedSession(app);
    const readHeaders = { host: HOST, cookie };
    const mutationRequestHeaders = {
      ...mutationHeaders(),
      cookie,
      "x-mex-csrf": csrfToken,
    };

    const drafts = await app.request(`${ORIGIN}/api/v1/inbox/drafts?limit=25`, {
      headers: readHeaders,
    });
    expect(drafts.status).toBe(200);
    expect(drafts.headers.get("cache-control")).toBe("no-store");
    expect(inboxDrafts).toHaveBeenCalledWith({ limit: 25 });
    expect(await drafts.json()).toMatchObject({
      items: [{ id: INBOX_DRAFT_ID, title: "Release benchmark local draft Requirement" }],
    });
    expect((await app.request(`${ORIGIN}/api/v1/inbox/drafts/${INBOX_DRAFT_ID}`, {
      headers: readHeaders,
    })).status).toBe(200);
    expect(inboxDraft).toHaveBeenCalledWith(INBOX_DRAFT_ID);

    const proposals = await app.request(
      `${ORIGIN}/api/v1/inbox/proposals?state=pending,stale&limit=25`,
      { headers: readHeaders },
    );
    expect(proposals.status).toBe(200);
    expect(inboxProposals).toHaveBeenCalledWith({ states: ["pending", "stale"], limit: 25 });
    expect(await proposals.json()).toMatchObject({
      items: [{
        ref: { id: INBOX_PROPOSAL_ID },
        state: "pending",
        title: "Release benchmark pending Spec update",
      }],
    });
    expect((await app.request(`${ORIGIN}/api/v1/inbox/proposals/${INBOX_PROPOSAL_ID}`, {
      headers: readHeaders,
    })).status).toBe(200);
    expect(inboxProposal).toHaveBeenCalledWith(INBOX_PROPOSAL_ID);

    inboxProposals.mockClear();
    for (const path of [
      "/api/v1/inbox/proposals?state=pending,pending",
      "/api/v1/inbox/proposals?state=unknown",
      "/api/v1/inbox/proposals?state=pending&state=stale",
      "/api/v1/inbox/drafts?limit=101",
      "/api/v1/inbox/drafts?unexpected=true",
    ]) {
      expect((await app.request(`${ORIGIN}${path}`, { headers: readHeaders })).status, path)
        .toBe(400);
    }
    expect(inboxProposals).not.toHaveBeenCalled();

    const request = inboxPreviewRequest();
    const invalidAuthority = await app.request(`${ORIGIN}/api/v1/inbox/operations/preview`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify({ ...request, actor: { kind: "unknown" } }),
    });
    expect(invalidAuthority.status).toBe(400);
    expect(previewInboxOperation).not.toHaveBeenCalled();

    const preview = await app.request(`${ORIGIN}/api/v1/inbox/operations/preview`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify(request),
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(previewInboxOperation).toHaveBeenCalledWith(request);
    const envelope = await preview.json();

    const invalidApply = await app.request(`${ORIGIN}/api/v1/inbox/operations/apply`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify({ ...(envelope as object), unexpected: true }),
    });
    expect(invalidApply.status).toBe(400);
    expect(applyInboxOperation).not.toHaveBeenCalled();

    const applied = await app.request(`${ORIGIN}/api/v1/inbox/operations/apply`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify(envelope),
    });
    expect(applied.status).toBe(200);
    expect(applied.headers.get("cache-control")).toBe("no-store");
    expect(applyInboxOperation).toHaveBeenCalledWith(envelope);
    expect(await applied.json()).toMatchObject({
      operationId: request.operationId,
      applied: true,
      localChanges: [{ id: INBOX_DRAFT_ID }],
    });
  });

  it("serves strict private Relay routes and applies only the byte-identical signed envelope", async () => {
    const services = relayReadServices();
    const relayDrafts = vi.fn(services.relayDrafts!);
    const relayDraft = vi.fn(services.relayDraft!);
    const relays = vi.fn(services.relays!);
    const relay = vi.fn(services.relay!);
    const previewRelayOperation = vi.fn(services.previewRelayOperation!);
    const applyRelayOperation = vi.fn(services.applyRelayOperation!);
    const app = fixtureApp({
      services: {
        ...services,
        relayDrafts,
        relayDraft,
        relays,
        relay,
        previewRelayOperation,
        applyRelayOperation,
      },
    });
    expect((await app.request(`${ORIGIN}/api/v1/relays`, { headers: { host: HOST } })).status)
      .toBe(401);
    const { cookie, csrfToken } = await authenticatedSession(app);
    const readHeaders = { host: HOST, cookie };
    const mutationRequestHeaders = {
      ...mutationHeaders(),
      cookie,
      "x-mex-csrf": csrfToken,
    };

    const drafts = await app.request(`${ORIGIN}/api/v1/relays/drafts?limit=25`, { headers: readHeaders });
    expect(drafts.status).toBe(200);
    expect(relayDrafts).toHaveBeenCalledWith({ limit: 25 });
    expect(await drafts.json()).toMatchObject({ items: [{ id: RELAY_DRAFT_ID }] });
    expect((await app.request(`${ORIGIN}/api/v1/relays/drafts/${RELAY_DRAFT_ID}`, { headers: readHeaders })).status).toBe(200);
    expect(relayDraft).toHaveBeenCalledWith(RELAY_DRAFT_ID);

    const maximumDraftId = "d".repeat(128);
    const oversizedDraftId = "d".repeat(129);
    const longDraftDisplayName = "M".repeat(201);
    const maximumDraftDetail = relayDraftDetail();
    const longNameRecipient = {
      ...maximumDraftDetail.recipients[0]!,
      displayName: longDraftDisplayName,
    };
    relayDraft.mockClear();
    relayDraft.mockReturnValueOnce({
      ...maximumDraftDetail,
      id: maximumDraftId,
      recipients: [longNameRecipient],
      input: {
        ...maximumDraftDetail.input,
        recipients: [longNameRecipient],
      },
    });
    const maximumDraftPath = await app.request(
      `${ORIGIN}/api/v1/relays/drafts/${maximumDraftId}`,
      { headers: readHeaders },
    );
    expect(maximumDraftPath.status).toBe(200);
    expect(relayDraft).toHaveBeenCalledWith(maximumDraftId);
    expect(await maximumDraftPath.json()).toMatchObject({
      id: maximumDraftId,
      recipients: [{ displayName: longDraftDisplayName }],
      input: { recipients: [{ displayName: longDraftDisplayName }] },
    });
    relayDraft.mockClear();
    const oversizedDraftPath = await app.request(
      `${ORIGIN}/api/v1/relays/drafts/${oversizedDraftId}`,
      { headers: readHeaders },
    );
    expect(oversizedDraftPath.status).toBe(400);
    expect(relayDraft).not.toHaveBeenCalled();

    const list = await app.request(
      `${ORIGIN}/api/v1/relays?perspective=mine&state=published,acknowledged&workstreamId=${TEAM_WORKSTREAM_ID}&limit=25`,
      { headers: readHeaders },
    );
    expect(list.status).toBe(200);
    expect(relays).toHaveBeenCalledWith({
      perspective: "mine",
      states: ["published", "acknowledged"],
      workstreamId: TEAM_WORKSTREAM_ID,
      limit: 25,
    });
    expect(await list.json()).toMatchObject({
      items: [{ ref: { id: RELAY_ID }, publishedAt: null }],
      diagnostics: [{ code: "RELAY_LEGACY_PUBLICATION_TIME" }],
    });
    const detail = await app.request(`${ORIGIN}/api/v1/relays/${RELAY_ID}`, { headers: readHeaders });
    expect(detail.status).toBe(200);
    expect(relay).toHaveBeenCalledWith(RELAY_ID);
    expect(await detail.json()).toMatchObject({
      ref: { id: RELAY_ID },
      diagnostics: [{
        code: "RELAY_LEGACY_PUBLICATION_TIME",
        message: "One or more legacy schema-v1 Relays have no canonical publication timestamp.",
      }],
    });

    relays.mockClear();
    for (const path of [
      "/api/v1/relays?state=published,published",
      "/api/v1/relays?state=unknown",
      "/api/v1/relays?state=published&state=closed",
      "/api/v1/relays?perspective=mine&unexpected=true",
      "/api/v1/relays/drafts?limit=101",
    ]) {
      expect((await app.request(`${ORIGIN}${path}`, { headers: readHeaders })).status, path).toBe(400);
    }
    expect(relays).not.toHaveBeenCalled();

    const request = relayPreviewRequest();
    const noCsrf = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie },
      body: JSON.stringify(request),
    });
    expect(noCsrf.status).toBe(403);
    const invalidAuthority = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify({ ...request, actor: { kind: "unknown" } }),
    });
    expect(invalidAuthority.status).toBe(400);
    expect(previewRelayOperation).not.toHaveBeenCalled();

    if (request.action.kind !== "relay.draft.save") throw new Error("Expected a Relay draft save request.");
    const draft = request.action.draft;
    for (const malformedDraft of [
      { ...draft, completed: [draft.completed[0], draft.completed[0]] },
      { ...draft, inProgress: [draft.inProgress[0], draft.inProgress[0]] },
      { ...draft, decisions: [draft.decisions[0], { ...draft.decisions[0], title: "Renamed duplicate" }] },
      { ...draft, blockers: ["Repeated blocker", "Repeated blocker"] },
      { ...draft, unresolvedQuestions: ["Repeated question", "Repeated question"] },
      { ...draft, changedFiles: [draft.changedFiles[0], draft.changedFiles[0]] },
      { ...draft, code: [draft.code[0], { ...draft.code[0] }] },
      { ...draft, nextActions: [draft.nextActions[0], draft.nextActions[0]] },
    ]) {
      const malformedSetRequest = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
        method: "POST",
        headers: mutationRequestHeaders,
        body: JSON.stringify({
          ...request,
          action: { ...request.action, draft: malformedDraft },
        }),
      });
      expect(malformedSetRequest.status).toBe(400);
    }
    expect(previewRelayOperation).not.toHaveBeenCalled();

    const reservedEvidence = [
      {
        kind: "entity" as const,
        entity: { kind: "workstream" as const, id: TEAM_WORKSTREAM_ID, title: "Legacy lane" },
      },
      ...Array.from({ length: 64 }, (_, index) => ({
        kind: "manual" as const,
        note: `Legacy evidence ${index}`,
      })),
    ];
    const newReservedDraft = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify({
        ...request,
        operationId: "hub_relay_new_reserved_evidence",
        action: {
          ...request.action,
          draft: { ...draft, evidence: reservedEvidence },
        },
      }),
    });
    expect(newReservedDraft.status).toBe(400);
    expect((await newReservedDraft.json() as { detail: string }).detail).toContain("64");
    expect(previewRelayOperation).not.toHaveBeenCalled();

    const migratedReservedRequest: RelayOperationPreviewRequest = {
      ...request,
      operationId: "hub_relay_existing_reserved_evidence",
      action: {
        kind: "relay.draft.save",
        draftId: RELAY_DRAFT_ID,
        draft: { ...draft, evidence: reservedEvidence },
      },
      expectedRevisions: [{
        target: { kind: "local", namespace: "relay-draft", id: RELAY_DRAFT_ID },
        revision: relayDraftDetail().revision,
      }],
    };
    const migratedReservedDraft = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify(migratedReservedRequest),
    });
    expect(migratedReservedDraft.status).toBe(200);
    expect(previewRelayOperation).toHaveBeenCalledWith(migratedReservedRequest);
    previewRelayOperation.mockClear();

    const maximumDraftMutation: RelayOperationPreviewRequest = {
      operationId: "hub_relay_draft_id_boundary",
      action: { kind: "relay.draft.delete", draftId: maximumDraftId },
      expectedRevisions: [{
        target: { kind: "local", namespace: "relay-draft", id: maximumDraftId },
        revision: relayDraftDetail().revision,
      }],
    };
    const maximumDraftPreview = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify(maximumDraftMutation),
    });
    expect(maximumDraftPreview.status).toBe(200);
    expect(previewRelayOperation).toHaveBeenCalledWith(maximumDraftMutation);
    previewRelayOperation.mockClear();
    const oversizedDraftMutation = {
      ...maximumDraftMutation,
      action: { ...maximumDraftMutation.action, draftId: oversizedDraftId },
      expectedRevisions: [{
        ...maximumDraftMutation.expectedRevisions[0]!,
        target: { ...maximumDraftMutation.expectedRevisions[0]!.target, id: oversizedDraftId },
      }],
    };
    const oversizedDraftPreview = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify(oversizedDraftMutation),
    });
    expect(oversizedDraftPreview.status).toBe(400);
    expect(previewRelayOperation).not.toHaveBeenCalled();

    const draftExpectation = {
      target: { kind: "local" as const, namespace: "relay-draft" as const, id: RELAY_DRAFT_ID },
      revision: relayDraftDetail().revision,
    };
    const workstreamExpectation = {
      target: { kind: "artifact" as const, path: `.mex/workstreams/${TEAM_WORKSTREAM_ID}.md` },
      revision: "a".repeat(64),
    };
    const memberExpectation = {
      target: { kind: "artifact" as const, path: `.mex/team/members/${TEAM_MEMBER_ID}.md` },
      revision: "b".repeat(64),
    };
    const publishRequest: RelayOperationPreviewRequest = {
      operationId: "hub_relay_publish",
      action: { kind: "relay.publish", draftId: RELAY_DRAFT_ID },
      expectedRevisions: [memberExpectation, draftExpectation],
    };
    for (const [label, expectedRevisions] of [
      ["missing local draft", [memberExpectation]],
      ["legacy Workstream dependency", [draftExpectation, memberExpectation, workstreamExpectation]],
      ["unrelated artifact", [draftExpectation, memberExpectation, {
        target: { kind: "artifact" as const, path: "README.md" },
        revision: "c".repeat(64),
      }]],
    ] as const) {
      const malformed = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
        method: "POST",
        headers: mutationRequestHeaders,
        body: JSON.stringify({ ...publishRequest, expectedRevisions }),
      });
      expect(malformed.status, label).toBe(400);
      if (label === "legacy Workstream dependency") {
        expect((await malformed.json() as { detail: string }).detail)
          .toContain("Preview again with the current MEX version");
      }
    }
    expect(previewRelayOperation).not.toHaveBeenCalled();

    previewRelayOperation.mockImplementationOnce((received) => {
      const envelope = relayPreviewEnvelope(received);
      return {
        ...envelope,
        preview: {
          ...envelope.preview,
          scope: "mixed",
          diagnostics: [{
            code: "RELAY_DIRTY_PUBLICATION_STATE",
            severity: "warning",
            message: RELAY_DIRTY_PUBLICATION_WARNING,
          }],
        },
      };
    });
    const reorderedPublish = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify(publishRequest),
    });
    expect(reorderedPublish.status).toBe(200);
    expect(previewRelayOperation).toHaveBeenCalledWith(publishRequest);
    expect(await reorderedPublish.json()).toMatchObject({
      preview: {
        diagnostics: [{
          code: "RELAY_DIRTY_PUBLICATION_STATE",
          severity: "warning",
          message: RELAY_DIRTY_PUBLICATION_WARNING,
        }],
      },
    });
    previewRelayOperation.mockClear();

    // Open-to-team publication has only a local draft expectation. Recipient
    // requirements for named drafts are checked against the stored audience.
    const teamPublish = { ...publishRequest, expectedRevisions: [draftExpectation] };
    const teamPublishResponse = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
      method: "POST", headers: mutationRequestHeaders, body: JSON.stringify(teamPublish),
    });
    expect(teamPublishResponse.status).toBe(200);
    expect(previewRelayOperation).toHaveBeenCalledWith(teamPublish);
    previewRelayOperation.mockClear();

    const preview = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify(request),
    });
    expect(preview.status).toBe(200);
    const envelope = await preview.json();
    expect(previewRelayOperation).toHaveBeenCalledWith(request);
    const invalidApply = await app.request(`${ORIGIN}/api/v1/relays/operations/apply`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify({ ...(envelope as object), unexpected: true }),
    });
    expect(invalidApply.status).toBe(400);
    expect(applyRelayOperation).not.toHaveBeenCalled();
    const wrongPurposeApply = await app.request(`${ORIGIN}/api/v1/relays/operations/apply`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: JSON.stringify({
        ...(envelope as RelayOperationPreviewResponse),
        receipt: { ...(envelope as RelayOperationPreviewResponse).receipt, purposeIds: [] },
      }),
    });
    expect(wrongPurposeApply.status).toBe(400);
    expect(applyRelayOperation).not.toHaveBeenCalled();

    const envelopeBytes = JSON.stringify(envelope);
    const applied = await app.request(`${ORIGIN}/api/v1/relays/operations/apply`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: envelopeBytes,
    });
    expect(applied.status).toBe(200);
    expect(JSON.stringify(applyRelayOperation.mock.calls[0]![0])).toBe(envelopeBytes);
    expect(await applied.json()).toMatchObject({
      operationId: request.operationId,
      applied: true,
      localChanges: [{ id: RELAY_DRAFT_ID }],
    });

    applyRelayOperation.mockClear();
    const legacyPublishRequest: RelayOperationPreviewRequest = {
      operationId: "hub_relay_journaled_legacy_publish",
      action: { kind: "relay.publish", draftId: RELAY_DRAFT_ID },
      expectedRevisions: [
        {
          target: { kind: "local", namespace: "relay-draft", id: RELAY_DRAFT_ID },
          revision: relayDraftDetail().revision,
        },
        {
          target: { kind: "artifact", path: `.mex/team/members/${TEAM_MEMBER_ID}.md` },
          revision: "b".repeat(64),
        },
        {
          target: { kind: "artifact", path: `.mex/workstreams/${TEAM_WORKSTREAM_ID}.md` },
          revision: "c".repeat(64),
        },
      ],
    };
    const legacyEnvelope = relayPreviewEnvelope(legacyPublishRequest);
    const legacyEnvelopeBytes = JSON.stringify(legacyEnvelope);
    const recoveredLegacyApply = await app.request(`${ORIGIN}/api/v1/relays/operations/apply`, {
      method: "POST",
      headers: mutationRequestHeaders,
      body: legacyEnvelopeBytes,
    });
    expect(recoveredLegacyApply.status).toBe(200);
    expect(JSON.stringify(applyRelayOperation.mock.calls[0]![0])).toBe(legacyEnvelopeBytes);
    expect(await recoveredLegacyApply.json()).toMatchObject({
      operationId: legacyPublishRequest.operationId,
      applied: true,
    });
  });

  it("round-trips 512-byte Relay service Member authority and Activity actors", async () => {
    const services = relayReadServices();
    const actor = {
      kind: "member" as const,
      memberId: TEAM_MEMBER_ID,
      displayName: "S".repeat(512),
    };
    const previewRelayOperation = vi.fn((request: RelayOperationPreviewRequest) => {
      const envelope = relayPreviewEnvelope(request);
      return {
        ...envelope,
        preview: { ...envelope.preview, scope: "mixed" as const },
        receipt: {
          ...envelope.receipt,
          authority: { ...envelope.receipt.authority, actor },
        },
      };
    });
    const applyRelayOperation = vi.fn((request: RelayOperationPreviewResponse): RelayOperationApplyResponse => ({
      ...relayApplyResult(request),
      events: [{
        schemaVersion: 1,
        id: "event_01000000000000000000000001",
        timestamp: TEAM_NOW,
        actor,
        action: "relay.published",
        subjects: [{ kind: "entity", entity: { id: RELAY_ID, kind: "relay" } }],
        workstream: { kind: "workstream", id: TEAM_WORKSTREAM_ID, title: "Checkpoint D" },
        repoState: request.receipt.authority.repoState,
      }],
    }));
    const app = fixtureApp({
      services: { ...services, previewRelayOperation, applyRelayOperation },
    });
    const { cookie, csrfToken } = await authenticatedSession(app);
    const headers = { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken };
    const request: RelayOperationPreviewRequest = {
      operationId: "hub_relay_long_service_actor",
      action: { kind: "relay.publish", draftId: RELAY_DRAFT_ID },
      expectedRevisions: [{
        target: { kind: "local", namespace: "relay-draft", id: RELAY_DRAFT_ID },
        revision: relayDraftDetail().revision,
      }, {
        target: { kind: "artifact", path: `.mex/team/members/${TEAM_MEMBER_ID}.md` },
        revision: "b".repeat(64),
      }],
    };

    const preview = await app.request(`${ORIGIN}/api/v1/relays/operations/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    expect(preview.status).toBe(200);
    const envelope = await preview.json() as RelayOperationPreviewResponse;
    expect(envelope.receipt.authority.actor).toEqual(actor);

    const apply = await app.request(`${ORIGIN}/api/v1/relays/operations/apply`, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    });
    expect(apply.status).toBe(200);
    expect(JSON.stringify(applyRelayOperation.mock.calls[0]![0])).toBe(JSON.stringify(envelope));
    expect(await apply.json()).toMatchObject({ events: [{ actor }] });
  });

  it("dual-reads bounded legacy Relay actor, recipient, Workstream, and path domains", async () => {
    const services = relayReadServices();
    const legacy = legacyRelayDetail();
    const relays = vi.fn(() => legacyRelayPage());
    const relay = vi.fn((relayId: string) => relayId === RELAY_ID ? legacy : null);
    const app = fixtureApp({ services: { ...services, relays, relay } });
    const { cookie } = await authenticatedSession(app);
    const headers = { host: HOST, cookie };

    const list = await app.request(
      `${ORIGIN}/api/v1/relays?perspective=all&limit=25`,
      { headers },
    );
    expect(list.status).toBe(200);
    expect(relays).toHaveBeenCalledWith({ perspective: "all", limit: 25 });
    const listBody = await list.json() as {
      items: Array<{ recipients: unknown[] }>;
    };
    expect(listBody.items[0]!.recipients).toHaveLength(64);
    expect(listBody.items[0]).toMatchObject({
      schemaVersion: 1,
      sender: { kind: "member", displayName: "M".repeat(201) },
      workstream: { id: "historical-workstream" },
    });
    expect(listBody.items[0]!.recipients[0]).toMatchObject({
      kind: "git",
      name: "G".repeat(321),
    });

    const detail = await app.request(`${ORIGIN}/api/v1/relays/${RELAY_ID}`, { headers });
    expect(detail.status).toBe(200);
    expect(relay).toHaveBeenCalledWith(RELAY_ID);
    const detailBody = await detail.json() as { recipients: unknown[] };
    expect(detailBody.recipients).toHaveLength(64);
    expect(detailBody).toMatchObject({
      changedFiles: ["src/legacy\u0085relay\u2028snapshot.ts"],
      code: [{ kind: "file", path: "src/legacy\u0085relay\u2028snapshot.ts" }],
      evidence: [
        { kind: "file", path: "src/legacy\u0085relay\u2028snapshot.ts" },
        { kind: "code", code: { kind: "file", path: "src/legacy\u0085relay\u2028snapshot.ts" } },
      ],
    });
  });

  it("bounds team mutation bodies and exposes absent seams as unavailable", async () => {
    const unavailableApp = fixtureApp();
    const unavailableSession = await authenticatedSession(unavailableApp);
    expect(await (await unavailableApp.request(`${ORIGIN}/api/v1/capabilities`, {
      headers: { host: HOST, cookie: unavailableSession.cookie },
    })).json()).toMatchObject({
      activityRecord: { availability: "unavailable" },
      members: {
        read: { availability: "unavailable" },
        canonicalMutation: { availability: "unavailable" },
        localSelection: { availability: "unavailable" },
      },
    });
    const read = await unavailableApp.request(`${ORIGIN}/api/v1/members`, {
      headers: { host: HOST, cookie: unavailableSession.cookie },
    });
    expect(read.status).toBe(503);
    expect(await read.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    const previewUnavailable = await unavailableApp.request(
      `${ORIGIN}/api/v1/team/operations/preview`,
      {
        method: "POST",
        headers: {
          ...mutationHeaders(),
          cookie: unavailableSession.cookie,
          "x-mex-csrf": unavailableSession.csrfToken,
        },
        body: JSON.stringify(teamPreviewRequest()),
      },
    );
    expect(previewUnavailable.status).toBe(503);
    expect(await previewUnavailable.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

    const services = teamReadServices();
    const previewTeamOperation = vi.fn(services.previewTeamOperation!);
    const app = fixtureApp({ services: { ...services, previewTeamOperation } });
    const { cookie, csrfToken } = await authenticatedSession(app);
    const oversized = await app.request(`${ORIGIN}/api/v1/team/operations/preview`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken },
      body: JSON.stringify({ ...teamPreviewRequest(), padding: "x".repeat(70_000) }),
    });
    expect(oversized.status).toBe(400);
    expect((await oversized.json() as { detail: string }).detail).toContain("64 KiB");
    expect(previewTeamOperation).not.toHaveBeenCalled();
  });

  it("fails closed on invalid team responses and projects team failures safely", async () => {
    const services = teamReadServices();
    const invalidResponseApp = fixtureApp({
      services: {
        ...services,
        member: () => ({ ...teamMember(), secret: "/Users/alice/private" }) as never,
      },
    });
    const invalidSession = await authenticatedSession(invalidResponseApp);
    const invalid = await invalidResponseApp.request(
      `${ORIGIN}/api/v1/members/${TEAM_MEMBER_ID}`,
      { headers: { host: HOST, cookie: invalidSession.cookie } },
    );
    expect(invalid.status).toBe(500);
    expect(await invalid.text()).not.toContain("/Users/alice");

    const safeFailureApp = fixtureApp({
      services: {
        ...services,
        previewTeamOperation: () => {
          const error = new Error("stale /Users/alice/private member body") as Error & {
            problem: Record<string, unknown>;
          };
          error.problem = {
            status: 409,
            code: "REVISION_CONFLICT",
            title: "unsafe",
            detail: error.message,
          };
          throw error;
        },
      },
    });
    const safeSession = await authenticatedSession(safeFailureApp);
    const response = await safeFailureApp.request(`${ORIGIN}/api/v1/team/operations/preview`, {
      method: "POST",
      headers: {
        ...mutationHeaders(),
        cookie: safeSession.cookie,
        "x-mex-csrf": safeSession.csrfToken,
      },
      body: JSON.stringify(teamPreviewRequest()),
    });
    const problem = await response.json() as { code: string; detail: string };
    expect(response.status).toBe(409);
    expect(problem).toEqual(expect.objectContaining({
      code: "REVISION_CONFLICT",
      detail: "The local state changed before the operation completed; refresh and retry.",
    }));
    expect(JSON.stringify(problem)).not.toContain("/Users/");
  });

  it("projects stale Activity cursors as a safe revision conflict", async () => {
    const services = readServices();
    const app = fixtureApp({
      services: {
        ...services,
        activity: () => {
          const error = new Error("stale cursor exposed /Users/alice/private") as Error & {
            problem: Record<string, unknown>;
          };
          error.problem = {
            status: 409,
            code: "REVISION_CONFLICT",
            title: "Timeline changed",
            detail: "stale cursor exposed /Users/alice/private",
          };
          throw error;
        },
      },
    });
    const { cookie } = await bootstrapSession(app);
    const response = await app.request(`${ORIGIN}/api/v1/activity?cursor=stale`, {
      headers: { host: HOST, cookie },
    });
    const body = await response.json() as { code: string; detail: string };
    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      code: "REVISION_CONFLICT",
      detail: "The local state changed before the operation completed; refresh and retry.",
    });
    expect(JSON.stringify(body)).not.toContain("/Users/");
  });

  it("does not expose unregistered production jobs", async () => {
    const app = fixtureApp();
    const { cookie } = await bootstrapSession(app);
    const jobs = await app.request(`${ORIGIN}/api/v1/jobs`, {
      headers: { host: HOST, cookie },
    });
    expect(jobs.status).toBe(503);
    expect((await jobs.json() as { code: string }).code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("rejects malicious identifiers and oversized streamed bodies", async () => {
    const app = fixtureApp({ jobs: jobService() });
    const { cookie } = await bootstrapSession(app);
    const invalidId = await app.request(`${ORIGIN}/api/v1/jobs/not%2Fa%2Fjob`, {
      headers: { host: HOST, cookie },
    });
    expect([400, 404]).toContain(invalidId.status);
    const overflowUlid = await app.request(
      `${ORIGIN}/api/v1/jobs/job_8${"0".repeat(25)}`,
      { headers: { host: HOST, cookie } },
    );
    expect(overflowUlid.status).toBe(400);
    expect((await overflowUlid.json() as { code: string }).code).toBe("INVALID_REQUEST");

    const sessionResponse = await app.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie },
    });
    const { csrfToken } = await sessionResponse.json() as { csrfToken: string };
    const oversized = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken },
      body: JSON.stringify({ kind: "graph_refresh", padding: "x".repeat(70_000) }),
    });
    expect(oversized.status).toBe(400);
    expect((await oversized.json() as { detail: string }).detail).toContain("64 KiB");
  });

  it("preserves the active job ID in bounded contention problems", async () => {
    const baseJobs = jobService();
    const app = fixtureApp({
      jobs: {
        ...baseJobs,
        start: () => {
          const error = new Error("already active") as Error & { problem: Record<string, unknown> };
          error.problem = {
            status: 409,
            code: "JOB_ALREADY_RUNNING",
            title: "Job already running",
            detail: "An index-mutating job is already active.",
            activeJobId: JOB_ID,
          };
          throw error;
        },
      },
    });
    const { cookie } = await bootstrapSession(app);
    const sessionResponse = await app.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie },
    });
    const { csrfToken } = await sessionResponse.json() as { csrfToken: string };
    const response = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken },
      body: JSON.stringify({ kind: "graph_refresh" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "JOB_ALREADY_RUNNING",
      activeJobId: JOB_ID,
    });
  });

  it("streams one terminal event from the injected job manager", async () => {
    const app = fixtureApp({ jobs: jobService("succeeded") });
    const { cookie } = await bootstrapSession(app);
    const response = await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/events`, {
      headers: { host: HOST, cookie },
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain("event: terminal");
    expect(stream.match(/event: terminal/g)).toHaveLength(1);
  });

  it("ends an open event stream at the absolute session deadline", async () => {
    vi.useFakeTimers();
    try {
      let now = Date.parse("2026-08-23T00:00:00.000Z");
      let subscriptions = 0;
      const baseJobs = jobService("running");
      const jobs: HubJobService = {
        ...baseJobs,
        subscribe: (id, listener) => {
          subscriptions += 1;
          const unsubscribe = baseJobs.subscribe(id, listener);
          return () => {
            unsubscribe();
            subscriptions -= 1;
          };
        },
      };
      const app = fixtureApp({
        jobs,
        now: () => now,
        sessionTtlMs: 1_000,
      });
      const { cookie } = await bootstrapSession(app);
      const response = await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/events`, {
        headers: { host: HOST, cookie },
      });
      const body = response.text();
      expect(response.status).toBe(200);
      expect(subscriptions).toBe(1);

      now += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await body).toContain("event: snapshot");
      expect(subscriptions).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects HEAD event streams before reserving a subscriber", async () => {
    let subscriptions = 0;
    const baseJobs = jobService("running");
    const app = fixtureApp({
      jobs: {
        ...baseJobs,
        subscribe: (id, listener) => {
          subscriptions += 1;
          return baseJobs.subscribe(id, listener);
        },
      },
    });
    const { cookie } = await bootstrapSession(app);
    const response = await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/events`, {
      method: "HEAD",
      headers: { host: HOST, cookie },
    });

    expect(response.status).toBe(405);
    expect(response.body).toBeNull();
    expect(subscriptions).toBe(0);
  });

  it("caps concurrent event-stream subscribers per job", async () => {
    const app = fixtureApp({ jobs: jobService("running") });
    const { cookie } = await bootstrapSession(app);
    const controllers: AbortController[] = [];
    const responses: Response[] = [];
    try {
      for (let index = 0; index < 8; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        responses.push(await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/events`, {
          headers: { host: HOST, cookie },
          signal: controller.signal,
        }));
      }
      expect(responses.every((response) => response.status === 200)).toBe(true);
      const limited = await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/events`, {
        headers: { host: HOST, cookie },
      });
      expect(limited.status).toBe(429);
      expect((await limited.json() as { code: string }).code).toBe("RATE_LIMITED");
    } finally {
      for (const controller of controllers) controller.abort();
      for (const response of responses) await response.body?.cancel().catch(() => undefined);
    }
  });

  it("serves the bounded Overview aggregate through its dedicated route", async () => {
    const app = fixtureApp();
    const { cookie } = await bootstrapSession(app);
    const response = await app.request(`${ORIGIN}/api/v1/overview`, {
      headers: { host: HOST, cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      shell: { repository: { scaffoldId: "mex" } },
      identity: { availability: "unavailable" },
      focus: { availability: "unavailable" },
      activity: { availability: "available", items: [] },
      context: { availability: "unavailable" },
      operation: { availability: "available", active: null, latestRelevantFailure: null },
    });
  });

  it.each([
    {
      status: 400,
      code: "PATH_OUTSIDE_PROJECT",
      expectedDetail: "The local operation refused a path outside the project boundary.",
    },
    {
      status: 500,
      code: "INTERNAL_ERROR",
      expectedDetail: "The local Hub could not complete the request.",
    },
  ] as const)("projects $code adapter failures without raw details", async ({
    status,
    code,
    expectedDetail,
  }) => {
    const baseServices = readServices();
    const app = fixtureApp({
      services: {
        ...baseServices,
        home: () => {
          const error = new Error("unsafe adapter detail") as Error & {
            problem: Record<string, unknown>;
          };
          error.problem = {
            status,
            code,
            title: "fatal: raw Git failure",
            detail: "fatal: bad config in /Users/alice/private-project/.git/config",
            activeJobId: JOB_ID,
          };
          throw error;
        },
      },
    });
    const { cookie } = await bootstrapSession(app);
    const response = await app.request(`${ORIGIN}/api/v1/home`, {
      headers: { host: HOST, cookie },
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(status);
    expect(body).toMatchObject({ code, status, detail: expectedDetail });
    expect(body).not.toHaveProperty("activeJobId");
    expect(JSON.stringify(body)).not.toContain("/Users/");
    expect(JSON.stringify(body)).not.toContain("raw Git");
    expect(JSON.stringify(body)).not.toContain("bad config");
  });

  it("serves only fixed assets and uses the shell for HTML navigation", async () => {
    const assets = assetManifest();
    const app = fixtureApp({ assets });
    const shell = await app.request(`${ORIGIN}/search`, {
      headers: { host: HOST, accept: "text/html" },
    });
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toBe("no-store");
    expect(await shell.text()).toContain("Project Hub");

    const missing = await app.request(`${ORIGIN}/assets/not-declared.js`, {
      headers: { host: HOST, accept: "*/*" },
    });
    expect(missing.status).toBe(404);
  });
});

function fixtureApp(overrides: {
  jobs?: HubJobService;
  assets?: HubAssetManifest;
  services?: HubReadServices;
  now?: () => number;
  sessionTtlMs?: number;
  sessionCookieSuffix?: string;
  randomStart?: number;
  telemetry?: HubTelemetrySink;
} = {}) {
  let random = overrides.randomStart ?? 20;
  return createHubApp({
    security: new HubSessionManager({
      bootstrapToken: BOOTSTRAP,
      expectedOrigin: ORIGIN,
      random: (size) => new Uint8Array(size).fill(random++),
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
      ...(overrides.sessionTtlMs === undefined
        ? {}
        : { sessionTtlMs: overrides.sessionTtlMs }),
      ...(overrides.sessionCookieSuffix === undefined
        ? {}
        : { sessionCookieSuffix: overrides.sessionCookieSuffix }),
    }),
    services: overrides.services ?? readServices(),
    jobs: overrides.jobs,
    telemetry: overrides.telemetry,
    assets: overrides.assets,
    requestId: () => "00000000-0000-4000-8000-000000000001",
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}

async function bootstrapSession(app: ReturnType<typeof fixtureApp>) {
  const response = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, mutation({
    token: BOOTSTRAP,
  }));
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("bootstrap did not set a cookie");
  return { response, cookie };
}

async function authenticatedSession(app: ReturnType<typeof fixtureApp>) {
  const { response, cookie } = await bootstrapSession(app);
  if (response.status !== 201) throw new Error("bootstrap failed");
  const session = await app.request(`${ORIGIN}/api/v1/session`, {
    headers: { host: HOST, cookie },
  });
  const { csrfToken } = await session.json() as { csrfToken: string };
  return { cookie, csrfToken };
}

function mutation(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify(body),
  };
}

function mutationHeaders(): Record<string, string> {
  return { host: HOST, origin: ORIGIN, "content-type": "application/json" };
}

function readServices(): HubReadServices {
  const unavailable = { availability: "unavailable", reason: "The adapter is not connected." } as const;
  const capabilities: HubCapabilities = {
    apiVersion: "v1",
    git: { availability: "available" },
    activity: { availability: "available" },
    activityRecord: unavailable,
    members: {
      read: unavailable,
      canonicalMutation: unavailable,
      localSelection: unavailable,
    },
    workstreams: { read: unavailable, canonicalMutation: unavailable },
    specs: { read: unavailable },
    inbox: {
      read: unavailable,
      draftMutation: unavailable,
      proposalMutation: unavailable,
      specApproval: unavailable,
    },
    relays: {
      read: unavailable,
      draftMutation: unavailable,
      publish: unavailable,
      lifecycleMutation: unavailable,
    },
    jobs: { availability: "available" },
    graph: { read: unavailable, refresh: unavailable, rebuild: unavailable },
    wiki: { read: unavailable, refresh: unavailable, rebuild: unavailable },
  };
  const home: HomeResponse = {
    observedAt: "2026-08-23T00:00:00.000Z",
    repository: {
      scaffoldId: "mex",
      name: "mex",
      branch: "feat/project-hub-foundation",
      head: "a".repeat(40),
      dirty: false,
    },
    actor: { kind: "unknown" },
    attention: {
      relays: { availability: "unavailable", reason: "Relays are not connected." },
      inbox: { availability: "unavailable", reason: "Inbox is not connected." },
    },
    jobs: { availability: "available", activeCount: 0 },
  };
  const health: HealthResponse = {
    status: "degraded",
    observedAt: "2026-08-23T00:00:00.000Z",
    components: [{
      id: "git",
      label: "Git repository",
      status: "healthy",
      summary: "Repository state is available.",
      diagnostics: [],
    }, {
      id: "graph",
      label: "Code graph",
      status: "unavailable",
      summary: "Graph status is not connected in Lane B.",
      diagnostics: [],
    }],
  };
  const overview: OverviewResponse = {
    observedAt: home.observedAt,
    shell: home,
    identity: {
      availability: "unavailable",
      observedAt: home.observedAt,
      reason: "Current team identity is unavailable in this fixture.",
    },
    focus: {
      availability: "unavailable",
      observedAt: home.observedAt,
      reason: "Personal focus sources are unavailable in this fixture.",
    },
    activity: {
      availability: "available",
      observedAt: home.observedAt,
      items: [],
      nextCursor: null,
      hasMore: false,
      sourceTruncated: false,
      deterministicRevision: "a".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    },
    context: {
      availability: "unavailable",
      observedAt: home.observedAt,
      reason: "Graph and Wiki are unavailable in this fixture.",
    },
    operation: {
      availability: "available",
      observedAt: home.observedAt,
      active: null,
      latestRelevantFailure: null,
    },
  };
  return {
    capabilities: () => capabilities,
    home: () => home,
    overview: () => overview,
    activity: () => ({
      items: [],
      nextCursor: null,
      hasMore: false,
      sourceTruncated: false,
      deterministicRevision: "a".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    }),
    search: (request: SearchRequest) => ({
      query: request.q,
      observedAt: "2026-08-23T00:00:00.000Z",
      groups: {
        wiki: unavailableSearch(),
        symbols: {
          status: "available",
          items: [{
            id: "symbol:router",
            kind: "code_symbol",
            symbolKind: "function",
            name: "Router",
            qualifiedName: "Router",
            language: "typescript",
            path: "src/router.ts",
            startLine: 1,
            endLine: 4,
            route: "/code/symbols/symbol%3Arouter",
          }],
          nextCursor: null,
          truncated: false,
          revision: "b".repeat(64),
        },
        sources: unavailableSearch(),
      },
    }),
    codeSymbol: (symbolId, request) => ({
      revision: "b".repeat(64),
      symbol: {
        id: symbolId,
        symbolKind: "function",
        name: "Router",
        qualifiedName: "Router",
        language: "typescript",
        path: "src/router.ts",
        startLine: 1,
        endLine: 4,
        route: `/code/symbols/${encodeURIComponent(symbolId)}`,
      },
      source: { items: [], nextCursor: null, truncated: false },
      view: request.view,
      traversal: request.view === "callers" || request.view === "callees"
        ? { view: request.view, items: [], nextCursor: null, truncated: false }
        : request.view === "impact"
          ? {
              view: "impact",
              targetId: symbolId,
              roots: [],
              impacted: [],
              relations: [],
              truncated: false,
            }
          : { view: "overview" },
    }),
    health: () => health,
  };
}

function teamReadServices(): HubReadServices {
  const base = readServices();
  return {
    ...base,
    capabilities: async () => ({
      ...await base.capabilities(),
      activityRecord: { availability: "available" },
      members: {
        read: { availability: "available" },
        canonicalMutation: { availability: "available" },
        localSelection: { availability: "available" },
      },
    }),
    members: () => ({
      items: [teamMember()],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "b".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    }),
    member: (memberId) => memberId === TEAM_MEMBER_ID ? teamMember() : null,
    currentActor: () => ({
      actor: { kind: "member", memberId: TEAM_MEMBER_ID, displayName: "Ada Lovelace" },
      source: "configured-member",
      selection: {
        memberId: TEAM_MEMBER_ID,
        updatedAt: TEAM_NOW,
        revision: "c".repeat(64),
      },
      diagnostics: [],
      diagnosticsTruncated: false,
    }),
    previewTeamOperation: (request) => teamPreviewEnvelope(request),
    applyTeamOperation: (request) => teamApplyResult(request),
  };
}

function inboxReadServices(): HubReadServices {
  const base = readServices();
  return {
    ...base,
    capabilities: async () => ({
      ...await base.capabilities(),
      inbox: {
        read: { availability: "available" },
        draftMutation: { availability: "available" },
        proposalMutation: { availability: "available" },
        specApproval: { availability: "available" },
      },
    }),
    inboxDrafts: () => inboxDraftPage(),
    inboxDraft: (draftId) => draftId === INBOX_DRAFT_ID ? inboxDraftDetail() : null,
    inboxProposals: () => inboxProposalPage(),
    inboxProposal: (proposalId) => proposalId === INBOX_PROPOSAL_ID
      ? inboxProposalDetail()
      : null,
    previewInboxOperation: (request) => inboxPreviewEnvelope(request),
    applyInboxOperation: (request) => inboxApplyResult(request),
  };
}

function inboxDraftDetail(): InboxDraftDetail {
  return {
    id: INBOX_DRAFT_ID,
    revision: "2".repeat(64),
    updatedAt: TEAM_NOW,
    changeKind: "spec.create",
    entityKind: "requirement",
    title: "Release benchmark local draft Requirement",
    rationaleExcerpt: "Review the local draft before publication.",
    input: {
      change: {
        kind: "spec.create",
        entityKind: "requirement",
        title: "Release benchmark local draft Requirement",
        body: "The benchmark body stays local.\n\nIt is multiline.",
        status: "in_flight",
      },
      rationale: "Review the local draft before publication.\nPreserve this second line.",
      evidence: [],
      targetRevisions: [],
    },
  };
}

function inboxDraftPage(): InboxDraftListResponse {
  const { input: _input, ...summary } = inboxDraftDetail();
  return {
    items: [summary],
    nextCursor: null,
    truncated: false,
    sourceTruncated: false,
    deterministicRevision: "3".repeat(64),
    diagnostics: [],
    diagnosticsTruncated: false,
  };
}

function inboxProposalDetail(): InboxProposalDetail {
  return {
    schemaVersion: 1,
    ref: { id: INBOX_PROPOSAL_ID, kind: "proposal" },
    sourcePath: `.mex/inbox/${INBOX_PROPOSAL_ID}.md`,
    revision: "4".repeat(64),
    state: "pending",
    author: { kind: "unknown" },
    changeKind: "spec.update",
    entityKind: "spec",
    title: "Release benchmark pending Spec update",
    rationaleExcerpt: "Review the exact Spec update.",
    change: {
      kind: "spec.update",
      target: { id: SPEC_ID, kind: "spec", title: "Checkpoint D" },
      patch: { summary: "Reviewed through Inbox." },
    },
    rationale: "Review the exact Spec update.",
    evidence: [],
    targetRevisions: [{
      target: { kind: "entity", id: SPEC_ID },
      revision: "5".repeat(64),
      semanticRevision: 1,
    }],
  };
}

function inboxProposalPage(): InboxProposalListResponse {
  const {
    change: _change,
    rationale: _rationale,
    evidence: _evidence,
    targetRevisions: _targetRevisions,
    reviewRationale: _reviewRationale,
    ...summary
  } = inboxProposalDetail();
  return {
    items: [summary],
    nextCursor: null,
    truncated: false,
    sourceTruncated: false,
    deterministicRevision: "6".repeat(64),
    diagnostics: [],
    diagnosticsTruncated: false,
  };
}

function inboxPreviewRequest(): InboxOperationPreviewRequest {
  return {
    operationId: "hub_inbox_draft_save",
    action: {
      kind: "inbox.draft.save",
      draft: inboxDraftDetail().input,
    },
    expectedRevisions: [],
  };
}

function inboxPreviewEnvelope(
  request: InboxOperationPreviewRequest = inboxPreviewRequest(),
): InboxOperationPreviewResponse {
  return {
    schemaVersion: 1,
    request,
    preview: {
      valid: true,
      scope: "local",
      changes: [],
      localChanges: [{
        namespace: "inbox-draft",
        id: INBOX_DRAFT_ID,
        beforeRevision: null,
        afterRevision: inboxDraftDetail().revision,
        summary: "Create one checkout-local Inbox draft.",
      }],
      diagnostics: [],
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: { kind: "unknown" },
        occurredAt: TEAM_NOW,
        repoState: {
          branch: "feature/inbox",
          head: "d".repeat(40),
          dirty: false,
          observedAt: TEAM_NOW,
        },
      },
      purposeIds: [{ purpose: "inbox-draft", id: INBOX_DRAFT_ID }],
      requestRevision: "7".repeat(64),
      presentationRevision: "8".repeat(64),
      previewRevision: "9".repeat(64),
    },
  };
}

function inboxApplyResult(
  request: InboxOperationPreviewResponse = inboxPreviewEnvelope(),
): InboxOperationApplyResponse {
  return {
    operationId: request.request.operationId,
    previewRevision: request.receipt.previewRevision,
    applied: true,
    idempotentReplay: false,
    changes: request.preview.changes,
    localChanges: request.preview.localChanges,
    proposals: [],
    events: [],
  };
}

function relayReadServices(): HubReadServices {
  const base = readServices();
  return {
    ...base,
    capabilities: async () => ({
      ...await base.capabilities(),
      relays: {
        read: { availability: "available" },
        draftMutation: { availability: "available" },
        publish: { availability: "available" },
        lifecycleMutation: { availability: "available" },
      },
    }),
    relayDrafts: () => relayDraftPage(),
    relayDraft: (draftId) => draftId === RELAY_DRAFT_ID ? relayDraftDetail() : null,
    relays: () => relayPage(),
    relay: (relayId) => relayId === RELAY_ID ? relayDetail() : null,
    previewRelayOperation: (request) => relayPreviewEnvelope(request),
    applyRelayOperation: (request) => relayApplyResult(request),
  };
}

function relayInput() {
  return {
    recipients: [{ kind: "member" as const, memberId: TEAM_MEMBER_ID, displayName: "Ada Lovelace" }],
    summary: "Carry the release evidence through the final gate.",
    completed: ["The deterministic fixture is stable."],
    inProgress: ["Review the final gate."],
    decisions: [{ id: SPEC_ID, kind: "decision", title: "Keep the runner pinned" }],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: ["src/hub/app.ts"],
    code: [{ kind: "file" as const, path: "src/hub/app.ts", fingerprint: "f".repeat(64) }],
    evidence: [
      { kind: "entity" as const, entity: { id: SPEC_ID, kind: "spec", title: "Checkpoint D" } },
      { kind: "code" as const, code: { kind: "symbol" as const, symbolId: "relay.apply" } },
      { kind: "file" as const, path: "src/hub/app.ts" },
      { kind: "commit" as const, hash: "a".repeat(40) },
      { kind: "external" as const, uri: "https://example.test/evidence", label: "Run" },
      { kind: "manual" as const, note: "Observed locally." },
    ],
    nextActions: ["Run the exact matrix."],
  };
}

function relayDraftDetail(): RelayDraftDetail {
  const input = relayInput();
  return {
    id: RELAY_DRAFT_ID,
    revision: "2".repeat(64),
    updatedAt: TEAM_NOW,
    summary: input.summary,
    recipients: input.recipients,
    input,
  };
}

function relayDraftPage(): RelayDraftListResponse {
  const { input: _input, ...summary } = relayDraftDetail();
  return {
    items: [summary],
    nextCursor: null,
    truncated: false,
    sourceTruncated: false,
    deterministicRevision: "3".repeat(64),
    diagnostics: [],
    diagnosticsTruncated: false,
  };
}

function relayDetail(): RelayDetail {
  return {
    schemaVersion: 1,
    ref: { id: RELAY_ID, kind: "relay", title: relayInput().summary },
    sourcePath: `.mex/relays/${RELAY_ID}.md`,
    revision: "4".repeat(64),
    state: "published",
    sender: { kind: "member", memberId: TEAM_MEMBER_ID, displayName: "Ada Lovelace" },
    ...relayInput(),
    workstream: { kind: "workstream", id: TEAM_WORKSTREAM_ID, title: "Checkpoint D" },
    publishedAt: null,
    publishedRepoState: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
    closedBy: null,
    closedAt: null,
    diagnostics: [{
      code: "RELAY_LEGACY_PUBLICATION_TIME",
      severity: "warning",
      message: "One or more legacy schema-v1 Relays have no canonical publication timestamp.",
    }],
    diagnosticsTruncated: false,
  };
}

function legacyRelayDetail(): RelayDetail {
  const legacyPath = "src/legacy\u0085relay\u2028snapshot.ts";
  return {
    ...relayDetail(),
    sender: {
      kind: "member",
      memberId: TEAM_MEMBER_ID,
      displayName: "M".repeat(201),
    },
    recipients: [
      {
        kind: "git",
        name: "G".repeat(321),
        email: `${"e".repeat(310)}@example.test`,
      },
      ...Array.from({ length: 63 }, (_, index) => ({
        kind: "git" as const,
        name: `Legacy recipient ${index + 1}`,
        email: `legacy-${index + 1}@example.test`,
      })),
    ],
    workstream: {
      kind: "workstream",
      id: "historical-workstream",
      title: "Historical Relay",
    },
    changedFiles: [legacyPath],
    code: [{ kind: "file", path: legacyPath }],
    evidence: [
      { kind: "file", path: legacyPath },
      { kind: "code", code: { kind: "file", path: legacyPath } },
    ],
  };
}

function relayPage(): RelayListResponse {
  const {
    completed: _completed,
    inProgress: _inProgress,
    decisions: _decisions,
    blockers: _blockers,
    unresolvedQuestions: _questions,
    changedFiles: _files,
    code: _code,
    evidence: _evidence,
    nextActions: _actions,
    diagnostics: _diagnostics,
    diagnosticsTruncated: _diagnosticsTruncated,
    ...summary
  } = relayDetail();
  return {
    items: [summary],
    nextCursor: null,
    truncated: false,
    sourceTruncated: false,
    deterministicRevision: "5".repeat(64),
    diagnostics: relayDetail().diagnostics,
    diagnosticsTruncated: false,
  };
}

function legacyRelayPage(): RelayListResponse {
  const {
    completed: _completed,
    inProgress: _inProgress,
    decisions: _decisions,
    blockers: _blockers,
    unresolvedQuestions: _questions,
    changedFiles: _files,
    code: _code,
    evidence: _evidence,
    nextActions: _actions,
    diagnostics: _diagnostics,
    diagnosticsTruncated: _diagnosticsTruncated,
    ...summary
  } = legacyRelayDetail();
  return {
    items: [summary],
    nextCursor: null,
    truncated: false,
    sourceTruncated: false,
    deterministicRevision: "6".repeat(64),
    diagnostics: legacyRelayDetail().diagnostics,
    diagnosticsTruncated: false,
  };
}

function relayPreviewRequest(): RelayOperationPreviewRequest {
  return {
    operationId: "hub_relay_draft_save",
    action: { kind: "relay.draft.save", draft: relayInput() },
    expectedRevisions: [],
  };
}

function relayPreviewEnvelope(
  request: RelayOperationPreviewRequest = relayPreviewRequest(),
): RelayOperationPreviewResponse {
  const purposeIds: RelayOperationPreviewResponse["receipt"]["purposeIds"] = request.action.kind === "relay.draft.save"
    ? request.action.draftId === undefined ? [{ purpose: "relay-draft", id: RELAY_DRAFT_ID }] : []
    : request.action.kind === "relay.publish"
      ? [{ purpose: "activity", id: "event_01000000000000000000000001" }, { purpose: "relay", id: RELAY_ID }]
      : request.action.kind === "relay.acknowledge" || request.action.kind === "relay.close"
        ? [{ purpose: "activity", id: "event_01000000000000000000000001" }]
        : [];
  return {
    schemaVersion: 1,
    request,
    preview: {
      valid: true,
      scope: "local",
      changes: [],
      localChanges: [{
        namespace: "relay-draft",
        id: RELAY_DRAFT_ID,
        beforeRevision: null,
        afterRevision: relayDraftDetail().revision,
        summary: "Create one checkout-local Relay draft.",
      }],
      diagnostics: [],
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: { kind: "unknown" },
        occurredAt: TEAM_NOW,
        repoState: {
          branch: "feature/relay",
          head: "d".repeat(40),
          dirty: false,
          observedAt: TEAM_NOW,
        },
      },
      purposeIds,
      requestRevision: "6".repeat(64),
      presentationRevision: "7".repeat(64),
      previewRevision: "8".repeat(64),
    },
  };
}

function relayApplyResult(
  request: RelayOperationPreviewResponse = relayPreviewEnvelope(),
): RelayOperationApplyResponse {
  return {
    operationId: request.request.operationId,
    previewRevision: request.receipt.previewRevision,
    applied: true,
    idempotentReplay: false,
    changes: request.preview.changes,
    localChanges: request.preview.localChanges,
    relays: [],
    events: [],
  };
}

function teamMember(): TeamMember {
  return {
    schemaVersion: 1,
    id: TEAM_MEMBER_ID,
    displayName: "Ada Lovelace",
    gitAliases: [{ name: "Ada", email: "ada@example.test" }],
    active: true,
    sourcePath: `.mex/team/members/${TEAM_MEMBER_ID}.md`,
    revision: "a".repeat(64),
  };
}

function teamWorkstream(): TeamWorkstream {
  return {
    schemaVersion: 1,
    id: TEAM_WORKSTREAM_ID,
    entityRevision: 2,
    title: "Checkpoint D",
    goal: "Ship bounded Workstreams",
    summary: "A canonical release Workstream.",
    state: "active",
    owners: [{ kind: "unknown" }],
    contributors: [],
    paths: ["src/team"],
    code: [],
    topics: [],
    components: [],
    related: [],
    blockers: [],
    currentState: "Integration",
    nextMilestone: "Review",
    createdBy: { kind: "unknown" },
    createdAt: TEAM_NOW,
    updatedBy: { kind: "unknown" },
    updatedAt: TEAM_NOW,
    sourcePath: `.mex/workstreams/${TEAM_WORKSTREAM_ID}.md`,
    revision: "4".repeat(64),
  };
}

function specListResponse(): SpecListResponse {
  return {
    availability: "ready",
    index: specIndex(),
    page: {
      schemaVersion: 1,
      items: [specSummary(SPEC_ID, "spec")],
      nextCursor: null,
      truncated: false,
      estimatedTokens: 32,
      deterministicRevision: "7".repeat(64),
    },
  };
}

function specDetailResponse(): SpecDetailResponse {
  return {
    availability: "ready",
    index: specIndex(),
    detail: {
      schemaVersion: 1,
      spec: specSummary(SPEC_ID, "spec"),
      body: "# Checkpoint D\n",
      bodyTruncated: false,
      provenance: null,
      sources: [],
      sourcesTruncated: false,
      groundings: [],
      groundingsTruncated: false,
      hierarchy: {
        requirements: [specSummary(REQUIREMENT_ID, "requirement")],
        acceptanceCriteria: [],
        constraints: [],
        relations: [{
          type: "derived_from",
          source: { id: REQUIREMENT_ID, kind: "requirement" },
          target: { id: SPEC_ID, kind: "spec" },
          note: null,
        }],
        estimatedTokens: 48,
      },
      deterministicRevision: "8".repeat(64),
    },
  };
}

function specIndex(): SpecListResponse["index"] {
  return {
    state: "fresh",
    observedAt: TEAM_NOW,
    indexedRevision: "5".repeat(64),
    indexedAt: TEAM_NOW,
    diagnostics: [],
    diagnosticsTruncated: false,
  };
}

function specSummary(
  id: string,
  kind: "spec" | "requirement",
): Extract<SpecListResponse, { availability: "ready" }>["page"]["items"][number] {
  return {
    schemaVersion: 1,
    id,
    kind,
    title: kind === "spec" ? "Checkpoint D" : "Bounded Workstream reads",
    summary: null,
    lifecycleState: "promoted",
    groundingHealth: "fresh",
    sourcePath: `.mex/wiki/${id}.md`,
    version: { semanticRevision: 1, contentHash: "6".repeat(64) },
    topics: [],
    sourceTypes: [],
    diagnostics: [],
    diagnosticsTruncated: false,
  };
}

function teamPreviewRequest(): TeamOperationPreviewRequest {
  return {
    operationId: "hub_member_add",
    action: {
      kind: "member.add",
      member: {
        displayName: "Ada Lovelace",
        gitAliases: [{ name: "Ada", email: "ada@example.test" }],
      },
    },
    expectedRevisions: [],
  };
}

function teamPreviewEnvelope(
  request: TeamOperationPreviewRequest = teamPreviewRequest(),
): TeamOperationPreviewResponse {
  return {
    schemaVersion: 1,
    request,
    preview: {
      valid: true,
      scope: "canonical",
      changes: [{
        kind: "create",
        path: teamMember().sourcePath,
        diff: "--- /dev/null\n+++ member\n",
        beforeRevision: null,
        afterRevision: teamMember().revision,
      }],
      localChanges: [],
      diagnostics: [],
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: { kind: "unknown" },
        occurredAt: TEAM_NOW,
        repoState: {
          branch: "feature/team-identity",
          head: "d".repeat(40),
          dirty: false,
          observedAt: TEAM_NOW,
        },
      },
      purposeIds: [
        { purpose: "activity", id: TEAM_EVENT_ID },
        { purpose: "member", id: TEAM_MEMBER_ID },
      ],
      requestRevision: "e".repeat(64),
      presentationRevision: "f".repeat(64),
      previewRevision: "1".repeat(64),
    },
  };
}

function teamApplyResult(
  request: TeamOperationPreviewResponse = teamPreviewEnvelope(),
): TeamOperationApplyResponse {
  return {
    operationId: request.request.operationId,
    previewRevision: request.receipt.previewRevision,
    applied: true,
    idempotentReplay: false,
    changes: request.preview.changes,
    localChanges: request.preview.localChanges,
    members: [teamMember()],
    workstreams: [],
    events: [{
      schemaVersion: 1,
      id: TEAM_EVENT_ID,
      timestamp: TEAM_NOW,
      actor: request.receipt.authority.actor,
      action: "member.added",
      subjects: [{ kind: "entity", entity: { id: TEAM_MEMBER_ID, kind: "member" } }],
      workstream: null,
      repoState: request.receipt.authority.repoState,
    }],
  };
}

function unavailableSearch() {
  return {
    status: "unavailable" as const,
    items: [],
    nextCursor: null,
    truncated: false,
    revision: null,
    code: "CAPABILITY_UNAVAILABLE" as const,
    detail: "The adapter is not connected.",
  };
}

function wikiSummary(id: string) {
  return {
    id,
    kind: id.endsWith("JD") ? "architecture" : "component",
    title: id.endsWith("JD") ? "Durable queue" : "Worker",
    summary: null,
    lifecycleState: "promoted" as const,
    groundingHealth: "unverified" as const,
    topics: [],
    topicsTruncated: false,
    sourceTypes: [],
    sourceTypesTruncated: false,
    location: { path: ".mex/context/queue.md", startLine: 1, endLine: 10 },
    version: { semanticRevision: 1, contentHash: "e".repeat(64) },
    diagnostics: [],
    diagnosticsTruncated: false,
    route: `/knowledge/${id}`,
  };
}

function jobSnapshot(state: HubJobSnapshot["state"] = "running"): HubJobSnapshot {
  return {
    id: JOB_ID,
    scaffoldId: "mex",
    kind: "graph_refresh",
    generation: 1,
    phase: state === "succeeded" ? "complete" : "running",
    progress: state === "succeeded" ? { completed: 1, total: 1 } : null,
    state,
    cancelRequested: false,
    createdAt: "2026-08-23T00:00:00.000Z",
    ...(state === "succeeded" ? { finishedAt: "2026-08-23T00:00:01.000Z" } : {}),
    revision: "a".repeat(64),
  };
}

function jobService(state: HubJobSnapshot["state"] = "running"): HubJobService {
  const snapshot = jobSnapshot(state);
  return {
    list: () => ({ items: [snapshot], nextCursor: null }),
    get: () => snapshot,
    start: () => snapshot,
    cancel: () => ({
      ...snapshot,
      state: "interrupted",
      phase: "interrupted",
      cancelRequested: true,
      interruptedReason: "user_cancelled",
      finishedAt: "2026-08-23T00:00:02.000Z",
    }),
    subscribe: (_id: string, listener: (event: HubJobEvent) => void) => {
      listener({
        type: state === "succeeded" ? "terminal" : "snapshot",
        job: snapshot,
      });
      return () => undefined;
    },
  };
}

function assetManifest(): HubAssetManifest {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-app-assets-"));
  mkdirSync(join(root, ".vite"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Project Hub</title>");
  writeFileSync(join(root, "assets", "app-a1b2c3.js"), "export {};\n");
  writeFileSync(join(root, "assets", "not-declared.js"), "secret\n");
  writeFileSync(join(root, ".vite", "manifest.json"), JSON.stringify({
    index: { file: "assets/app-a1b2c3.js", isEntry: true },
  }));
  return new HubAssetManifest(root);
}
