import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HubApiError, type HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import type {
  RelayDetail,
  RelayDraftInput,
  RelayDraftListResponse,
  RelayListResponse,
  RelayOperationPreviewRequest,
  RelayOperationPreviewResponse,
  RelaySummary,
} from "../api/types";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

const DRAFT_ID = "relay-draft-01";
const DIRECT_DRAFT_ID = "relay-draft-direct-02";
const RELAY_ID = "relay_01000000000000000000000001";
const CLAIMED_RELAY_ID = "relay_01000000000000000000000002";
const DIRECT_RELAY_ID = "relay_04000000000000000000000001";
const ADA_ID = "member_01K36WVM6H7JK8M9NPQRSTVVWX";
const GRACE_ID = "member_01K36R3X4A5BC6DE7FGHJKMNPQ";
const LIN_ID = "member_01K35Z2A3B4C5D6E7FGHJKMNPQ";
const WORKSTREAM_ID = "ws_01K37WVM6H7JK8M9NPQRSTVVW0";
const KNOWLEDGE_ID = "mx_01K36WVM6H7JK8M9NPQRSTVVWX";
const LEGACY_WARNING = "One or more legacy schema-v1 Relays have no canonical publication timestamp.";

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="route-location" hidden>{`${location.pathname}${location.search}`}</span>;
}

function renderRoute(api: HubApi = createFixtureApi(), initialEntry = "/relays") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={api}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <AppRoutes />
          <LocationProbe />
        </MemoryRouter>
      </HubApiProvider>
    </QueryClientProvider>,
  );
}

function routeLocation(): string {
  return screen.getByTestId("route-location").textContent ?? "";
}

function emptyRelayPage(): RelayListResponse {
  return {
    items: [],
    nextCursor: null,
    truncated: false,
    sourceTruncated: false,
    deterministicRevision: "1".repeat(64),
    diagnostics: [],
    diagnosticsTruncated: false,
  };
}

