import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpHubApi,
  HubApiError,
  activityFixtureVariant,
  fixturesEnabled,
  inboxFixtureVariant,
  memberFixtureVariant,
  openBootstrapSession,
  overviewFixtureVariant,
  relayFixtureVariant,
  readBootstrapToken,
  resolveApi,
} from "./client";
import type { ActivityResponse, JobSummary, RelayOperationPreviewRequest } from "./types";
import { createFixtureApi } from "../dev/fixture-api";
import type { HubTelemetryPage } from "./telemetry";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const session = {
  csrfToken: "a".repeat(43),
  expiresAt: "2026-08-23T20:00:00.000Z",
};

const job: JobSummary = {
  id: "job_01K36WVM6H7JK8M9NPQRSTVVWX",
  scaffoldId: "scf_mex",
  kind: "graph_refresh",
  generation: 1,
  phase: "queued",
  progress: null,
  state: "queued",
  cancelRequested: false,
  createdAt: "2026-08-23T08:00:00.000Z",
  revision: "a".repeat(64),
};

const activity: ActivityResponse = {
  items: [],
  nextCursor: null,
  hasMore: false,
  sourceTruncated: false,
  deterministicRevision: "f".repeat(64),
  diagnostics: [],
  diagnosticsTruncated: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local page telemetry transport", () => {
  it("sends only a category with session CSRF to the exact local endpoint and bounds in-flight work", async () => {
    let complete!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { complete = resolve; });
    const fetch = vi.fn().mockResolvedValueOnce(json(session)).mockReturnValueOnce(pending);
    vi.stubGlobal("fetch", fetch);
    const api = new HttpHubApi();
    await api.recordPageView("home");
    expect(fetch).not.toHaveBeenCalled();
    await api.getSession();
    await api.recordPageView("/Users/private" as HubTelemetryPage);
    expect(fetch).toHaveBeenCalledOnce();
    const sent = api.recordPageView("knowledge_detail");
    await api.recordPageView("code");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]).toEqual(["/api/v1/telemetry/page", {
      method: "POST", headers: { "Content-Type": "application/json", "X-MEX-CSRF": session.csrfToken },
      body: '{"page":"knowledge_detail"}', credentials: "same-origin", redirect: "error",
      referrerPolicy: "no-referrer", signal: expect.any(AbortSignal),
    }]);
    complete(new Response(null, { status: 204 }));
    await sent;
    fetch.mockRejectedValueOnce(new Error("local connection lost"));
    await expect(api.recordPageView("jobs")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("bootstrap fragment handling", () => {
  it.each([
    ["#token=secret-token", "secret-token"],
    ["#bootstrap=secret-token", "secret-token"],
    ["#secret-token", "secret-token"],
    ["", null],
    ["#unknown=value", null],
  ])("reads %s without persisting it", (hash, expected) => {
    expect(readBootstrapToken(hash)).toBe(expected);
  });

  it("opens a session from an accepted one-use link", async () => {
    const api = { bootstrap: vi.fn().mockResolvedValue({ expiresAt: session.expiresAt }), getSession: vi.fn() };
    await expect(openBootstrapSession(api, "secret-token")).resolves.toBeNull();
    expect(api.getSession).not.toHaveBeenCalled();
  });

  it("keeps an active session when the same link is opened again (#276)", async () => {
    const used = new HubApiError({ type: "about:blank", title: "Authentication required", status: 401, code: "UNAUTHORIZED",
      detail: "The bootstrap token is invalid, expired, or already used.", requestId: "11111111-1111-4111-8111-111111111111" });
    const api = { bootstrap: vi.fn().mockRejectedValue(used), getSession: vi.fn().mockResolvedValue(session) };
    await expect(openBootstrapSession(api, "secret-token")).resolves.toBeNull();
    expect(api.getSession).toHaveBeenCalledOnce();
  });

  it("reports the rejected link when there is no session to keep (#276)", async () => {
    const expired = new HubApiError({ type: "about:blank", title: "Authentication required", status: 401, code: "UNAUTHORIZED",
      detail: "The bootstrap token is invalid, expired, or already used.", requestId: "11111111-1111-4111-8111-111111111111" });
    const api = {
      bootstrap: vi.fn().mockRejectedValue(expired),
      getSession: vi.fn().mockRejectedValue(new HubApiError({ ...expired.problem, detail: "A valid local Hub session is required." })),
    };
    await expect(openBootstrapSession(api, "secret-token")).resolves.toBe(expired);
  });

  it("cannot enable populated fixtures in a production build", () => {
    expect(fixturesEnabled(false, "?fixture=populated")).toBe(false);
    expect(fixturesEnabled(true, "?fixture=populated")).toBe(true);
    expect(fixturesEnabled(true, "?fixture=populated&inboxFixture=empty")).toBe(true);
    expect(fixturesEnabled(true, "?fixture=populated&relayFixture=legacy")).toBe(true);
    expect(fixturesEnabled(true, "?fixture=populated&activityFixture=partial")).toBe(true);
    expect(fixturesEnabled(true, "?fixture=populated&memberFixture=git-alias")).toBe(true);
    expect(fixturesEnabled(true, "?fixture=populated&overviewFixture=established")).toBe(true);
    expect(fixturesEnabled(true, "?fixture=empty")).toBe(false);
  });

  it.each([
    ["?fixture=populated&inboxFixture=empty", "empty"],
    ["?fixture=populated&inboxFixture=unknown", "unknown"],
    ["?fixture=populated&inboxFixture=partial", "partial"],
    ["?fixture=populated", undefined],
    ["?fixture=populated&inboxFixture=populated", undefined],
    ["?fixture=populated&inboxFixture=EMPTY", undefined],
    ["?fixture=populated&inboxFixture=../../private", undefined],
  ])("bounds the Inbox fixture variant in %s", (search, expected) => {
    expect(inboxFixtureVariant(search)).toBe(expected);
  });

  it.each([
    ["?fixture=populated&relayFixture=empty", "empty"],
    ["?fixture=populated&relayFixture=closed", "closed"],
    ["?fixture=populated&relayFixture=missing", "missing"],
    ["?fixture=populated&relayFixture=partial", "partial"],
    ["?fixture=populated&relayFixture=legacy", "legacy"],
    ["?fixture=populated", undefined],
    ["?fixture=populated&relayFixture=populated", undefined],
    ["?fixture=populated&relayFixture=LEGACY", undefined],
    ["?fixture=populated&relayFixture=../../private", undefined],
  ])("bounds the Relay fixture variant in %s", (search, expected) => {
    expect(relayFixtureVariant(search)).toBe(expected);
  });

  it.each([
    ["?fixture=populated&activityFixture=empty", "empty"],
    ["?fixture=populated&activityFixture=legacy", "legacy"],
    ["?fixture=populated&activityFixture=partial", "partial"],
    ["?fixture=populated", undefined],
    ["?fixture=populated&activityFixture=populated", undefined],
    ["?fixture=populated&activityFixture=PARTIAL", undefined],
    ["?fixture=populated&activityFixture=../../private", undefined],
  ])("bounds the Activity fixture variant in %s", (search, expected) => {
    expect(activityFixtureVariant(search)).toBe(expected);
  });

  it.each([
    ["?fixture=populated&memberFixture=configured", "configured"],
    ["?fixture=populated&memberFixture=git-alias", "git-alias"],
    ["?fixture=populated&memberFixture=git-fallback", "git-fallback"],
    ["?fixture=populated&memberFixture=unknown", "unknown"],
    ["?fixture=populated&memberFixture=stale", "stale"],
    ["?fixture=populated&memberFixture=inactive", "inactive"],
    ["?fixture=populated&memberFixture=ambiguous", "ambiguous"],
    ["?fixture=populated&memberFixture=partial", "partial"],
    ["?fixture=populated", undefined],
    ["?fixture=populated&memberFixture=populated", undefined],
    ["?fixture=populated&memberFixture=GIT-ALIAS", undefined],
    ["?fixture=populated&memberFixture=../../private", undefined],
  ])("bounds the Member fixture variant in %s", (search, expected) => {
    expect(memberFixtureVariant(search)).toBe(expected);
  });

  it.each([
    ["?fixture=populated&overviewFixture=established", "established"],
    ["?fixture=populated&overviewFixture=caught-up", "caught-up"],
    ["?fixture=populated&overviewFixture=pending-review", "pending-review"],
    ["?fixture=populated&overviewFixture=relay-ready", "relay-ready"],
    ["?fixture=populated&overviewFixture=relay-in-hand", "relay-in-hand"],
    ["?fixture=populated&overviewFixture=identity-unresolved", "identity-unresolved"],
    ["?fixture=populated&overviewFixture=indexes-stale", "indexes-stale"],
    ["?fixture=populated&overviewFixture=indexes-degraded", "indexes-degraded"],
    ["?fixture=populated&overviewFixture=indexes-missing", "indexes-missing"],
    ["?fixture=populated&overviewFixture=job-determinate", "job-determinate"],
    ["?fixture=populated&overviewFixture=job-indeterminate", "job-indeterminate"],
    ["?fixture=populated&overviewFixture=failure", "failure"],
    ["?fixture=populated&overviewFixture=partial", "partial"],
    ["?fixture=populated&overviewFixture=unavailable", "unavailable"],
    ["?fixture=populated", undefined],
    ["?fixture=populated&overviewFixture=populated", undefined],
    ["?fixture=populated&overviewFixture=ESTABLISHED", undefined],
    ["?fixture=populated&overviewFixture=../../private", undefined],
  ])("bounds the Overview fixture variant in %s", (search, expected) => {
    expect(overviewFixtureVariant(search)).toBe(expected);
  });

  it("passes a bounded Member variant into the development fixture API", async () => {
    vi.stubGlobal("window", {
      location: { search: "?fixture=populated&memberFixture=unknown" },
    });

    const api = await resolveApi();

    await expect(api.getCurrentActor()).resolves.toMatchObject({
      actor: { kind: "unknown" },
      source: "unknown",
      diagnostics: [{ code: "GIT_IDENTITY_UNAVAILABLE" }],
    });
  });

  it("passes a bounded Overview variant into the development fixture API", async () => {
    vi.stubGlobal("window", {
      location: { search: "?fixture=populated&overviewFixture=identity-unresolved" },
    });

    const api = await resolveApi();

    await expect(api.getOverview()).resolves.toMatchObject({
      shell: { actor: { kind: "unknown" } },
    });
  });
});

describe("HttpHubApi shared-contract boundary", () => {
  it("reads the bounded Overview aggregate from its dedicated endpoint", async () => {
    const response = await createFixtureApi({ overviewFixture: "caught-up" }).getOverview();
    const fetchMock = vi.fn().mockResolvedValue(json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new HttpHubApi().getOverview()).resolves.toEqual(response);

    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(rawUrl, "http://127.0.0.1").pathname).toBe("/api/v1/overview");
    expect(init.method).toBeUndefined();
  });

  it("sends independent search cursors through the strict shared contract", async () => {
    const response = await createFixtureApi().search({ q: "graph", limit: 25 });
    const fetchMock = vi.fn().mockResolvedValue(json(response));
    vi.stubGlobal("fetch", fetchMock);

    await new HttpHubApi().search({ q: "graph", limit: 25, symbolCursor: "symbol-page-2" });

    const [rawUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl, "http://127.0.0.1");
    expect(url.pathname).toBe("/api/v1/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "graph", limit: "25", symbolCursor: "symbol-page-2" });
  });

  it("reads a bounded symbol workspace without allowing path-like IDs", async () => {
    const response = await createFixtureApi().getCodeSymbol("sym.createHubServer", { view: "impact", depth: 3 });
    const fetchMock = vi.fn().mockResolvedValue(json(response));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpHubApi();

    await expect(api.getCodeSymbol("sym.createHubServer", { view: "impact", depth: 3, sourceCursor: "source-page-2" })).resolves.toEqual(response);
    const [rawUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl, "http://127.0.0.1");
    expect(url.pathname).toBe("/api/v1/code/symbols/sym.createHubServer");
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: "impact", depth: "3", sourceCursor: "source-page-2" });

    await expect(api.getCodeSymbol("../../secrets", { view: "overview" })).rejects.toBeInstanceOf(HubApiError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses strict Wiki routes, singular filters, and safe entity IDs", async () => {
    const fixture = createFixtureApi();
    const entityId = "mx_01K36WVM6H7JK8M9NPQRSTVVWX";
    const responses = await Promise.all([
      fixture.listWikiEntities({ kind: "architecture", lifecycle: "promoted", grounding: "fresh", sourceType: "file", limit: 25 }),
      fixture.getWikiEntity(entityId),
      fixture.getWikiRelations(entityId, { direction: "both", type: "depends_on", limit: 25 }),
      fixture.getWikiBacklinks(entityId, { type: "related_to", limit: 25 }),
      fixture.getCodeKnowledge("sym.createHubServer", { limit: 25 }),
    ]);
    const fetchMock = vi.fn();
    for (const response of responses) fetchMock.mockResolvedValueOnce(json(response));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpHubApi();

    await api.listWikiEntities({ kind: "architecture", lifecycle: "promoted", grounding: "fresh", sourceType: "file", limit: 25 });
    await api.getWikiEntity(entityId);
    await api.getWikiRelations(entityId, { direction: "both", type: "depends_on", limit: 25 });
    await api.getWikiBacklinks(entityId, { type: "related_to", limit: 25 });
    await api.getCodeKnowledge("sym.createHubServer", { limit: 25 });

    const urls = fetchMock.mock.calls.map(([rawUrl]) => new URL(rawUrl as string, "http://127.0.0.1"));
    expect(urls[0].pathname).toBe("/api/v1/wiki/entities");
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ limit: "25", kind: "architecture", lifecycle: "promoted", grounding: "fresh", sourceType: "file" });
    expect(urls[1].pathname).toBe(`/api/v1/wiki/entities/${entityId}`);
    expect(urls[2].pathname).toBe(`/api/v1/wiki/entities/${entityId}/relations`);
    expect(Object.fromEntries(urls[2].searchParams)).toEqual({ direction: "both", limit: "25", type: "depends_on" });
    expect(urls[3].pathname).toBe(`/api/v1/wiki/entities/${entityId}/backlinks`);
    expect(urls[4].pathname).toBe("/api/v1/code/symbols/sym.createHubServer/knowledge");

    await expect(api.getWikiEntity("../../private/wiki")).rejects.toBeInstanceOf(HubApiError);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("sends bounded Activity filters and parses the shared response contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(activity));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new HttpHubApi().getActivity({
      source: "legacy",
      since: "2026-08-23T00:00:00.000Z",
      cursor: "opaque-cursor",
      limit: 25,
    })).resolves.toEqual(activity);

    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl, "http://127.0.0.1");
    expect(url.pathname).toBe("/api/v1/activity");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "25",
      source: "legacy",
      since: "2026-08-23T00:00:00.000Z",
      cursor: "opaque-cursor",
    });
    expect(init.method).toBeUndefined();
  });

  it("uses strict member reads and applies the exact reviewed team envelope", async () => {
    const fixture = createFixtureApi();
    const memberPage = await fixture.getMembers({ active: true, limit: 25 });
    const member = memberPage.items[0]!;
    const actor = await fixture.getCurrentActor();
    const request = {
      operationId: "hub_member_update_client_contract",
      action: {
        kind: "member.update" as const,
        memberId: member.id,
        patch: { displayName: "Ada Byron", gitAliases: member.gitAliases },
      },
      expectedRevisions: [{
        target: { kind: "artifact" as const, path: member.sourcePath },
        revision: member.revision,
      }],
    };
    const preview = await fixture.previewTeamOperation(request);
    const applied = await fixture.applyTeamOperation(preview);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json(memberPage))
      .mockResolvedValueOnce(json(member))
      .mockResolvedValueOnce(json(actor))
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json(applied));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpHubApi();

    await api.getSession();
    await api.getMembers({ active: true, cursor: "member-page-2", limit: 25 });
    await api.getMember(member.id);
    await api.getCurrentActor();
    await api.previewTeamOperation(request);
    await api.applyTeamOperation(preview);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(new URL(calls[1]![0], "http://127.0.0.1").pathname).toBe("/api/v1/members");
    expect(Object.fromEntries(new URL(calls[1]![0], "http://127.0.0.1").searchParams)).toEqual({
      limit: "25",
      active: "true",
      cursor: "member-page-2",
    });
    expect(new URL(calls[2]![0], "http://127.0.0.1").pathname).toBe(`/api/v1/members/${member.id}`);
    expect(new URL(calls[3]![0], "http://127.0.0.1").pathname).toBe("/api/v1/actor/current");
    expect(new URL(calls[4]![0], "http://127.0.0.1").pathname).toBe("/api/v1/team/operations/preview");
    expect(JSON.parse(calls[4]![1].body as string)).toEqual(request);
    expect(new URL(calls[5]![0], "http://127.0.0.1").pathname).toBe("/api/v1/team/operations/apply");
    expect(JSON.parse(calls[5]![1].body as string)).toEqual(preview);
    expect((calls[4]![1].headers as Headers).get("X-MEX-CSRF")).toBe(session.csrfToken);
    expect((calls[5]![1].headers as Headers).get("X-MEX-CSRF")).toBe(session.csrfToken);

    await expect(api.getMember("../../private/member")).rejects.toBeInstanceOf(HubApiError);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("uses dedicated bounded Workstream and Spec routes", async () => {
    const fixture = createFixtureApi();
    const workstreams = await fixture.getWorkstreams({ state: "active", limit: 25 });
    const workstream = workstreams.items[0]!;
    const specs = await fixture.listSpecs({
      lifecycleStates: ["in_flight", "promoted"],
      groundingHealth: ["fresh", "unverified"],
      includeArchived: false,
      limit: 25,
    });
    if (specs.availability !== "ready") throw new Error("Fixture Spec list must be ready.");
    const spec = await fixture.getSpec(specs.page.items[0]!.id);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(workstreams))
      .mockResolvedValueOnce(json(workstream))
      .mockResolvedValueOnce(json(specs))
      .mockResolvedValueOnce(json(spec));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpHubApi();

    await api.getWorkstreams({ state: "active", includeArchived: false, cursor: "workstream-page-2", limit: 25 });
    await api.getWorkstream(workstream.id);
    await api.listSpecs({
      lifecycleStates: ["in_flight", "promoted"],
      groundingHealth: ["fresh", "unverified"],
      includeArchived: false,
      topics: [specs.page.items[0]!.id],
      cursor: "spec-page-2",
      limit: 25,
    });
    await api.getSpec(specs.page.items[0]!.id);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const workstreamListUrl = new URL(calls[0]![0], "http://127.0.0.1");
    expect(workstreamListUrl.pathname).toBe("/api/v1/workstreams");
    expect(Object.fromEntries(workstreamListUrl.searchParams)).toEqual({
      limit: "25",
      state: "active",
      includeArchived: "false",
      cursor: "workstream-page-2",
    });
    expect(new URL(calls[1]![0], "http://127.0.0.1").pathname).toBe(`/api/v1/workstreams/${workstream.id}`);
    const specListUrl = new URL(calls[2]![0], "http://127.0.0.1");
    expect(specListUrl.pathname).toBe("/api/v1/specs");
    expect(specListUrl.searchParams.get("lifecycleStates")).toBe("in_flight,promoted");
    expect(specListUrl.searchParams.get("groundingHealth")).toBe("fresh,unverified");
    expect(specListUrl.searchParams.get("topics")).toBe(specs.page.items[0]!.id);
    expect(new URL(calls[3]![0], "http://127.0.0.1").pathname).toBe(`/api/v1/specs/${specs.page.items[0]!.id}`);

    await expect(api.getWorkstream("../../private/workstream")).rejects.toBeInstanceOf(HubApiError);
    await expect(api.getSpec("../../private/spec")).rejects.toBeInstanceOf(HubApiError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("uses strict Relay reads and applies the byte-identical signed envelope", async () => {
    const fixture = createFixtureApi();
    const drafts = await fixture.getRelayDrafts({ limit: 25 });
    const draft = await fixture.getRelayDraft(drafts.items[0]!.id);
    const relays = await fixture.getRelays({
      perspective: "mine",
      states: ["published", "acknowledged"],
      limit: 25,
    });
    const relay = await fixture.getRelay(relays.items[0]!.ref.id);
    const legacyWorkstreamId = "ws_01K37WVM6H7JK8M9NPQRSTVVW0";
    const request: RelayOperationPreviewRequest = {
      operationId: "hub_relay_client_exact_envelope",
      action: { kind: "relay.draft.save", draft: draft.input },
      expectedRevisions: [],
    };
    const preview = await fixture.previewRelayOperation(request);
    const applied = await fixture.applyRelayOperation(preview);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json(drafts))
      .mockResolvedValueOnce(json(draft))
      .mockResolvedValueOnce(json(relays))
      .mockResolvedValueOnce(json(relay))
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json(applied));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpHubApi();

    await api.getSession();
    await api.getRelayDrafts({ cursor: "relay-draft-page-2", limit: 25 });
    await api.getRelayDraft(draft.id);
    await api.getRelays({
      perspective: "mine",
      states: ["published", "acknowledged"],
      workstreamId: legacyWorkstreamId,
      cursor: "relay-page-2",
      limit: 25,
    });
    await api.getRelay(relay.ref.id);
    await api.previewRelayOperation(request);
    await api.applyRelayOperation(preview);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const draftListUrl = new URL(calls[1]![0], "http://127.0.0.1");
    expect(draftListUrl.pathname).toBe("/api/v1/relays/drafts");
    expect(Object.fromEntries(draftListUrl.searchParams)).toEqual({ limit: "25", cursor: "relay-draft-page-2" });
    expect(new URL(calls[2]![0], "http://127.0.0.1").pathname).toBe(`/api/v1/relays/drafts/${draft.id}`);
    const relayListUrl = new URL(calls[3]![0], "http://127.0.0.1");
    expect(relayListUrl.pathname).toBe("/api/v1/relays");
    expect(Object.fromEntries(relayListUrl.searchParams)).toEqual({
      perspective: "mine",
      limit: "25",
      state: "published,acknowledged",
      workstreamId: legacyWorkstreamId,
      cursor: "relay-page-2",
    });
    expect(new URL(calls[4]![0], "http://127.0.0.1").pathname).toBe(`/api/v1/relays/${relay.ref.id}`);
    expect(new URL(calls[5]![0], "http://127.0.0.1").pathname).toBe("/api/v1/relays/operations/preview");
    expect(calls[5]![1].body).toBe(JSON.stringify(request));
    expect(new URL(calls[6]![0], "http://127.0.0.1").pathname).toBe("/api/v1/relays/operations/apply");
    expect(calls[6]![1].body).toBe(JSON.stringify(preview));
    expect((calls[5]![1].headers as Headers).get("X-MEX-CSRF")).toBe(session.csrfToken);
    expect((calls[6]![1].headers as Headers).get("X-MEX-CSRF")).toBe(session.csrfToken);

    await expect(api.getRelayDraft("../../private/draft")).rejects.toBeInstanceOf(HubApiError);
    await expect(api.getRelay("../../private/relay")).rejects.toBeInstanceOf(HubApiError);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("retains CSRF only in memory and adds it to JSON mutations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json(job, 202));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpHubApi();

    await api.getSession();
    await api.startJob({ kind: "graph_refresh" });

    const mutation = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = mutation[1].headers as Headers;
    expect(headers.get("X-MEX-CSRF")).toBe(session.csrfToken);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(mutation[1].credentials).toBe("same-origin");
  });

  it("rejects a successful response that diverges from the shared schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ authenticated: true })));
    await expect(new HttpHubApi().getSession()).rejects.toMatchObject({
      name: "HubApiError",
      problem: { code: "INTERNAL_ERROR" },
    });
  });

  it("rejects malicious job IDs before issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(new HttpHubApi().getJob("../../secrets")).rejects.toBeInstanceOf(HubApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes an event stream as soon as a terminal snapshot arrives", () => {
    class FakeEventSource {
      static latest: FakeEventSource;
      readonly listeners = new Map<string, EventListener>();
      readonly close = vi.fn();
      onmessage: EventListener | null = null;

      constructor() {
        FakeEventSource.latest = this;
      }

      addEventListener(type: string, listener: EventListener) {
        this.listeners.set(type, listener);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const api = new HttpHubApi();
    const received = vi.fn();
    api.subscribeToJob(job.id, received);
    const terminal = { ...job, state: "succeeded", phase: "complete" };
    FakeEventSource.latest.listeners.get("terminal")?.(
      new MessageEvent("terminal", { data: JSON.stringify(terminal) }),
    );
    expect(received).toHaveBeenCalledWith(terminal);
    expect(FakeEventSource.latest.close).toHaveBeenCalledOnce();
  });

  it("recovers setup on connection and reconnection errors, then stops on close", () => {
    class FakeEventSource {
      static latest: FakeEventSource;
      readonly close = vi.fn();
      onerror: (() => void) | null = null;
      onmessage: EventListener | null = null;
      constructor() { FakeEventSource.latest = this; }
      addEventListener() { /* No snapshots arrive before promotion. */ }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const disconnected = vi.fn();
    const subscription = new HttpHubApi().subscribeToSetup(vi.fn(), disconnected);
    FakeEventSource.latest.onerror?.();
    FakeEventSource.latest.onerror?.();
    expect(disconnected).toHaveBeenCalledTimes(2);
    subscription.close();
    FakeEventSource.latest.onerror?.();
    expect(disconnected).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.latest.close).toHaveBeenCalledOnce();
  });
});