function emptyRelayDraftPage(): RelayDraftListResponse {
  return {
    items: [],
    nextCursor: null,
    truncated: false,
    sourceTruncated: false,
    deterministicRevision: "2".repeat(64),
    diagnostics: [],
    diagnosticsTruncated: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function summaryOf(detail: RelayDetail): RelaySummary {
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
  } = detail;
  return summary;
}

function mockCurrentMember(api: HubApi, memberId: string, displayName: string) {
  return vi.spyOn(api, "getCurrentActor").mockResolvedValue({
    actor: { kind: "member", memberId, displayName },
    source: "configured-member",
    selection: {
      memberId,
      updatedAt: "2026-08-23T08:30:00.000Z",
      revision: "d".repeat(64),
    },
    diagnostics: [],
    diagnosticsTruncated: false,
  });
}

function mockSingleRelay(api: HubApi, relay: RelayDetail) {
  vi.spyOn(api, "getRelays").mockResolvedValue({
    ...emptyRelayPage(),
    items: [summaryOf(relay)],
  });
  return vi.spyOn(api, "getRelay").mockImplementation(async (id) => {
    if (id !== relay.ref.id) throw new Error("Relay fixture not found.");
    return structuredClone(relay);
  });
}

function expectDocumentOrder(first: HTMLElement, second: HTMLElement) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

async function relayDraftRow(id: string): Promise<HTMLButtonElement> {
  await waitFor(() => expect(document.querySelector(`button[data-relay-draft-id="${id}"]`)).toBeInTheDocument());
  return document.querySelector<HTMLButtonElement>(`button[data-relay-draft-id="${id}"]`)!;
}

async function editSelectedDraft(user: ReturnType<typeof userEvent.setup>, api: HubApi = createFixtureApi()) {
  renderRoute(api, `/relays?view=drafts&draft=${DRAFT_ID}`);
  await user.click(await screen.findByRole("button", { name: "Edit wording" }));
  return screen.findByRole("dialog", { name: "Edit handoff draft" });
}

describe("Relay handoff workbench", () => {
  it("defaults an active Member to For you + Open and keeps drafts lazy", async () => {
    const api = createFixtureApi();
    const relays = vi.spyOn(api, "getRelays");
    const detail = vi.spyOn(api, "getRelay");
    const drafts = vi.spyOn(api, "getRelayDrafts");
    renderRoute(api);

    await screen.findByRole("heading", { level: 1, name: "Relays" });
    const page = document.querySelector('[data-relay-workbench="ready"]');
    expect(page).toHaveAttribute("data-relay-workbench", "ready");
    expect(screen.getByRole("tab", { name: "For you" })).toHaveAttribute("aria-selected", "true");
    const stateControl = screen.getByRole("group", { name: "Relay state" });
    expect(within(stateControl).getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "New local draft" })).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ loaded/i)).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(`[data-relay-id="${RELAY_ID}"]`)).toBeInTheDocument());
    expect(relays).toHaveBeenCalledWith({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 });
    expect(detail).not.toHaveBeenCalled();
    expect(drafts).not.toHaveBeenCalled();
    await waitFor(() => expect(routeLocation()).toContain("view=mine"));
    expect(routeLocation()).toContain("state=open");
    expect(routeLocation()).not.toContain("relay=");

    await userEvent.setup().click(document.querySelector<HTMLButtonElement>(`button[data-relay-id="${RELAY_ID}"]`)!);
    await waitFor(() => expect(detail).toHaveBeenCalledWith(RELAY_ID));
    expect(routeLocation()).toContain(`relay=${RELAY_ID}`);
  });

  it("keeps perspective and lifecycle filters independent", async () => {
    const api = createFixtureApi();
    const relays = vi.spyOn(api, "getRelays");
    const user = userEvent.setup();
    renderRoute(api);

    await screen.findByRole("heading", { level: 1, name: "Relays" });
    await user.click(screen.getByRole("tab", { name: "Sent" }));
    await waitFor(() => expect(relays).toHaveBeenCalledWith({
      perspective: "sent",
      states: ["published", "acknowledged"],
      limit: 25,
    }));
    const stateControl = screen.getByRole("group", { name: "Relay state" });
    expect(within(stateControl).getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "true");

    await user.click(within(stateControl).getByRole("button", { name: "Closed" }));
    await waitFor(() => expect(relays).toHaveBeenCalledWith({
      perspective: "sent",
      states: ["closed"],
      limit: 25,
    }));
    expect(screen.getByRole("tab", { name: "Sent" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("tab", { name: "Team" }));
    await waitFor(() => expect(relays).toHaveBeenCalledWith({
      perspective: "all",
      states: ["closed"],
      limit: 25,
    }));
    await user.click(within(stateControl).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(relays).toHaveBeenCalledWith({
      perspective: "all",
      states: ["published", "acknowledged"],
      limit: 25,
    }));
    expect(routeLocation()).toContain("view=all");
    expect(routeLocation()).toContain("state=open");
  });

  it("loads local drafts only after Drafts on this device is opened", async () => {
    const api = createFixtureApi();
    const drafts = vi.spyOn(api, "getRelayDrafts");
    const detail = vi.spyOn(api, "getRelayDraft");
    const user = userEvent.setup();
    renderRoute(api);

    await waitFor(() => expect(document.querySelector(`[data-relay-id="${RELAY_ID}"]`)).toBeInTheDocument());
    expect(drafts).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Drafts on this device" }));
    await waitFor(() => expect(drafts).toHaveBeenCalledWith({ limit: 25 }));
    const row = await relayDraftRow(DRAFT_ID);
    expect(row).toHaveAttribute("data-relay-draft-id", DRAFT_ID);
    expect(detail).not.toHaveBeenCalled();
    await waitFor(() => expect(routeLocation()).toContain("view=drafts"));
    expect(routeLocation()).not.toContain("draft=");
    await user.click(row);
    await waitFor(() => expect(detail).toHaveBeenCalledWith(DRAFT_ID));
    expect(routeLocation()).toContain(`draft=${DRAFT_ID}`);
  });

  it("falls back to Team + Open without an active Member while Team and Drafts stay readable", async () => {
    const api = createFixtureApi();
    vi.spyOn(api, "getCurrentActor").mockResolvedValue({
      actor: { kind: "git", name: "Unmatched", email: "unmatched@example.test" },
      source: "git-fallback",
      selection: null,
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    const relays = vi.spyOn(api, "getRelays");
    const drafts = vi.spyOn(api, "getRelayDrafts");
    const user = userEvent.setup();
    renderRoute(api);

    await screen.findByRole("heading", { level: 1, name: "Relays" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Team" })).toHaveAttribute("aria-selected", "true"));
    expect(within(screen.getByRole("group", { name: "Relay state" })).getByRole("button", { name: "Open" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(relays).toHaveBeenCalledWith({ perspective: "all", states: ["published", "acknowledged"], limit: 25 });
    const identityCopy = await screen.findByText(/select an active team identity/i);
    const identityNotice = identityCopy.closest('[role="alert"], [role="status"]');
    expect(identityNotice).not.toBeNull();
    expect(within(identityNotice as HTMLElement).getByRole("link", { name: /team|members/i })).toHaveAttribute("href", "/members");

    await user.click(screen.getByRole("tab", { name: "Drafts on this device" }));
    await waitFor(() => expect(drafts).toHaveBeenCalledWith({ limit: 25 }));
    expect(await screen.findByText("Carry the release evidence through the final cross-platform gate.")).toBeVisible();
  });

  it("surfaces bounded current-identity diagnostics without blocking the personal queue", async () => {
    const api = createFixtureApi();
    const current = await api.getCurrentActor();
    vi.spyOn(api, "getCurrentActor").mockResolvedValue({
      ...current,
      diagnostics: [],
      diagnosticsTruncated: true,
    });
    renderRoute(api);

    expect(await screen.findByText("Additional identity diagnostics were omitted because the safe response limit was reached.")).toBeVisible();
    expect(screen.getByRole("tab", { name: "For you" })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(`[data-relay-id="${RELAY_ID}"]`)).toBeInTheDocument();
  });

  it("loads a valid directly selected Relay even when it is not in the first list page", async () => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const directRelay: RelayDetail = {
      ...base,
      ref: { kind: "relay", id: DIRECT_RELAY_ID, title: "Closed direct handoff" },
      sourcePath: `.mex/relays/${DIRECT_RELAY_ID}.md`,
      summary: "Closed direct handoff",
      state: "closed",
      acknowledgedBy: { kind: "member", memberId: ADA_ID, displayName: "Ada Lovelace" },
      acknowledgedAt: "2026-08-23T08:40:00.000Z",
      closedBy: { kind: "member", memberId: GRACE_ID, displayName: "Grace Hopper" },
      closedAt: "2026-08-23T08:42:00.000Z",
    };
    const list = vi.spyOn(api, "getRelays").mockResolvedValue(emptyRelayPage());
    const detail = vi.spyOn(api, "getRelay").mockImplementation(async (id) => {
      if (id === DIRECT_RELAY_ID) return structuredClone(directRelay);
      return structuredClone(base);
    });
    const preview = vi.spyOn(api, "previewRelayOperation");
    renderRoute(api, `/relays?view=all&state=closed&relay=${DIRECT_RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: "Closed direct handoff" })).toBeVisible();
    expect(list).toHaveBeenCalledWith({ perspective: "all", states: ["closed"], limit: 25 });
    expect(detail).toHaveBeenCalledWith(DIRECT_RELAY_ID);
    expect(preview).not.toHaveBeenCalled();
  });

  it("loads a valid directly selected local draft even when it is not in the first list page", async () => {
    const api = createFixtureApi();
    const base = await api.getRelayDraft(DRAFT_ID);
    const directDraft = {
      ...base,
      id: DIRECT_DRAFT_ID,
      summary: "Directly linked local handoff draft",
      input: { ...base.input, summary: "Directly linked local handoff draft" },
    };
    const list = vi.spyOn(api, "getRelayDrafts").mockResolvedValue(emptyRelayDraftPage());
    const detail = vi.spyOn(api, "getRelayDraft").mockImplementation(async (id) => {
      if (id === DIRECT_DRAFT_ID) return structuredClone(directDraft);
      return structuredClone(base);
    });
    renderRoute(api, `/relays?view=drafts&draft=${DIRECT_DRAFT_ID}`);

    expect(await screen.findByRole("heading", { name: "Directly linked local handoff draft" })).toBeVisible();
    expect(list).toHaveBeenCalledWith({ limit: 25 });
    expect(detail).toHaveBeenCalledWith(DIRECT_DRAFT_ID);
  });

  it.each([
    ["Relay", "/relays?view=all&state=open&relay=not-a-relay", "getRelay", /This handoff link is invalid/i],
    ["draft", "/relays?view=drafts&draft=not/a/draft", "getRelayDraft", /This draft link is invalid/i],
  ] as const)("guards an invalid direct %s ID before calling its detail API", async (_kind, entry, method, message) => {
    const api = createFixtureApi();
    const detail = vi.spyOn(api, method);
    renderRoute(api, entry);

    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByRole("button", { name: /return to (?:handoffs|queue|drafts)/i })).toBeVisible();
    expect(detail).not.toHaveBeenCalled();
  });

  it.each([
    ["state", `/relays?view=all&state=closed&relay=${RELAY_ID}`],
    ["perspective", `/relays?view=sent&state=open&relay=${RELAY_ID}`],
  ] as const)("recovers from a direct Relay %s mismatch", async (_kind, entry) => {
    const api = createFixtureApi();
    const detail = vi.spyOn(api, "getRelay");
    renderRoute(api, entry);

    expect(await screen.findByText(/handoff.*(?:not available|does not belong|isn't in).*view/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /return to handoffs/i })).toBeVisible();
    expect(detail).toHaveBeenCalledWith(RELAY_ID);
  });

  it.each([
    [
      "draft mode",
      `/relays?view=drafts&state=closed&relay=${RELAY_ID}&draft=${DRAFT_ID}`,
      ["view=drafts", `draft=${DRAFT_ID}`],
      ["state=", "relay="],
    ],
    [
      "canonical mode",
      `/relays?view=all&relay=${RELAY_ID}&draft=${DRAFT_ID}`,
      ["view=all", "state=open", `relay=${RELAY_ID}`],
      ["draft="],
    ],
  ] as const)("normalizes stale cross-mode parameters for %s", async (_mode, entry, included, excluded) => {
    renderRoute(createFixtureApi(), entry);
    await screen.findByRole("heading", { level: 1, name: "Relays" });
    await waitFor(() => {
      for (const part of included) expect(routeLocation()).toContain(part);
      for (const part of excluded) expect(routeLocation()).not.toContain(part);
    });
  });

  it("Refresh refetches active Relay data, identity, and Home, then recovers a removed selection", async () => {
    const api = createFixtureApi();
    const originalList = api.getRelays.bind(api);
    const originalDetail = api.getRelay.bind(api);
    let removed = false;
    const list = vi.spyOn(api, "getRelays").mockImplementation((request) => (
      removed ? Promise.resolve(emptyRelayPage()) : originalList(request)
    ));
    const detail = vi.spyOn(api, "getRelay").mockImplementation((id) => (
      removed
        ? Promise.reject(new HubApiError({
            type: "about:blank",
            title: "Handoff not found",
            status: 404,
            code: "NOT_FOUND",
            detail: "That Relay no longer exists in this working tree.",
            requestId: "relay-refresh-not-found",
          }))
        : originalDetail(id)
    ));
    const actor = vi.spyOn(api, "getCurrentActor");
    const home = vi.spyOn(api, "getHome");
    const user = userEvent.setup();
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();
    const initialCalls = {
      actor: actor.mock.calls.length,
      detail: detail.mock.calls.length,
      home: home.mock.calls.length,
      list: list.mock.calls.length,
    };
    removed = true;
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(actor.mock.calls.length).toBeGreaterThan(initialCalls.actor);
      expect(detail.mock.calls.length).toBeGreaterThan(initialCalls.detail);
      expect(home.mock.calls.length).toBeGreaterThan(initialCalls.home);
      expect(list.mock.calls.length).toBeGreaterThan(initialCalls.list);
    });
    expect(await screen.findByText(/handoff is no longer (?:available|in this queue)/i)).toBeVisible();
    await waitFor(() => expect(routeLocation()).not.toContain("relay="));
  });

  it("keeps a selected handoff recoverable when Refresh hits a transient detail failure", async () => {
    const api = createFixtureApi();
    const originalDetail = api.getRelay.bind(api);
    let unavailable = false;
    vi.spyOn(api, "getRelay").mockImplementation((id) => (
      unavailable
        ? Promise.reject(new HubApiError({
            type: "about:blank",
            title: "Handoff temporarily unavailable",
            status: 503,
            code: "INTERNAL_ERROR",
            detail: "The current Relay detail could not be read. Try again.",
            requestId: "relay-refresh-transient",
          }))
        : originalDetail(id)
    ));
    const user = userEvent.setup();
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();
    unavailable = true;
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("heading", { name: "Handoff temporarily unavailable" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(routeLocation()).toContain(`relay=${RELAY_ID}`);
    expect(screen.queryByText(/handoff is no longer/i)).not.toBeInTheDocument();
  });

  it("shows a draft created outside Hub only after explicit Refresh and keeps its detail lazy", async () => {
    const api = createFixtureApi();
    const draft = await api.getRelayDraft(DRAFT_ID);
    let appeared = false;
    const drafts = vi.spyOn(api, "getRelayDrafts").mockImplementation(async () => (
      appeared
        ? {
            ...emptyRelayDraftPage(),
            items: [{
              id: draft.id,
              revision: draft.revision,
              updatedAt: draft.updatedAt,
              summary: draft.summary,
              recipients: draft.recipients,
            }],
          }
        : emptyRelayDraftPage()
    ));
    const detail = vi.spyOn(api, "getRelayDraft");
    const user = userEvent.setup();
    renderRoute(api, "/relays?view=drafts");

    expect(await screen.findByText("No handoff drafts on this device")).toBeVisible();
    expect(detail).not.toHaveBeenCalled();
    appeared = true;
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    const row = await relayDraftRow(DRAFT_ID);
    expect(drafts.mock.calls.length).toBeGreaterThan(1);
    expect(detail).not.toHaveBeenCalled();
    expect(routeLocation()).not.toContain("draft=");
    await user.click(row);
    await waitFor(() => expect(detail).toHaveBeenCalledWith(DRAFT_ID));
  });

  it("does not poll Relay, actor, Home, or draft reads", async () => {
    vi.useFakeTimers();
    try {
      const api = createFixtureApi();
      const relays = vi.spyOn(api, "getRelays");
      const drafts = vi.spyOn(api, "getRelayDrafts");
      const actor = vi.spyOn(api, "getCurrentActor");
      const home = vi.spyOn(api, "getHome");
      renderRoute(api);

      await vi.waitFor(() => expect(relays).toHaveBeenCalledTimes(1));
      const initialCalls = {
        actor: actor.mock.calls.length,
        home: home.mock.calls.length,
        relays: relays.mock.calls.length,
      };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(relays).toHaveBeenCalledTimes(initialCalls.relays);
      expect(actor).toHaveBeenCalledTimes(initialCalls.actor);
      expect(home).toHaveBeenCalledTimes(initialCalls.home);
      expect(drafts).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps reading non-mutating and applies the exact Take preview through a concise confirmation", async () => {
    const api = createFixtureApi();
    const current = await api.getRelay(RELAY_ID);
    vi.spyOn(api, "getRelay").mockResolvedValue({
      ...current,
      schemaVersion: 1,
      publishedAt: null,
      diagnostics: [{ code: "RELAY_LEGACY_PUBLICATION_TIME", severity: "warning", message: LEGACY_WARNING }],
    });
    const preview = vi.spyOn(api, "previewRelayOperation");
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();
    expect(preview).not.toHaveBeenCalled();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Take handoff" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Take this handoff?" });
    expect(within(dialog).getByText(/sole claimant/i)).toBeVisible();
    expect(within(dialog).getByText(/other eligible Members.*no longer.*take/i)).toBeVisible();
    expect(within(dialog).getByText(/no unclaim or reassignment/i)).toBeVisible();
    expect(within(dialog).getByText(/pull the latest repository state/i)).toBeVisible();
    expect(within(dialog).getByText("Release evidence is ready for the final cross-platform gate.")).toBeVisible();
    expect(within(dialog).getByText(/taking as Ada Lovelace/i)).toBeVisible();
    const technical = within(dialog).getByRole("button", { name: "Technical details" });
    expect(technical).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByText("relay.acknowledge")).not.toBeInTheDocument();

    await userEvent.setup().click(technical);
    expect(technical).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByText("relay.acknowledge")).toBeVisible();
    expect(within(dialog).getByLabelText(/Exact diff for \.mex\/relays\//u)).toBeVisible();
    expect(within(dialog).getByText("codex/hub-ux", { exact: true })).toBeVisible();
    expect(within(dialog).getByText("Dirty", { exact: true })).toBeVisible();

    const exactEnvelope = await preview.mock.results[0]!.value;
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Take handoff" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]![0]).toBe(exactEnvelope);
    expect(await screen.findByText("Handoff claimed in your working tree. Commit and push so the team can see that you took it.")).toBeVisible();
  });

  it("explains eligibility instead of showing a misleading Take action to an unrelated Member", async () => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const relay: RelayDetail = {
      ...base,
      recipients: [{ kind: "member", memberId: GRACE_ID, displayName: "Grace Hopper" }],
    };
    mockSingleRelay(api, relay);
    const preview = vi.spyOn(api, "previewRelayOperation");
    renderRoute(api, `/relays?view=all&state=open&relay=${RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: relay.summary })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Take handoff" })).not.toBeInTheDocument();
    expect(screen.getByText(/This handoff is addressed to Grace Hopper/i)).toBeVisible();
    expect(screen.getByText(/MEX must resolve an eligible, active team identity before taking it/i)).toBeVisible();
    expect(preview).not.toHaveBeenCalled();
  });

  it.each([
    {
      role: "claimant",
      view: "mine",
      relay: {
        sender: { kind: "member" as const, memberId: GRACE_ID, displayName: "Grace Hopper" },
        recipients: [{ kind: "member" as const, memberId: ADA_ID, displayName: "Ada Lovelace" }],
        acknowledgedBy: { kind: "member" as const, memberId: ADA_ID, displayName: "Ada Lovelace" },
      },
      stateLabel: "In your hands",
    },
    {
      role: "sender",
      view: "sent",
      relay: {
        sender: { kind: "member" as const, memberId: ADA_ID, displayName: "Ada Lovelace" },
        recipients: [{ kind: "member" as const, memberId: GRACE_ID, displayName: "Grace Hopper" }],
        acknowledgedBy: { kind: "member" as const, memberId: GRACE_ID, displayName: "Grace Hopper" },
      },
      stateLabel: "Taken by Grace Hopper",
    },
  ])("lets the active $role close an acknowledged handoff when both principals are active", async ({ view, relay: overrides, stateLabel }) => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const relay: RelayDetail = {
      ...base,
      ...overrides,
      state: "acknowledged",
      acknowledgedAt: "2026-08-23T08:40:00.000Z",
    };
    mockSingleRelay(api, relay);
    const preview = vi.spyOn(api, "previewRelayOperation");
    renderRoute(api, `/relays?view=${view}&state=open&relay=${RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: relay.summary })).toBeVisible();
    expect(screen.getAllByText(stateLabel).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close handoff" })).toBeEnabled());
    expect(preview).not.toHaveBeenCalled();
  });

  it("explains that an unrelated observer cannot close another pair's acknowledged handoff", async () => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const relay: RelayDetail = {
      ...base,
      state: "acknowledged",
      sender: { kind: "member", memberId: ADA_ID, displayName: "Ada Lovelace" },
      recipients: [{ kind: "member", memberId: GRACE_ID, displayName: "Grace Hopper" }],
      acknowledgedBy: { kind: "member", memberId: GRACE_ID, displayName: "Grace Hopper" },
      acknowledgedAt: "2026-08-23T08:40:00.000Z",
    };
    mockCurrentMember(api, LIN_ID, "Lin Chen");
    mockSingleRelay(api, relay);
    renderRoute(api, `/relays?view=all&state=open&relay=${RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: relay.summary })).toBeVisible();
    await waitFor(() => expect(screen.getByText(/only the sender or claimant can close this handoff/i)).toBeVisible());
    expect(screen.queryByRole("button", { name: "Close handoff" })).not.toBeInTheDocument();
  });

  it.each([
    {
      principal: "sender",
      view: "mine",
      relay: {
        sender: { kind: "member" as const, memberId: GRACE_ID, displayName: "Grace Hopper" },
        recipients: [{ kind: "member" as const, memberId: ADA_ID, displayName: "Ada Lovelace" }],
        acknowledgedBy: { kind: "member" as const, memberId: ADA_ID, displayName: "Ada Lovelace" },
      },
    },
    {
      principal: "claimant",
      view: "sent",
      relay: {
        sender: { kind: "member" as const, memberId: ADA_ID, displayName: "Ada Lovelace" },
        recipients: [{ kind: "member" as const, memberId: GRACE_ID, displayName: "Grace Hopper" }],
        acknowledgedBy: { kind: "member" as const, memberId: GRACE_ID, displayName: "Grace Hopper" },
      },
    },
  ])("keeps Close unavailable and names an inactive $principal", async ({ view, relay: overrides }) => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const relay: RelayDetail = {
      ...base,
      ...overrides,
      state: "acknowledged",
      acknowledgedAt: "2026-08-23T08:40:00.000Z",
    };
    const getMember = api.getMember.bind(api);
    vi.spyOn(api, "getMember").mockImplementation(async (id) => {
      const member = await getMember(id);
      return id === GRACE_ID ? { ...member, active: false } : member;
    });
    mockSingleRelay(api, relay);
    renderRoute(api, `/relays?view=${view}&state=open&relay=${RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: relay.summary })).toBeVisible();
    await waitFor(() => expect(screen.getByText(/Grace Hopper.*no longer an active team Member.*Reactivate/i)).toBeVisible());
    expect(screen.getByRole("button", { name: "Close handoff" })).toBeDisabled();
  });

  it("renders a closed handoff as calm immutable history with no lifecycle action", async () => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const relay: RelayDetail = {
      ...base,
      state: "closed",
      acknowledgedBy: { kind: "member", memberId: ADA_ID, displayName: "Ada Lovelace" },
      acknowledgedAt: "2026-08-23T08:40:00.000Z",
      closedBy: { kind: "member", memberId: GRACE_ID, displayName: "Grace Hopper" },
      closedAt: "2026-08-23T08:42:00.000Z",
    };
    mockSingleRelay(api, relay);
    renderRoute(api, `/relays?view=all&state=closed&relay=${RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: relay.summary })).toBeVisible();
    expect(screen.getByText(/closed handoff.*(?:immutable|cannot be changed)|immutable.*closed handoff/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Take handoff" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close handoff" })).not.toBeInTheDocument();
  });

  it("applies the exact Close preview after an irreversible semantic confirmation", async () => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const relay: RelayDetail = {
      ...base,
      state: "acknowledged",
      sender: { kind: "member", memberId: ADA_ID, displayName: "Ada Lovelace" },
      recipients: [{ kind: "member", memberId: GRACE_ID, displayName: "Grace Hopper" }],
      acknowledgedBy: { kind: "member", memberId: GRACE_ID, displayName: "Grace Hopper" },
      acknowledgedAt: "2026-08-23T08:40:00.000Z",
    };
    mockSingleRelay(api, relay);
    const preview = vi.spyOn(api, "previewRelayOperation");
    const apply = vi.spyOn(api, "applyRelayOperation");
    const user = userEvent.setup();
    renderRoute(api, `/relays?view=sent&state=open&relay=${RELAY_ID}`);

    const close = await screen.findByRole("button", { name: "Close handoff" });
    expect(preview).not.toHaveBeenCalled();
    await user.click(close);
    const dialog = await screen.findByRole("alertdialog", { name: "Close this handoff?" });
    expect(within(dialog).getByText(/closing is irreversible/i)).toBeVisible();
    expect(within(dialog).getByText(/removes (?:this|the) handoff from open attention/i)).toBeVisible();
    expect(within(dialog).getByText(/saved handoff remains readable in project history/i)).toBeVisible();
    const technical = within(dialog).getByRole("button", { name: "Technical details" });
    expect(technical).toHaveAttribute("aria-expanded", "false");

    const exactEnvelope = await preview.mock.results[0]!.value;
    await user.click(within(dialog).getByRole("button", { name: "Close handoff" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]![0]).toBe(exactEnvelope);
    expect(await screen.findByText("Handoff closed in your working tree. Commit and push to share the final state.")).toBeVisible();
  });

  it("moves to the next open handoff after closing the selected item", async () => {
    const api = createFixtureApi();
    const user = userEvent.setup();
    renderRoute(api, `/relays?view=mine&state=open&relay=${CLAIMED_RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: "Finish the keyboard and screen-reader pass for the Hub review surfaces." })).toBeVisible();
    const close = await screen.findByRole("button", { name: "Close handoff" });
    await user.click(close);
    const dialog = await screen.findByRole("alertdialog", { name: "Close this handoff?" });
    await user.click(within(dialog).getByRole("button", { name: "Close handoff" }));

    expect(await screen.findByText("Handoff closed in your working tree. Commit and push to share the final state.")).toBeVisible();
    await waitFor(() => expect(routeLocation()).toContain(`relay=${RELAY_ID}`));
    expect(await screen.findByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();
  });

  it("does not reselect a stale row when the open queue fails after Close", async () => {
    const api = createFixtureApi();
    const originalList = api.getRelays.bind(api);
    const originalApply = api.applyRelayOperation.bind(api);
    let failOpenList = false;
    vi.spyOn(api, "getRelays").mockImplementation((request) => (
      failOpenList
        ? Promise.reject(new HubApiError({
            type: "about:blank",
            title: "Open handoffs unavailable",
            status: 503,
            code: "INTERNAL_ERROR",
            detail: "The open queue could not be refreshed.",
            requestId: "relay-close-list-failure",
          }))
        : originalList(request)
    ));
    vi.spyOn(api, "applyRelayOperation").mockImplementation(async (envelope) => {
      const result = await originalApply(envelope);
      failOpenList = true;
      return result;
    });
    const user = userEvent.setup();
    renderRoute(api, `/relays?view=mine&state=open&relay=${CLAIMED_RELAY_ID}`);

    await user.click(await screen.findByRole("button", { name: "Close handoff" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Close this handoff?" });
    await user.click(within(dialog).getByRole("button", { name: "Close handoff" }));

    expect(await screen.findByText("The open handoff queue could not be refreshed. Try again before choosing what to open next.")).toBeVisible();
    await waitFor(() => expect(routeLocation()).not.toContain("relay="));
    expect(screen.queryByRole("heading", { name: "Finish the keyboard and screen-reader pass for the Hub review surfaces." })).not.toBeInTheDocument();
  });

  it.each([
    {
      repository: "clean branch",
      state: {
        branch: "feature/standalone-relay",
        head: "abcdef0123456789abcdef0123456789abcdef01",
        dirty: false,
        observedAt: "2026-08-24T10:11:12.000Z",
      },
      branchLabel: "feature/standalone-relay",
      headLabel: /abcdef01/,
      treeLabel: "Clean",
    },
    {
      repository: "dirty branch",
      state: {
        branch: "feature/relay-with-local-work",
        head: "1234567890abcdef1234567890abcdef12345678",
        dirty: true,
        observedAt: "2026-08-24T11:12:13.000Z",
      },
      branchLabel: "feature/relay-with-local-work",
      headLabel: /12345678/,
      treeLabel: "Local changes present",
    },
    {
      repository: "detached HEAD",
      state: {
        branch: null,
        head: "234567890abcdef1234567890abcdef123456789",
        dirty: false,
        observedAt: "2026-08-24T12:13:14.000Z",
      },
      branchLabel: "Detached HEAD",
      headLabel: /23456789/,
      treeLabel: "Clean",
    },
    {
      repository: "unborn branch",
      state: {
        branch: "feature/first-commit",
        head: null,
        dirty: false,
        observedAt: "2026-08-24T13:14:15.000Z",
      },
      branchLabel: "feature/first-commit",
      headLabel: /No committed HEAD recorded/i,
      treeLabel: "Clean",
    },
  ] as const)("presents a standalone handoff's $repository publication state honestly", async ({ state, branchLabel, headLabel, treeLabel }) => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const relay: RelayDetail = {
      ...base,
      schemaVersion: 3,
      workstream: null,
      publishedRepoState: state,
    };
    mockSingleRelay(api, relay);
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    expect(await screen.findByText("Team handoff")).toBeVisible();
    const detail = screen.getByRole("region", { name: "Selected handoff detail" });
    expect(within(detail).getByRole("heading", { name: "Repository when published" })).toBeVisible();
    expect(within(detail).getByText(branchLabel, { exact: true })).toBeVisible();
    expect(within(detail).getByText(headLabel)).toBeVisible();
    expect(within(detail).getByText(treeLabel, { exact: true })).toBeVisible();
    expect(within(detail).getByText("Observed", { exact: true })).toBeVisible();
    expect(detail).not.toHaveTextContent("Recorded Workstream");
    expect(detail).not.toHaveTextContent(WORKSTREAM_ID);

    if (state.dirty) {
      expect(within(detail).getByText("MEX recorded that local changes existed when this handoff was published. Their contents were not captured by the Relay.")).toBeVisible();
    } else {
      expect(within(detail).queryByText(/Their contents were not captured by the Relay/i)).not.toBeInTheDocument();
    }
  });

  it("keeps full publication repository values collapsed under Technical details", async () => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const head = "abcdef0123456789abcdef0123456789abcdef01";
    const observedAt = "2026-08-24T10:11:12.000Z";
    const relay: RelayDetail = {
      ...base,
      schemaVersion: 3,
      workstream: null,
      publishedRepoState: {
        branch: "feature/standalone-relay",
        head,
        dirty: true,
        observedAt,
      },
    };
    mockSingleRelay(api, relay);
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    await screen.findByRole("heading", { name: relay.summary });
    const detail = screen.getByRole("region", { name: "Selected handoff detail" });
    expect(detail).not.toHaveTextContent(head);
    const technical = within(detail).getByRole("button", { name: "Technical details" });
    expect(technical).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(technical);
    expect(within(detail).getByText(head, { exact: true })).toBeVisible();
    expect(within(detail).getAllByText("feature/standalone-relay", { exact: true }).length).toBeGreaterThan(1);
    expect(within(detail).getByText("true", { exact: true })).toBeVisible();
    expect(within(detail).getByText(observedAt, { exact: true })).toBeVisible();
  });

  it.each([1, 2] as const)("shows a schema-v%s Workstream only as legacy related context", async (schemaVersion) => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const relay: RelayDetail = {
      ...base,
      schemaVersion,
      workstream: { kind: "workstream", id: WORKSTREAM_ID, title: "Historical release stream" },
      publishedAt: schemaVersion === 1 ? null : base.publishedAt,
      publishedRepoState: null,
      diagnostics: schemaVersion === 1
        ? [{ code: "RELAY_LEGACY_PUBLICATION_TIME", severity: "warning", message: LEGACY_WARNING }]
        : [],
    };
    mockSingleRelay(api, relay);
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    await screen.findByRole("heading", { name: relay.summary });
    const detail = screen.getByRole("region", { name: "Selected handoff detail" });
    expect(within(detail).queryByRole("heading", { name: "Repository when published" })).not.toBeInTheDocument();
    expect(within(detail).queryByText("Historical release stream", { exact: true })).not.toBeInTheDocument();

    const context = within(detail).getByRole("button", { name: "Related context" });
    await userEvent.setup().click(context);
    expect(within(detail).getByText("Historical release stream", { exact: true })).toBeVisible();
    expect(within(detail).getByRole("heading", { name: "Legacy Workstream" })).toBeVisible();

    const technical = within(detail).getByRole("button", { name: "Technical details" });
    await userEvent.setup().click(technical);
    expect(within(detail).getByText(WORKSTREAM_ID, { exact: true })).toBeVisible();
    expect(within(detail).getByText(/older Relay format.*did not record repository state at publication/i)).toBeVisible();
  });

  it("presents handoff content in human order, hides empty sections, and safely links related context", async () => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const relay: RelayDetail = {
      ...base,
      completed: ["Linux characterization is captured."],
      inProgress: ["Windows verification is running."],
      nextActions: ["Run the remaining storage matrix."],
      blockers: ["The Windows runner is temporarily unavailable."],
      unresolvedQuestions: ["Does the packed install retain the digest?"],
      decisions: [{ id: KNOWLEDGE_ID, kind: "decision", title: "Keep release evidence together" }],
      changedFiles: ["scripts/release-benchmark/run.mjs"],
      code: [
        { kind: "symbol", symbolId: "sym.createHubServer", fingerprint: "symbol-fingerprint-v1" },
        { kind: "file", path: "packages/hub-web/src/pages/RelayPage.tsx", fingerprint: "file-fingerprint-v1" },
      ],
      evidence: [
        { kind: "entity", entity: { id: KNOWLEDGE_ID, kind: "decision", title: "Pinned release gate" } },
        { kind: "code", code: { kind: "symbol", symbolId: "sym.createHubServer", fingerprint: "evidence-fingerprint-v1" } },
        { kind: "external", uri: "https://example.test/release-run", label: "Release run" },
        { kind: "file", path: "artifacts/release-report.txt" },
        { kind: "commit", hash: "a".repeat(40) },
        { kind: "manual", note: "Verified with the pinned fixture." },
      ],
    };
    mockSingleRelay(api, relay);
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    const summary = await screen.findByRole("heading", { name: relay.summary });
    expect(screen.getByText("Team handoff")).toBeVisible();
    const next = screen.getByRole("heading", { name: "What to do next" });
    const standing = screen.getByRole("heading", { name: "Where things stand" });
    const blockers = screen.getByRole("heading", { name: "Blockers" });
    const questions = screen.getByRole("heading", { name: "Questions to resolve" });
    const completed = screen.getByRole("heading", { name: "Already completed" });
    const context = screen.getByRole("button", { name: "Related context" });
    const lifecycle = screen.getByRole("heading", { name: "Lifecycle" });
    const technical = screen.getByRole("button", { name: "Technical details" });
    const detail = screen.getByRole("region", { name: "Selected handoff detail" });
    expectDocumentOrder(summary, next);
    expectDocumentOrder(next, standing);
    expectDocumentOrder(standing, blockers);
    expectDocumentOrder(blockers, questions);
    expectDocumentOrder(questions, completed);
    expectDocumentOrder(completed, context);
    expectDocumentOrder(context, lifecycle);
    expectDocumentOrder(lifecycle, technical);
    expect(context).toHaveAttribute("aria-expanded", "false");
    expect(technical).toHaveAttribute("aria-expanded", "false");
    expect(detail).not.toHaveTextContent(RELAY_ID);
    expect(detail).not.toHaveTextContent("symbol-fingerprint-v1");

    await userEvent.setup().click(context);
    expect(screen.getByRole("heading", { name: "Files involved" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Changed files" })).not.toBeInTheDocument();
    expect(document.querySelector(`a[href="/knowledge/${KNOWLEDGE_ID}"]`)).toBeVisible();
    expect(document.querySelector('a[href="/code/symbols/sym.createHubServer"]')).toBeVisible();
    const external = screen.getByRole("link", { name: "Release run" });
    expect(external).toHaveAttribute("href", "https://example.test/release-run");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external.getAttribute("rel")).toEqual(expect.stringContaining("noopener"));
    expect(external.getAttribute("rel")).toEqual(expect.stringContaining("noreferrer"));
    expect(screen.getByText("artifacts/release-report.txt")).toBeVisible();
    expect(screen.getByText("a".repeat(40))).toBeVisible();
    expect(screen.getByText("Verified with the pinned fixture.")).toBeVisible();
    expect(detail).not.toHaveTextContent("evidence-fingerprint-v1");

    await userEvent.setup().click(technical);
    expect(detail).toHaveTextContent(RELAY_ID);
    expect(detail).toHaveTextContent("symbol-fingerprint-v1");
  });

  it("omits unrecorded semantic sections instead of filling the review with empty cards", async () => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    mockSingleRelay(api, {
      ...base,
      blockers: [],
      unresolvedQuestions: [],
    });
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Blockers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Questions to resolve" })).not.toBeInTheDocument();
    expect(screen.queryByText("None recorded.")).not.toBeInTheDocument();
  });

  it("keeps manual creation tertiary inside the agent-first empty Drafts state", async () => {
    const api = createFixtureApi();
    vi.spyOn(api, "getRelayDrafts").mockResolvedValue(emptyRelayDraftPage());
    renderRoute(api, "/relays?view=drafts");

    const title = await screen.findByText("No handoff drafts on this device");
    const empty = title.closest('[data-slot="empty"]');
    expect(empty).not.toBeNull();
    expect(within(empty as HTMLElement).getByText("Your coding agent can prepare a structured Relay when you pause or hand work to a teammate.")).toBeVisible();
    const create = within(empty as HTMLElement).getByRole("button", { name: "Create manually" });
    expect(create).toBeVisible();
    expect(create).toHaveClass("bg-transparent");
    expect(screen.queryByRole("button", { name: "Publish handoff" })).not.toBeInTheDocument();
  });

  it("gives a selected draft a simple Publish, Edit, and overflow Delete hierarchy", async () => {
    const user = userEvent.setup();
    renderRoute(createFixtureApi(), `/relays?view=drafts&draft=${DRAFT_ID}`);

    expect(await screen.findByRole("heading", { name: "Carry the release evidence through the final cross-platform gate." })).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish handoff" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit wording" })).toBeVisible();
    const overflow = screen.getByRole("button", { name: "More draft actions" });
    await user.click(overflow);
    expect(await screen.findByRole("menuitem", { name: "Delete draft" })).toBeVisible();
  });

  it("uses a searchable keyboard-operable member Combobox with selected-member chips and progressive fields", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const composer = await editSelectedDraft(user, api);
    const recipients = within(composer).getByRole("combobox", { name: "Eligible recipients" });
    const chips = recipients.closest('[data-slot="combobox-chips"]');
    expect(chips).not.toBeNull();
    expect(within(chips as HTMLElement).getByText("Grace Hopper")).toBeVisible();

    await user.click(recipients);
    await user.type(recipients, "Ada");
    expect(await screen.findByRole("option", { name: "Ada Lovelace" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Lin Chen" })).not.toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(within(chips as HTMLElement).getByText("Ada Lovelace")).toBeVisible());
    expect(within(chips as HTMLElement).getByText("Grace Hopper")).toBeVisible();

    expect(within(composer).getByRole("textbox", { name: "Summary" })).toBeVisible();
    expect(within(composer).getByRole("button", { name: "Add next actions" })).toBeVisible();
    expect(within(composer).getByRole("button", { name: "Add in progress" })).toBeVisible();
    expect(within(composer).getByRole("button", { name: "Add blockers" })).toBeVisible();
    expect(within(composer).getByRole("button", { name: "Add unresolved questions" })).toBeVisible();

    const additional = within(composer).getByRole("button", { name: "Additional context" });
    const advanced = within(composer).getByRole("button", { name: "Advanced" });
    expect(additional).toHaveAttribute("aria-expanded", "false");
    expect(advanced).toHaveAttribute("aria-expanded", "false");
    expect(within(composer).queryByRole("button", { name: "Add completed" })).not.toBeInTheDocument();
    expect(within(composer).queryByRole("textbox", { name: "Workstream ID" })).not.toBeInTheDocument();

    await user.click(additional);
    expect(additional).toHaveAttribute("aria-expanded", "true");
    expect(within(composer).getByRole("button", { name: "Add completed" })).toBeVisible();
    expect(within(composer).getByRole("button", { name: "Add decision" })).toBeVisible();
    expect(within(composer).getByRole("button", { name: "Add code reference" })).toBeVisible();
    expect(within(composer).getByRole("button", { name: "Add evidence" })).toBeVisible();
    expect(within(composer).getByText("Files involved")).toBeVisible();

    await user.click(advanced);
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    expect(within(composer).getByText(DRAFT_ID)).toBeVisible();
    expect(within(composer).queryByRole("combobox", { name: "Workstream" })).not.toBeInTheDocument();
    expect(within(composer).queryByRole("textbox", { name: "Workstream ID" })).not.toBeInTheDocument();
    expect(within(composer).queryByRole("textbox", { name: "Workstream title" })).not.toBeInTheDocument();
  });

  it("never fetches or selects a Workstream while reading and editing a standalone draft", async () => {
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewRelayOperation");
    const user = userEvent.setup();
    renderRoute(api, `/relays?view=drafts&draft=${DRAFT_ID}`);

    await user.click(await screen.findByRole("button", { name: "Edit wording" }));
    const composer = await screen.findByRole("dialog", { name: "Edit handoff draft" });
    expect(within(composer).getByRole("combobox", { name: "Eligible recipients" })).toBeVisible();
    expect(within(composer).getByRole("textbox", { name: "Summary" })).toBeVisible();
    expect(within(composer).queryByRole("combobox", { name: "Workstream" })).not.toBeInTheDocument();
    expect(within(composer).queryByText(/Workstream.*(?:required|eligible|offline)/i)).not.toBeInTheDocument();
    expect(preview).not.toHaveBeenCalled();
  });

  it("preserves every hidden structured value when only draft wording is edited", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const original = await api.getRelayDraft(DRAFT_ID);
    const richInput = {
      ...original.input,
      recipients: [
        { kind: "member" as const, memberId: GRACE_ID, displayName: "Grace Hopper" },
        { kind: "member" as const, memberId: ADA_ID, displayName: "Ada Lovelace" },
      ],
      completed: ["Pinned the deterministic release fixture."],
      inProgress: ["Reviewing the packed-install boundary."],
      decisions: [
        { id: "release-order", kind: "decision", title: "Keep the release evidence together" },
        { id: "relay-boundary", kind: "constraint", title: "Keep delivery repository-native" },
      ],
      blockers: ["Windows evidence has not landed."],
      unresolvedQuestions: ["Does the packed install retain the digest?"],
      changedFiles: ["src/team/relay/handoff.ts", "packages/hub-web/src/pages/RelayPage.tsx"],
      code: [
        { kind: "symbol" as const, symbolId: "relay.preview.accept", fingerprint: "preview-v1" },
        { kind: "file" as const, path: "packages/hub-web/src/pages/RelayPage.tsx", fingerprint: "page-v1" },
      ],
      evidence: [
        { kind: "entity" as const, entity: { id: "decision-1", kind: "decision", title: "Pinned gate" } },
        { kind: "code" as const, code: { kind: "symbol" as const, symbolId: "relay.apply", fingerprint: "f".repeat(64) } },
        { kind: "file" as const, path: "src/relay.ts" },
        { kind: "commit" as const, hash: "a".repeat(40) },
        { kind: "external" as const, uri: "https://example.test/run", label: "Run" },
        { kind: "manual" as const, note: "Observed locally." },
      ],
      nextActions: ["Run the cross-platform matrix."],
    } satisfies RelayDraftInput;
    const prepared = await api.previewRelayOperation({
      operationId: "relay_prepare_hidden_context",
      action: { kind: "relay.draft.save", draftId: original.id, draft: richInput },
      expectedRevisions: [{ target: { kind: "local", namespace: "relay-draft", id: original.id }, revision: original.revision }],
    });
    await api.applyRelayOperation(prepared);
    const current = await api.getRelayDraft(DRAFT_ID);
    const preview = vi.spyOn(api, "previewRelayOperation");
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api, `/relays?view=drafts&draft=${DRAFT_ID}`);

    await user.click(await screen.findByRole("button", { name: "Edit wording" }));
    const composer = await screen.findByRole("dialog", { name: "Edit handoff draft" });
    expect(within(composer).getByRole("button", { name: "Additional context" })).toHaveAttribute("aria-expanded", "false");
    expect(within(composer).getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.change(within(composer).getByRole("textbox", { name: "Summary" }), { target: { value: "Edited without losing structured context." } });
    await user.click(within(composer).getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(preview).toHaveBeenCalledTimes(1);
    const request = preview.mock.calls[0]![0];
    expect(request).toEqual({
      operationId: expect.stringMatching(/^hub_relay_draft_save_/),
      action: {
        kind: "relay.draft.save",
        draftId: current.id,
        draft: { ...richInput, summary: "Edited without losing structured context." },
      },
      expectedRevisions: [{ target: { kind: "local", namespace: "relay-draft", id: current.id }, revision: current.revision }],
    });
    const exactEnvelope = await preview.mock.results[0]!.value;
    expect(apply.mock.calls[0]![0]).toBe(exactEnvelope);
    expect(screen.queryByRole("alertdialog", { name: /local draft preview/i })).not.toBeInTheDocument();
  });

  it("fails a one-click local Save closed when its preview is invalid", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewRelayOperation.bind(api);
    vi.spyOn(api, "previewRelayOperation").mockImplementationOnce(async (request) => {
      const result = await realPreview(request);
      return {
        ...result,
        preview: {
          ...result.preview,
          valid: false,
          diagnostics: [{ code: "RELAY_DRAFT_REVISION_STALE", severity: "error", message: "The local draft changed before it could be saved." }],
        },
      };
    });
    const apply = vi.spyOn(api, "applyRelayOperation");
    const composer = await editSelectedDraft(user, api);

    fireEvent.change(within(composer).getByRole("textbox", { name: "Summary" }), { target: { value: "A locally edited summary." } });
    await user.click(within(composer).getByRole("button", { name: "Save draft" }));

    expect(await within(composer).findByText(/could not be saved|cannot be saved|changed before it could be saved/i)).toBeVisible();
    expect(apply).not.toHaveBeenCalled();
    expect(within(composer).getByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("does not apply an in-flight local Save after a newer composer edit invalidates it", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewRelayOperation.bind(api);
    const delayed = deferred<RelayOperationPreviewResponse>();
    let staleRequest: RelayOperationPreviewRequest | undefined;
    vi.spyOn(api, "previewRelayOperation").mockImplementationOnce((request) => {
      staleRequest = request;
      return delayed.promise;
    });
    const apply = vi.spyOn(api, "applyRelayOperation");
    const composer = await editSelectedDraft(user, api);
    const summary = within(composer).getByRole("textbox", { name: "Summary" });
    fireEvent.change(summary, { target: { value: "The first visible save." } });
    await user.click(within(composer).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(staleRequest).toBeDefined());

    fireEvent.change(summary, { target: { value: "The visible draft changed after preview began." } });
    const staleEnvelope = await realPreview(staleRequest!);
    await act(async () => {
      delayed.resolve(staleEnvelope);
      await delayed.promise;
    });

    expect(apply).not.toHaveBeenCalled();
    expect(within(composer).getByRole("textbox", { name: "Summary" })).toHaveValue("The visible draft changed after preview began.");
    await waitFor(() => expect(within(composer).getByRole("button", { name: "Save draft" })).toBeEnabled());
  });

  it("accepts and applies the exact signed draft preview when the service canonically reorders set-like fields", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const original = await api.getRelayDraft(DRAFT_ID);
    const setRichInput = {
      ...original.input,
      recipients: [
        { kind: "member" as const, memberId: GRACE_ID, displayName: "Grace Hopper" },
        { kind: "member" as const, memberId: ADA_ID, displayName: "Ada Lovelace" },
      ],
      decisions: [
        { id: "release-order", kind: "decision", title: "Keep the release evidence together" },
        { id: "relay-boundary", kind: "constraint", title: "Keep delivery repository-native" },
      ],
      changedFiles: ["src/team/relay/handoff.ts", "packages/hub-web/src/pages/RelayPage.tsx"],
      code: [
        { kind: "symbol" as const, symbolId: "relay.preview.accept", fingerprint: "preview-v1" },
        { kind: "file" as const, path: "packages/hub-web/src/pages/RelayPage.tsx", fingerprint: "page-v1" },
      ],
    };
    const prepared = await api.previewRelayOperation({
      operationId: "relay_prepare_set_order",
      action: { kind: "relay.draft.save", draftId: original.id, draft: setRichInput },
      expectedRevisions: [{ target: { kind: "local", namespace: "relay-draft", id: original.id }, revision: original.revision }],
    });
    await api.applyRelayOperation(prepared);

    const realPreview = api.previewRelayOperation.bind(api);
    let reorderedEnvelope: RelayOperationPreviewResponse | undefined;
    vi.spyOn(api, "previewRelayOperation").mockImplementationOnce(async (request) => {
      const result = await realPreview(request);
      if (result.request.action.kind !== "relay.draft.save") throw new Error("Expected a Relay draft save preview.");
      const draft = result.request.action.draft;
      reorderedEnvelope = {
        ...result,
        request: {
          ...result.request,
          action: {
            ...result.request.action,
            draft: {
              ...draft,
              recipients: [...draft.recipients].reverse(),
              decisions: [...draft.decisions].reverse(),
              changedFiles: [...draft.changedFiles].reverse(),
              code: [...draft.code].reverse(),
            },
          },
        },
      };
      return reorderedEnvelope;
    });
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api, `/relays?view=drafts&draft=${DRAFT_ID}`);

    await user.click(await screen.findByRole("button", { name: "Edit wording" }));
    const composer = await screen.findByRole("dialog", { name: "Edit handoff draft" });
    await user.click(within(composer).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]![0]).toBe(reorderedEnvelope);
    expect(screen.queryByRole("alertdialog", { name: /local draft preview/i })).not.toBeInTheDocument();
  });

  it("rejects a crossed preview whose echoed request differs from the exact submitted request", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewRelayOperation.bind(api);
    const delayed = deferred<RelayOperationPreviewResponse>();
    let submitted: RelayOperationPreviewRequest | undefined;
    vi.spyOn(api, "previewRelayOperation").mockImplementationOnce((request) => {
      submitted = request;
      return delayed.promise;
    });
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    await user.click(await screen.findByRole("button", { name: "Take handoff" }));
    const review = await screen.findByRole("alertdialog", { name: "Take this handoff?" });
    await waitFor(() => expect(submitted).toBeDefined());
    const exact = await realPreview(submitted!);
    if (exact.request.action.kind !== "relay.acknowledge") throw new Error("Expected an acknowledge preview.");
    const crossed: RelayOperationPreviewResponse = {
      ...exact,
      request: {
        ...exact.request,
        action: { ...exact.request.action, relayId: "relay_02000000000000000000000001" },
      },
    };
    await act(async () => {
      delayed.resolve(crossed);
      await delayed.promise;
    });

    expect(await within(review).findByRole("heading", { name: "The handoff changed while it was being checked" })).toBeVisible();
    expect(within(review).getByText("Nothing was applied. Check the current handoff again before continuing.")).toBeVisible();
    const technical = within(review).getByRole("button", { name: "Technical details" });
    expect(technical).toHaveAttribute("aria-expanded", "false");
    expect(within(review).getByRole("button", { name: "Take handoff" })).toBeDisabled();
    expect(apply).not.toHaveBeenCalled();
    await user.click(technical);
    expect(within(review).getByText("The signed Relay preview did not exactly match the submitted request. Prepare a fresh preview before applying.")).toBeVisible();
  });

  it("never reuses an exact envelope after apply reports a revision conflict", async () => {
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewRelayOperation");
    const apply = vi.spyOn(api, "applyRelayOperation").mockRejectedValueOnce(new HubApiError({
      type: "about:blank",
      title: "The handoff changed in the working tree",
      status: 409,
      code: "REVISION_CONFLICT",
      detail: "Refresh the Relay and check the action again.",
      requestId: "relay-apply-conflict",
    }));
    const user = userEvent.setup();
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    await user.click(await screen.findByRole("button", { name: "Take handoff" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Take this handoff?" });
    const confirm = within(dialog).getByRole("button", { name: "Take handoff" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    expect(await within(dialog).findByRole("heading", { name: "The handoff changed in the working tree" })).toBeVisible();
    expect(confirm).toBeDisabled();
    expect(apply).toHaveBeenCalledTimes(1);
    const failedEnvelope = apply.mock.calls[0]![0];
    await user.click(within(dialog).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await preview.mock.results[1]!.value).not.toBe(failedEnvelope);
  });

  it("does not let a review retry response resurrect after the dialog invalidates its attempt", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewRelayOperation.bind(api);
    const delayedRetry = deferred<RelayOperationPreviewResponse>();
    let retryRequest: RelayOperationPreviewRequest | undefined;
    vi.spyOn(api, "previewRelayOperation")
      .mockImplementationOnce(async (request) => {
        const result = await realPreview(request);
        return {
          ...result,
          request: { ...result.request, operationId: "hub_relay_crossed_operation" },
        };
      })
      .mockImplementationOnce((request) => {
        retryRequest = request;
        return delayedRetry.promise;
      });
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    const claim = await screen.findByRole("button", { name: "Take handoff" });
    await user.click(claim);
    const review = await screen.findByRole("alertdialog", { name: "Take this handoff?" });
    await user.click(await within(review).findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(retryRequest).toBeDefined());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Take this handoff?" })).not.toBeInTheDocument());

    const exactRetry = await realPreview(retryRequest!);
    await act(async () => {
      delayedRetry.resolve(exactRetry);
      await delayedRetry.promise;
    });

    expect(screen.queryByRole("alertdialog", { name: "Take this handoff?" })).not.toBeInTheDocument();
    expect(claim).toHaveFocus();
    expect(apply).not.toHaveBeenCalled();
  });

  it("saves an open-to-team draft without Member reads, then publishes only after exact review", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const members = vi.spyOn(api, "getMembers");
    const member = vi.spyOn(api, "getMember");
    const preview = vi.spyOn(api, "previewRelayOperation");
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api, "/relays?view=drafts");
    await user.click(await screen.findByRole("button", { name: "Create manually" }));
    const composer = await screen.findByRole("dialog", { name: "Create handoff draft" });
    expect(within(composer).getByRole("combobox", { name: "Who can take this handoff?" })).toHaveValue("team");
    expect(within(composer).queryByRole("combobox", { name: "Eligible recipients" })).not.toBeInTheDocument();
    fireEvent.change(within(composer).getByRole("textbox", { name: "Summary" }), { target: { value: "Context for whoever joins this work next" } });
    await user.click(within(composer).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(preview.mock.calls[0]![0]).toMatchObject({ action: { kind: "relay.draft.save", draft: { audience: "team", recipients: [] } }, expectedRevisions: [] });
    expect(apply.mock.calls[0]![0]).toBe(await preview.mock.results[0]!.value);
    await waitFor(() => expect(routeLocation()).toContain("draft=relay-draft-02"));
    expect(await screen.findByText(/Saved only in this checkout/)).toBeVisible();
    expect(members).not.toHaveBeenCalled();
    expect(member).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Publish handoff" }));
    const review = await screen.findByRole("alertdialog", { name: "Publish this handoff?" });
    const confirm = within(review).getByRole("button", { name: "Publish handoff" });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(within(review).getByText(/Any active Member, including teammates who join later/)).toBeVisible();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[1]![0].expectedRevisions).toEqual([{ target: { kind: "local", namespace: "relay-draft", id: "relay-draft-02" }, revision: "c".repeat(64) }]);
    expect(members).not.toHaveBeenCalled();
    expect(member).not.toHaveBeenCalled();
    await user.click(confirm);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]![0]).toBe(await preview.mock.results[1]!.value);
    expect(await screen.findByText("Published working-tree artifact.")).toBeVisible();
    expect(screen.getByText(/MEX has not verified commit, push, or receipt/)).toBeVisible();
    expect(screen.getByText(/Any active Member can take this handoff, including teammates who join later/)).toBeVisible();
  });

  it("allows a recipient-free named local draft but requires choosing an audience before publication", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api, "/relays?view=drafts");
    await user.click(await screen.findByRole("button", { name: "Create manually" }));
    const composer = await screen.findByRole("dialog", { name: "Create handoff draft" });
    await user.selectOptions(within(composer).getByRole("combobox", { name: "Who can take this handoff?" }), "members");
    fireEvent.change(within(composer).getByRole("textbox", { name: "Summary" }), { target: { value: "Choose a recipient later" } });
    await user.click(within(composer).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Choose named Members or open this handoff to the team/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish handoff" })).toBeDisabled();
  });

  it("allows a newly joined active Member to review taking an open-to-team Relay", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const existing = await api.getRelay(RELAY_ID);
    const relay: RelayDetail = { ...existing, schemaVersion: 4, audience: "team", recipients: [], summary: "Open handoff created before the teammate joined" };
    mockSingleRelay(api, relay);
    mockCurrentMember(api, "member_05000000000000000000000001", "New teammate");
    const preview = vi.spyOn(api, "previewRelayOperation");
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api, `/relays?view=mine&relay=${RELAY_ID}`);
    const take = await screen.findByRole("button", { name: "Take handoff" });
    expect(take).toBeEnabled();
    expect(screen.getByText(/including teammates who join later/)).toBeVisible();
    await user.click(take);
    const review = await screen.findByRole("alertdialog", { name: "Take this handoff?" });
    await waitFor(() => expect(within(review).getByRole("button", { name: "Take handoff" })).toBeEnabled());
    expect(preview.mock.calls[0]![0]).toMatchObject({ action: { kind: "relay.acknowledge", relayId: RELAY_ID }, expectedRevisions: [{ target: { kind: "artifact", path: relay.sourcePath }, revision: relay.revision }] });
    expect(apply).not.toHaveBeenCalled();
  });

  it("saves a standalone sparse draft without any Workstream query or payload field", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewRelayOperation");
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api, "/relays?view=drafts");

    const trigger = await screen.findByRole("button", { name: "Create manually" });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    const composer = await screen.findByRole("dialog", { name: "Create handoff draft" });
    await user.selectOptions(within(composer).getByRole("combobox", { name: "Who can take this handoff?" }), "members");
    const recipients = within(composer).getByRole("combobox", { name: "Eligible recipients" });
    await user.type(recipients, "Grace");
    await user.click(await screen.findByRole("option", { name: "Grace Hopper" }));
    fireEvent.change(within(composer).getByRole("textbox", { name: "Summary" }), { target: { value: "Standalone local handoff for a teammate." } });
    await user.click(within(composer).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const request = preview.mock.calls[0]![0];
    expect(request.expectedRevisions).toEqual([]);
    expect(request.action).toEqual({
      kind: "relay.draft.save",
      draft: {
        audience: "members",
        recipients: [{ kind: "member", memberId: GRACE_ID, displayName: "Grace Hopper" }],
        summary: "Standalone local handoff for a teammate.",
        completed: [],
        inProgress: [],
        decisions: [],
        blockers: [],
        unresolvedQuestions: [],
        changedFiles: [],
        code: [],
        evidence: [],
        nextActions: [],
      },
    });
    if (request.action.kind !== "relay.draft.save") throw new Error("Expected a standalone draft save request.");
    expect("workstream" in request.action.draft).toBe(false);
    expect(apply.mock.calls[0]![0]).toBe(await preview.mock.results[0]!.value);
  });

  it("keeps local composition available through Advanced raw IDs when Members cannot be listed", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    vi.spyOn(api, "getMembers").mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "3".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    const preview = vi.spyOn(api, "previewRelayOperation");
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api, "/relays?view=drafts");

    await user.click(await screen.findByRole("button", { name: "Create manually" }));
    const composer = await screen.findByRole("dialog", { name: "Create handoff draft" });
    await user.selectOptions(within(composer).getByRole("combobox", { name: "Who can take this handoff?" }), "members");
    await user.click(within(composer).getByRole("button", { name: "Advanced" }));
    await user.type(within(composer).getByRole("textbox", { name: "Recipient Member ID" }), GRACE_ID);
    await user.click(within(composer).getByRole("button", { name: "Add recipient ID" }));
    expect(within(composer).getByText(GRACE_ID)).toBeVisible();
    fireEvent.change(within(composer).getByRole("textbox", { name: "Summary" }), { target: { value: "A local handoff prepared without a Member list." } });
    await user.click(within(composer).getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({
        kind: "relay.draft.save",
        draft: expect.objectContaining({
          recipients: [{ kind: "member", memberId: GRACE_ID }],
        }),
      }),
    }));
    expect(apply.mock.calls[0]![0]).toBe(await preview.mock.results[0]!.value);
  });

  it("publishes across an explicit privacy boundary with only draft and recipient dependencies, then opens the new Sent handoff", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const exactMember = api.getMember.bind(api);
    const member = vi.spyOn(api, "getMember").mockImplementation(exactMember);
    const preview = vi.spyOn(api, "previewRelayOperation");
    const apply = vi.spyOn(api, "applyRelayOperation");
    const relayList = vi.spyOn(api, "getRelays");
    renderRoute(api, `/relays?view=drafts&draft=${DRAFT_ID}`);

    const publish = await screen.findByRole("button", { name: "Publish handoff" });
    await waitFor(() => expect(publish).toBeEnabled());
    expect(member).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    await user.click(publish);
    const dialog = await screen.findByRole("alertdialog", { name: "Publish this handoff?" });
    expect(member).toHaveBeenCalledWith(GRACE_ID);
    expect(within(dialog).getByText(/writes a Relay Markdown artifact.*working tree/i)).toBeVisible();
    expect(within(dialog).getByText(/records branch, HEAD, clean or dirty state, and observation time/i)).toBeVisible();
    expect(within(dialog).getByText(/commit and push.*share it/i)).toBeVisible();
    expect(within(dialog).getByText(/does not create a commit or capture source-file or local-change contents/i)).toBeVisible();
    expect(await within(dialog).findByText(/Acting as Ada Lovelace/i)).toBeVisible();
    const repositoryAtPublication = within(dialog).getByText(/codex\/hub-ux,/i).closest("p");
    expect(repositoryAtPublication).not.toBeNull();
    expect(repositoryAtPublication as HTMLElement).toHaveTextContent(/Repository at publication:.*codex\/hub-ux.*HEAD aeaf0ab0.*local changes present.*observed/i);
    const technical = within(dialog).getByRole("button", { name: "Technical details" });
    expect(technical).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByText(`.mex/team/members/${GRACE_ID}.md`)).not.toBeInTheDocument();

    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    const request = preview.mock.calls[0]![0];
    expect(request.action).toEqual({ kind: "relay.publish", draftId: DRAFT_ID });
    expect(request.expectedRevisions).toHaveLength(2);
    expect(request.expectedRevisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: { kind: "local", namespace: "relay-draft", id: DRAFT_ID } }),
      expect.objectContaining({ target: { kind: "artifact", path: `.mex/team/members/${GRACE_ID}.md` } }),
    ]));
    expect(request.expectedRevisions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ path: expect.stringContaining(".mex/workstreams/") }) }),
    ]));
    const exactEnvelope = await preview.mock.results[0]!.value;
    await user.click(within(dialog).getByRole("button", { name: "Publish handoff" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]![0]).toBe(exactEnvelope);

    expect(await screen.findByText("Handoff created in your working tree. Commit and push it so teammates can receive it.")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Sent" })).toHaveAttribute("aria-selected", "true"));
    expect(within(screen.getByRole("group", { name: "Relay state" })).getByRole("button", { name: "Open" }))
      .toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(routeLocation()).toContain("view=sent"));
    expect(routeLocation()).toContain("state=open");
    expect(routeLocation()).toContain("relay=relay_02000000000000000000000001");
    expect(relayList).toHaveBeenCalledWith({ perspective: "sent", states: ["published", "acknowledged"], limit: 25 });
    expect(await screen.findByRole("heading", { name: "Carry the release evidence through the final cross-platform gate." })).toBeVisible();
  });

  it("does not let an unavailable Workstream service block standalone publication", async () => {
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewRelayOperation");
    renderRoute(api, `/relays?view=drafts&draft=${DRAFT_ID}`);

    const publish = await screen.findByRole("button", { name: "Publish handoff" });
    await userEvent.setup().click(publish);
    expect(await screen.findByRole("alertdialog", { name: "Publish this handoff?" })).toBeVisible();
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(preview.mock.calls[0]![0].expectedRevisions).toHaveLength(2);
  });

  it("deletes a local draft through its overflow with normal confirmation and focus return", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewRelayOperation");
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api, `/relays?view=drafts&draft=${DRAFT_ID}`);

    await user.click(await screen.findByRole("button", { name: "More draft actions" }));
    const firstDelete = await screen.findByRole("menuitem", { name: "Delete draft" });
    const overflow = document.querySelector<HTMLButtonElement>('[data-slot="dropdown-menu-trigger"][aria-label="More draft actions"]');
    expect(overflow).not.toBeNull();
    await user.click(firstDelete);
    const firstDialog = await screen.findByRole("alertdialog", { name: "Delete this handoff draft?" });
    expect(within(firstDialog).getByText(/removes only the checkout-local draft/i)).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Delete this handoff draft?" })).not.toBeInTheDocument());
    expect(overflow).toHaveFocus();
    expect(apply).not.toHaveBeenCalled();

    await user.click(overflow!);
    await user.click(await screen.findByRole("menuitem", { name: "Delete draft" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this handoff draft?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete draft" })).toBeEnabled());
    const request = preview.mock.calls.at(-1)![0];
    expect(request.action).toEqual({ kind: "relay.draft.delete", draftId: DRAFT_ID });
    expect(request.expectedRevisions).toEqual([
      expect.objectContaining({ target: { kind: "local", namespace: "relay-draft", id: DRAFT_ID } }),
    ]);
    const exactEnvelope = await preview.mock.results.at(-1)!.value;
    await user.click(within(dialog).getByRole("button", { name: "Delete draft" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]![0]).toBe(exactEnvelope);
    expect(await screen.findByText("Hand off the standalone Relay follow-up.")).toBeVisible();
    expect(document.querySelector(`button[data-relay-draft-id="${DRAFT_ID}"]`)).not.toBeInTheDocument();
  });

  it("keeps All and Drafts reachable without Member authority and surfaces legacy warnings", async () => {
    const api = createFixtureApi();
    vi.spyOn(api, "getCurrentActor").mockResolvedValue({
      actor: { kind: "git", name: "Unmatched", email: "unmatched@example.test" },
      source: "git-fallback",
      selection: null,
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    const base = await api.getRelay(RELAY_ID);
    const legacy: RelayDetail = {
      ...base,
      schemaVersion: 1,
      publishedAt: null,
      diagnostics: [{ code: "RELAY_LEGACY_PUBLICATION_TIME", severity: "warning", message: LEGACY_WARNING }],
    };
    vi.spyOn(api, "getRelays").mockResolvedValue({
      items: [summaryOf(legacy)],
      nextCursor: null,
      truncated: false,
      sourceTruncated: true,
      deterministicRevision: "5".repeat(64),
      diagnostics: [...legacy.diagnostics, ...legacy.diagnostics],
      diagnosticsTruncated: false,
    });
    vi.spyOn(api, "getRelay").mockResolvedValue(legacy);
    renderRoute(api);

    expect(await screen.findByText(/select an active team identity/i)).toBeVisible();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Drafts on this device" }));
    expect(await screen.findByText("Carry the release evidence through the final cross-platform gate.")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Team" }));
    await userEvent.setup().click(await screen.findByRole("button", { name: /Release evidence is ready for the final cross-platform gate/i }));
    expect(await screen.findByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();
    expect(await screen.findAllByText(LEGACY_WARNING)).toHaveLength(2);
    expect(screen.getByText(/Legacy publication time unavailable/)).toBeVisible();
    expect(screen.getByText("Relay results were bounded because the canonical source exceeded its safe read limit.")).toBeVisible();
    expect(screen.getAllByText(/select an active team identity/i).length).toBeGreaterThan(0);
  });

  it("does not offer lifecycle actions when that capability is unavailable", async () => {
    const api = createFixtureApi();
    const capabilities = await api.getCapabilities();
    vi.spyOn(api, "getCapabilities").mockResolvedValue({
      ...capabilities,
      relays: {
        ...capabilities.relays,
        lifecycleMutation: { availability: "unavailable", reason: "Lifecycle mutation is intentionally disconnected." },
      },
    });
    renderRoute(api, `/relays?view=mine&state=open&relay=${RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();
    expect(screen.getByRole("button", { name: "Take handoff" })).toBeDisabled();
    expect(screen.getByText("Lifecycle mutation is intentionally disconnected.")).toBeVisible();
  });

  it("does not load close principals when lifecycle mutation is unavailable", async () => {
    const api = createFixtureApi();
    const capabilities = await api.getCapabilities();
    vi.spyOn(api, "getCapabilities").mockResolvedValue({
      ...capabilities,
      relays: {
        ...capabilities.relays,
        lifecycleMutation: { availability: "unavailable", reason: "Closing handoffs is unavailable in this Hub process." },
      },
    });
    const member = vi.spyOn(api, "getMember");
    renderRoute(api, `/relays?view=mine&state=open&relay=${CLAIMED_RELAY_ID}`);

    expect(await screen.findByRole("heading", { name: "Finish the keyboard and screen-reader pass for the Hub review surfaces." })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close handoff" })).toBeDisabled();
    expect(screen.getByText("Closing handoffs is unavailable in this Hub process.")).toBeVisible();
    expect(member).not.toHaveBeenCalled();
  });
});
