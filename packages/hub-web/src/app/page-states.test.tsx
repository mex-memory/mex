import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HubApiError, type HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import type {
  ActivityItem,
  ActivityResponse,
  CapabilitiesResponse,
  HealthResponse,
  JobSummary,
  JobsResponse,
  OverviewResponse,
  SearchResponse,
} from "../api/types";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

function apiWith(overrides: Partial<HubApi>): HubApi {
  const fixture = createFixtureApi();
  return Object.assign(fixture, overrides);
}

function renderRoute(route: string, api: HubApi, providedQueryClient?: QueryClient) {
  const queryClient = providedQueryClient ?? new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={api}>
        <MemoryRouter initialEntries={[route]}>
          <AppRoutes />
        </MemoryRouter>
      </HubApiProvider>
    </QueryClientProvider>,
  );
  return Object.assign(result, { queryClient });
}

function pending<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

const unavailable = (reason: string) => ({ availability: "unavailable" as const, reason });

describe("Home states", () => {
  it("renders independently loading atlas panels from the Overview aggregate", async () => {
    renderRoute("/", apiWith({ getOverview: () => pending<OverviewResponse>() }));

    expect(await screen.findByText("Loading project overview", undefined, { timeout: 10_000 })).toBeVisible();
    expect(screen.getByLabelText("Loading Context")).toBeVisible();
    expect(screen.getByLabelText("Loading Attention")).toBeVisible();
    expect(screen.getByLabelText("Loading Latest team memory")).toBeVisible();
    expect(screen.getByLabelText("Loading Context readiness")).toBeVisible();
  }, 15_000);

  it("renders established focus, semantic team memory, stale context, and an exact active operation", async () => {
    renderRoute("/", createFixtureApi({ overviewFixture: "established" }));

    expect(await screen.findByRole("heading", { name: "Context", exact: true }, { timeout: 10_000 })).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Context", exact: true }))
      .getByRole("button", { name: "Open Context" })).toHaveAttribute("href", "/knowledge");
    expect(await screen.findByRole("heading", { name: "Take the handoff waiting for you" })).toBeVisible();
    expect(screen.queryByText("Review 3 proposed Spec changes")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Attention" })).toBeVisible();
    expect(screen.getByRole("button", { name: "View Relays" })).toHaveAttribute("href", "/relays");
    expect(screen.getByRole("button", { name: "Open handoff" })).toHaveAttribute(
      "href",
      "/relays?view=mine&state=open&relay=relay_01000000000000000000000001",
    );
    expect(screen.getByText("Continue the handoff you took").closest("a")).toHaveAttribute(
      "href",
      "/relays?view=mine&state=open&relay=relay_01000000000000000000000002",
    );
    expect(screen.getByRole("heading", { name: "Latest team memory" })).toBeVisible();
    expect(screen.getByText("Proposed a Spec change")).toBeVisible();
    expect(screen.getByText("Took a handoff")).toBeVisible();
    expect(screen.getByText("Recorded “relay.closed”")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Context readiness" })).toBeVisible();
    expect(screen.getByText("179/183")).toBeVisible();
    expect(screen.getByLabelText("179 parsed successfully, 3 partial, 1 failed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open full Health details" })).toHaveAttribute("href", "/health");
    expect(screen.getByRole("heading", { name: "Active operation" })).toBeVisible();
    const progress = within(screen.getByRole("region", { name: "Active operation" })).getByRole("progressbar");
    expect(progress).toHaveAccessibleName("Graph refresh · Parse");
    expect(progress).toHaveAttribute("aria-valuenow", "68");
    expect(within(screen.getByRole("region", { name: "Active operation" }))
      .getByRole("button", { name: "View operation" })).toHaveAttribute(
      "href",
      "/jobs?job=job_01K36WVM6H7JK8M9NPQRSTVVWX",
    );
  }, 15_000);

  it("keeps bounded revisions and diagnostic evidence in uniquely named technical disclosures", async () => {
    const user = userEvent.setup();
    renderRoute("/", createFixtureApi({ overviewFixture: "established" }));

    await screen.findByRole("heading", { name: "Latest team memory" }, { timeout: 10_000 });
    const activityTrigger = screen.getByRole("button", { name: "View technical details for Latest team memory" });
    const contextTrigger = screen.getByRole("button", { name: "View technical details for Context readiness" });
    expect(activityTrigger).toHaveAccessibleName("View technical details for Latest team memory");
    expect(contextTrigger).toHaveAccessibleName("View technical details for Context readiness");
    expect(screen.getByText("Some recent history needs attention")).toBeVisible();
    expect(screen.getByText("Code graph diagnostics")).toBeVisible();

    const activityDisclosure = activityTrigger.closest('[data-slot="collapsible"]');
    expect(activityDisclosure).not.toBeNull();
    expect(within(activityDisclosure as HTMLElement).queryByText("7".repeat(64))).not.toBeInTheDocument();
    await user.click(activityTrigger);
    expect(within(activityDisclosure as HTMLElement).getByText("7".repeat(64))).toBeVisible();

    const contextDisclosure = contextTrigger.closest('[data-slot="collapsible"]');
    expect(contextDisclosure).not.toBeNull();
    const currentHead = /^aeaf0ab[0-9a-f]{33}$/;
    expect(within(contextDisclosure as HTMLElement).queryByText(currentHead)).not.toBeInTheDocument();
    await user.click(contextTrigger);
    expect(within(contextDisclosure as HTMLElement).getByText(currentHead)).toBeVisible();
  }, 15_000);

  it("keeps Activity and focus trust evidence visible when trusted previews are empty or degraded", async () => {
    const fixture = createFixtureApi({ overviewFixture: "established" });
    const overview = structuredClone(await fixture.getOverview());
    if (overview.activity.availability !== "available" || overview.focus.availability !== "available") {
      throw new Error("Expected available Overview fixture panels.");
    }
    overview.activity.items = [];
    overview.activity.sourceTruncated = true;
    const activityDiagnostic = overview.activity.diagnostics[0];
    if (!activityDiagnostic) throw new Error("Expected an Activity diagnostic fixture.");
    overview.focus.relays.diagnostics = [{
      code: "RELAY_LEGACY_PUBLICATION_TIME",
      severity: "warning",
      message: "An older Relay has bounded publication-time evidence.",
    }];
    overview.focus.relays.diagnosticsTruncated = true;
    overview.focus.inbox = {
      availability: "unavailable",
      observedAt: overview.focus.inbox.observedAt,
      reason: "The bounded Inbox preview could not be trusted.",
      deterministicRevision: "9".repeat(64),
      truncated: true,
      sourceTruncated: true,
      diagnostics: [{
        code: "INBOX_SOURCE_TRUNCATED",
        severity: "warning",
        message: "The Inbox source exceeded its bounded read.",
      }],
      diagnosticsTruncated: true,
    };
    const user = userEvent.setup();
    renderRoute("/", apiWith({ getOverview: () => Promise.resolve(overview) }));

    expect(await screen.findByText("No team memory yet")).toBeVisible();
    expect(screen.getByText("Some recent history needs attention")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "View technical details for Latest team memory" }));
    expect(screen.getByText(activityDiagnostic.code)).toBeVisible();
    expect(screen.getByText("Source truncated").nextElementSibling).toHaveTextContent("Yes");

    await user.click(screen.getByRole("button", { name: "View technical details for Attention" }));
    expect(screen.getByText("RELAY_LEGACY_PUBLICATION_TIME")).toBeVisible();
    expect(screen.getByText("Relay diagnostics truncated").nextElementSibling).toHaveTextContent("Yes");
    expect(screen.queryByText("Inbox focus unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("INBOX_SOURCE_TRUNCATED")).not.toBeInTheDocument();
  });

  it("renders detached and unborn Graph repository observations without shell fallback", async () => {
    const fixture = createFixtureApi({ overviewFixture: "caught-up" });
    const detached = structuredClone(await fixture.getOverview());
    if (detached.context.availability !== "available" || detached.context.graph.availability !== "available") {
      throw new Error("Expected available fixture Graph context.");
    }
    detached.context.graph.details.currentBranch = null;
    detached.context.graph.details.currentHead = "c".repeat(40);
    const detachedRender = renderRoute("/", apiWith({ getOverview: () => Promise.resolve(detached) }));
    expect(await screen.findByText("Detached HEAD · cccccccccc", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("Detached", { selector: "strong" })).toBeVisible();
    detachedRender.unmount();

    const unborn = structuredClone(await fixture.getOverview());
    if (unborn.context.availability !== "available" || unborn.context.graph.availability !== "available") {
      throw new Error("Expected available fixture Graph context.");
    }
    unborn.context.graph.details.currentBranch = "main";
    unborn.context.graph.details.currentHead = null;
    renderRoute("/", apiWith({ getOverview: () => Promise.resolve(unborn) }));
    expect(await screen.findByText("main · No committed HEAD recorded", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("Unborn", { selector: "strong" })).toBeVisible();
  });

  it("renders the caught-up state without permanent job furniture", async () => {
    renderRoute("/", createFixtureApi({ overviewFixture: "caught-up" }));

    expect(await screen.findByText("You’re caught up")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Context", exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Browse shared knowledge" })).toHaveAttribute("href", "/knowledge");
    expect(within(screen.getByRole("region", { name: "Context", exact: true }))
      .getByRole("button", { name: "Open Context" })).toHaveAttribute("href", "/knowledge");
    expect(screen.getAllByText("Fresh", { selector: "dd" })).toHaveLength(2);
    expect(screen.getAllByText("Fresh", { selector: "strong" })).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Active operation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Recent jobs|Project sections|Workstreams/ })).not.toBeInTheDocument();
  });

  it("renders first-run missing indexes as preparation rather than empty metrics", async () => {
    renderRoute("/", createFixtureApi({ overviewFixture: "indexes-missing" }));

    expect(await screen.findByText("Prepare local project context")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Context", exact: true })).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Context", exact: true }))
      .getByRole("button", { name: "Open Health" })).toHaveAttribute("href", "/health");
    expect(screen.getByRole("button", { name: "Open full Health details" })).toHaveAttribute("href", "/health");
    expect(screen.getByText("No team memory yet")).toBeVisible();
  });

  it("renders stale and degraded Knowledge states independently from a fresh Graph", async () => {
    const fixture = createFixtureApi({ overviewFixture: "caught-up" });
    const stale = structuredClone(await fixture.getOverview());
    if (stale.context.availability !== "available" || stale.context.wiki.availability !== "available") {
      throw new Error("Expected available fixture Knowledge context.");
    }
    stale.context.wiki.status = "degraded";
    stale.context.wiki.details.indexStatus = "stale";
    stale.context.wiki.summary = "The Knowledge index trails the current repository observation.";
    const staleRender = renderRoute("/", apiWith({ getOverview: () => Promise.resolve(stale) }));
    expect(await screen.findByText("Stale", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("Fresh", { selector: "dd" })).toBeVisible();
    staleRender.unmount();

    const degraded = structuredClone(await fixture.getOverview());
    if (degraded.context.availability !== "available" || degraded.context.wiki.availability !== "available") {
      throw new Error("Expected available fixture Knowledge context.");
    }
    degraded.context.wiki.status = "degraded";
    degraded.context.wiki.details.indexStatus = "degraded";
    degraded.context.wiki.summary = "Some Knowledge records could not be indexed safely.";
    renderRoute("/", apiWith({ getOverview: () => Promise.resolve(degraded) }));
    expect(await screen.findByText("Degraded", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("Fresh", { selector: "dd" })).toBeVisible();
  });

  it("prioritizes unresolved identity and preserves personal Relay unavailability", async () => {
    renderRoute("/", createFixtureApi({ overviewFixture: "identity-unresolved" }));

    expect(await screen.findByText("Resolve who you’re working as")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review identity" })).toHaveAttribute("href", "/members");
    expect(screen.getByText("Relay focus unavailable")).toBeVisible();
    expect(screen.getByText("Select an active Member to see your personal Relay handoffs.")).toBeVisible();
  });

  it("surfaces a stale saved identity before team queue attention", async () => {
    renderRoute("/", createFixtureApi({ memberFixture: "stale", overviewFixture: "pending-review" }));

    expect(await screen.findByText("Resolve who you’re working as")).toBeVisible();
    expect(screen.getByText("The referenced member no longer exists.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Review identity" })).toHaveAttribute("href", "/members");
    expect(screen.queryByText("Review 3 proposed Spec changes")).not.toBeInTheDocument();
  });

  it("renders degraded parse composition and determinate or indeterminate operations exactly", async () => {
    const degraded = renderRoute("/", createFixtureApi({ overviewFixture: "indexes-degraded" }));
    expect(await screen.findByText("178/183")).toBeVisible();
    expect(screen.getByLabelText("178 parsed successfully, 4 partial, 1 failed")).toBeVisible();
    degraded.unmount();

    const determinate = renderRoute("/", createFixtureApi({ overviewFixture: "job-determinate" }));
    const determinateProgress = within(await screen.findByRole("region", { name: "Active operation" })).getByRole("progressbar");
    expect(determinateProgress).toHaveAccessibleName("Graph refresh · Parse");
    expect(determinateProgress).toHaveAttribute("aria-valuenow", "68");
    expect(screen.getByText("124 / 183 files parsed")).toBeVisible();
    determinate.unmount();

    renderRoute("/", createFixtureApi({ overviewFixture: "job-indeterminate" }));
    const progress = within(await screen.findByRole("region", { name: "Active operation" })).getByRole("progressbar");
    expect(progress).toHaveAccessibleName("Wiki refresh · Discover");
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText("37 completed")).toBeVisible();
  });

  it.each(["resolve", "validate", "publish"] as const)("keeps Overview indeterminate after parsing during %s", async (phase) => {
    const fixture = createFixtureApi({ overviewFixture: "job-determinate" });
    const overview = await fixture.getOverview();
    if (overview.operation.availability !== "available" || !overview.operation.active) {
      throw new Error("The determinate fixture must supply an active graph operation.");
    }
    overview.operation.active = {
      ...overview.operation.active,
      phase,
      progress: { completed: 183, total: 183 },
    };
    renderRoute("/", apiWith({ getOverview: async () => overview }));
    const operation = within(await screen.findByRole("region", { name: "Active operation" }));
    expect(operation.getByText("183 / 183 files parsed")).toBeVisible();
    const progress = operation.getByRole("progressbar");
    expect(progress).toHaveAccessibleName(`Graph refresh · ${phase[0].toUpperCase()}${phase.slice(1)}`);
    expect(progress).not.toHaveAttribute("aria-valuenow");
  });

  it("shows only the bounded relevant failed operation when no newer success supersedes it", async () => {
    renderRoute("/", createFixtureApi({ overviewFixture: "failure" }));

    expect(await screen.findByRole("heading", { name: "Review the failed Graph refresh" }, { timeout: 10_000 })).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Context", exact: true }))
      .getByRole("button", { name: "Open Context" })).toHaveAttribute("href", "/knowledge");
    expect(within(screen.getByRole("region", { name: "Attention" }))
      .getByRole("button", { name: "View operation" })).toHaveAttribute(
      "href",
      "/jobs?job=job_01K39R3X4A5BC6DE7FGHJKMNPQ",
    );
    expect(screen.getByRole("heading", { name: "Operation needs attention" })).toBeVisible();
    const progress = within(screen.getByRole("region", { name: "Operation needs attention" })).getByRole("progressbar");
    expect(progress).toHaveAccessibleName("Graph refresh · Failed");
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText("The previous trustworthy Graph index was preserved.")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Operation needs attention" }))
      .getByRole("button", { name: "View operation" })).toHaveAttribute(
      "href",
      "/jobs?job=job_01K39R3X4A5BC6DE7FGHJKMNPQ",
    );
  }, 15_000);

  it("degrades unavailable sources independently and bounds raw failures", async () => {
    renderRoute("/", createFixtureApi({ overviewFixture: "partial" }));

    expect(await screen.findByText("Relay focus unavailable")).toBeVisible();
    expect(screen.getByText("Latest team memory unavailable")).toBeVisible();
    expect(screen.getByText("Code graph context unavailable")).toBeVisible();
    expect(screen.getByText("Fresh", { selector: "dd" })).toBeVisible();
  });

  it("renders a bounded aggregate error with a retry action", async () => {
    renderRoute("/", apiWith({ getOverview: () => Promise.reject(new Error("private path must not render")) }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(alert).not.toHaveTextContent("private path must not render");
  });

  it("refreshes every dependent query scope without polling or hidden mutations", async () => {
    const api = createFixtureApi({ overviewFixture: "caught-up" });
    const getOverview = vi.spyOn(api, "getOverview");
    const getHome = vi.spyOn(api, "getHome");
    const getCurrentActor = vi.spyOn(api, "getCurrentActor");
    const getInboxProposals = vi.spyOn(api, "getInboxProposals");
    const getRelays = vi.spyOn(api, "getRelays");
    const getActivity = vi.spyOn(api, "getActivity");
    const getHealth = vi.spyOn(api, "getHealth");
    const getJobs = vi.spyOn(api, "getJobs");
    const previewTeam = vi.spyOn(api, "previewTeamOperation");
    const previewInbox = vi.spyOn(api, "previewInboxOperation");
    const previewRelay = vi.spyOn(api, "previewRelayOperation");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const reset = vi.spyOn(queryClient, "resetQueries");
    const user = userEvent.setup();
    renderRoute("/", api, queryClient);

    expect(await screen.findByRole("heading", { name: "Context", exact: true })).toBeVisible();
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(getHome).not.toHaveBeenCalled();
    expect(getCurrentActor).not.toHaveBeenCalled();
    expect(getInboxProposals).not.toHaveBeenCalled();
    expect(getRelays).not.toHaveBeenCalled();
    expect(getActivity).not.toHaveBeenCalled();
    expect(getHealth).not.toHaveBeenCalled();
    // Overview owns the one bounded Jobs scan; the deep-route lifecycle observer
    // stays unmounted so this page remains explicit-refresh only.
    expect(getJobs).not.toHaveBeenCalled();
    expect(previewTeam).not.toHaveBeenCalled();
    expect(previewInbox).not.toHaveBeenCalled();
    expect(previewRelay).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Overview refreshed.")).toBeVisible();
    expect(reset).toHaveBeenCalledWith({ queryKey: ["overview"] }, { throwOnError: true });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(expect.arrayContaining([
      ["home"],
      ["actor", "current"],
      ["inbox"],
      ["relays"],
      ["activity"],
      ["health"],
      ["jobs"],
    ]));
    expect(getJobs).not.toHaveBeenCalled();

    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTime(5 * 60_000));
    expect(getOverview).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("Activity states", () => {
  const emptyActivity = (overrides: Partial<ActivityResponse> = {}): ActivityResponse => ({
    items: [],
    nextCursor: null,
    hasMore: false,
    sourceTruncated: false,
    deterministicRevision: "f".repeat(64),
    diagnostics: [],
    diagnosticsTruncated: false,
    ...overrides,
  });

  it("does not call the timeline endpoint when Activity is unavailable", async () => {
    const fixture = createFixtureApi();
    const capabilities = await fixture.getCapabilities();
    const getActivity = vi.fn(() => pending<ActivityResponse>());
    renderRoute("/activity", apiWith({
      getCapabilities: () => Promise.resolve({
        ...capabilities,
        activity: unavailable("The timeline reader is not connected."),
      }),
      getActivity,
    }));

    expect(await screen.findByRole("heading", { name: "Activity is unavailable" })).toBeVisible();
    expect(screen.getByText("The timeline reader is not connected.")).toBeVisible();
    expect(getActivity).not.toHaveBeenCalled();
  });

  it("renders loading and bounded initial-error states", async () => {
    const first = renderRoute("/activity", apiWith({ getActivity: () => pending<ActivityResponse>() }));
    expect(await screen.findByText("Loading team activity")).toBeVisible();
    first.unmount();

    renderRoute("/activity", apiWith({ getActivity: () => Promise.reject(new Error("private filesystem detail")) }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(alert).not.toHaveTextContent("private filesystem detail");
  });

  it("distinguishes a new timeline from an empty filtered result", async () => {
    const first = renderRoute("/activity", apiWith({ getActivity: () => Promise.resolve(emptyActivity()) }));
    expect(await screen.findByRole("heading", { name: "No team activity yet" })).toBeVisible();
    expect(screen.getByText(/Shared MEX changes will appear here automatically/)).toBeVisible();
    first.unmount();

    const user = userEvent.setup();
    renderRoute("/activity?source=legacy&since=2026-08-23", apiWith({ getActivity: () => Promise.resolve(emptyActivity()) }));
    expect(await screen.findByRole("heading", { name: "No activity matches these filters" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByRole("heading", { name: "No team activity yet" })).toBeVisible();
  });

  it("renders semantic MEX records and Project notes with truthful identity and context", async () => {
    const user = userEvent.setup();
    renderRoute("/activity", createFixtureApi());

    const proposal = await screen.findByRole("article", { name: "Proposed a Spec change" });
    expect(within(proposal).getByText("Ada Lovelace")).toBeVisible();
    expect(within(proposal).getByRole("link", { name: /Keep approval consequences explicit/ })).toHaveAttribute(
      "href",
      "/inbox?view=review&proposal=proposal_01000000000000000000001721",
    );
    expect(screen.getByRole("article", { name: "Took a handoff" })).toBeVisible();
    expect(screen.getByRole("article", { name: "Keep activity immutable and preserve Project notes as a read-only projection." })).toBeVisible();
    expect(screen.queryByText("Canonical")).not.toBeInTheDocument();
    expect(screen.queryByText("No linked subjects")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record Activity" })).not.toBeInTheDocument();
    const disclosureNames = screen.getAllByRole("button", { name: /^View context for / })
      .map((button) => button.getAttribute("aria-label"));
    expect(new Set(disclosureNames).size).toBe(disclosureNames.length);

    await user.click(within(proposal).getByRole("button", { name: /^View context for Proposed a Spec change:/ }));
    expect(await within(proposal).findByRole("heading", { name: "Repository when recorded" })).toBeVisible();
    expect(within(proposal).getByText("Git context captured when recorded.")).toBeVisible();
    expect(within(proposal).getByText("Local changes existed. MEX recorded that fact, not their paths, diff, or contents.")).toBeVisible();
    expect(within(proposal).getByRole("link", { name: "Open Keep approval consequences explicit" })).toHaveAttribute(
      "href",
      "/inbox?view=review&proposal=proposal_01000000000000000000001721",
    );
    await user.click(within(proposal).getByRole("button", { name: /^Technical details for Proposed a Spec change:/ }));
    expect(within(proposal).getByText("Workflow: inbox.publish")).toBeVisible();

    const remapped = screen.getByRole("article", { name: "Updated a teammate" });
    expect(within(remapped).getByText("Currently matched to Daksh Jaitly")).toBeVisible();
    await user.click(within(remapped).getByRole("button", { name: /^View context for Updated a teammate:/ }));
    expect(within(remapped).getByText((_, element) => (
      element?.tagName === "P"
      && element.textContent === "Recorded as Daksh Jaitly. Currently matched to Daksh Jaitly using today’s Member aliases."
    ))).toBeVisible();
    await user.click(within(remapped).getByRole("button", { name: /^Technical details for Updated a teammate:/ }));
    expect(within(remapped).getByText("ACTOR_ALIAS_REMAPPED")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(await screen.findByRole("heading", { name: "Recorded “relay.closed”" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Closed a handoff" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recorded “repository.initialized”" })).toBeVisible();
    expect(await screen.findByText("Project Hub foundations remain independent of the Wiki engine.")).toBeVisible();
  });

  it("renders clean, detached, and unborn repository context honestly", async () => {
    const user = userEvent.setup();
    renderRoute("/activity", createFixtureApi());

    const clean = await screen.findByRole("article", { name: "Took a handoff" });
    await user.click(within(clean).getByRole("button", { name: /^View context for Took a handoff:/ }));
    expect(await within(clean).findByText("Attached to branch")).toBeVisible();
    expect(within(clean).getByText("codex/hub-ux")).toBeVisible();
    expect(within(clean).getByText("Clean")).toBeVisible();

    const detached = screen.getByRole("article", { name: "Updated a teammate" });
    await user.click(within(detached).getByRole("button", { name: /^View context for Updated a teammate:/ }));
    expect(await within(detached).findByText("Detached HEAD")).toBeVisible();
    expect(within(detached).getByText("Not on a branch")).toBeVisible();
    expect(within(detached).getByText("Clean")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    const unborn = await screen.findByRole("article", { name: "Recorded “repository.initialized”" });
    await user.click(within(unborn).getByRole("button", { name: /^View context for Recorded “repository\.initialized”:/ }));
    expect(await within(unborn).findByText("Unborn repository")).toBeVisible();
    expect(within(unborn).getByText("feat/wiki-port-contract-lock")).toBeVisible();
    expect(within(unborn).getByText("No HEAD yet")).toBeVisible();
    expect(within(unborn).getByText("Clean")).toBeVisible();
  });

  it("links only exact supported subjects and performs no read-time enrichment", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const response = await fixture.getActivity({ limit: 25 });
    const template = response.items.find((item) => item.source === "activity");
    if (template?.source !== "activity") throw new Error("Expected a canonical fixture row.");
    const relayId = "relay_01000000000000000000000001";
    const rows: ActivityItem[] = [
      {
        ...template,
        id: "event_01K36WVM6H7JK8M9NPQRSTVVWX",
        action: "navigation.test",
        recordOrigin: { kind: "custom" },
        label: "Navigation references",
        subjects: [
          { kind: "entity", entity: { id: "mx_01000000000000000000000001", entityKind: "spec", title: "Release Spec" } },
          { kind: "entity", entity: { id: "mx_01000000000000000000000002", entityKind: "constraint", title: "Compatibility constraint" } },
          { kind: "symbol", symbolId: "sym.createHubServer" },
          { kind: "entity", entity: { id: "proposal_01000000000000000000001721", entityKind: "proposal", title: "Approval proposal" } },
          { kind: "file", path: "src/team/activity.ts" },
          { kind: "commit", hash: "6484dd0" },
          { kind: "entity", entity: { id: "not-a-valid-id", entityKind: "constraint", title: "Unsafe reference" } },
        ],
        subjectCount: 7,
        subjectsTruncated: false,
        workstream: null,
      },
      {
        ...template,
        id: "event_01K36R3X4A5BC6DE7FGHJKMNPQ",
        action: "relay.acknowledged",
        recordOrigin: { kind: "workflow", operation: "relay.acknowledge" },
        label: "Open Relay context",
        subjects: [{ kind: "entity", entity: { id: relayId, entityKind: "relay", title: "Open Relay context" } }],
        subjectCount: 1,
        subjectsTruncated: false,
        workstream: null,
      },
      {
        ...template,
        id: "event_01K35Z2A3B4C5D6E7FGHJKMNPQ",
        action: "relay.closed",
        recordOrigin: { kind: "workflow", operation: "relay.close" },
        label: "Closed Relay context",
        subjects: [{ kind: "entity", entity: { id: relayId, entityKind: "relay", title: "Closed Relay context" } }],
        subjectCount: 1,
        subjectsTruncated: false,
        workstream: null,
      },
      {
        ...template,
        id: "event_01K34P2A3B4C5D6E7FGHJKMNPQ",
        action: "relay.closed",
        recordOrigin: { kind: "custom" },
        label: "Untrusted Relay context",
        subjects: [{ kind: "entity", entity: { id: relayId, entityKind: "relay", title: "Untrusted Relay context" } }],
        subjectCount: 1,
        subjectsTruncated: false,
        workstream: null,
      },
      {
        ...template,
        id: "event_01K34P2A3B4C5D6E7FGHJKMNPR",
        action: "relay.closed",
        recordOrigin: { kind: "unknown" },
        label: "Historical Relay context",
        subjects: [{ kind: "entity", entity: { id: "relay_invalid", entityKind: "relay", title: "Historical Relay context" } }],
        subjectCount: 1,
        subjectsTruncated: false,
        workstream: null,
      },
    ];
    const getActivity = vi.fn(() => Promise.resolve({
      ...emptyActivity(),
      items: rows,
    }));
    renderRoute("/activity", apiWith({ getActivity }));

    const navigation = await screen.findByRole("article", { name: "Recorded “navigation.test”" });
    await user.click(within(navigation).getByRole("button", { name: /^View context for Recorded “navigation\.test”:/ }));
    expect(await within(navigation).findByRole("link", { name: "Open Release Spec" })).toHaveAttribute("href", "/specs/mx_01000000000000000000000001");
    expect(within(navigation).getByRole("link", { name: "Open Compatibility constraint" })).toHaveAttribute("href", "/knowledge/mx_01000000000000000000000002");
    expect(within(navigation).getByRole("link", { name: "Open sym.createHubServer" })).toHaveAttribute("href", "/code/symbols/sym.createHubServer?view=overview");
    expect(within(navigation).getByRole("link", { name: "Open Approval proposal" })).toHaveAttribute("href", "/inbox?view=review&proposal=proposal_01000000000000000000001721");
    expect(within(navigation).queryByRole("link", { name: /src\/team\/activity\.ts|6484dd0|Unsafe reference/ })).not.toBeInTheDocument();

    expect(screen.getByText("Open Relay context", { exact: true })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Open Relay context" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Closed Relay context" })).toHaveAttribute("href", `/relays?view=all&state=closed&relay=${relayId}`);
    expect(screen.queryByRole("link", { name: "Untrusted Relay context" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Historical Relay context" })).not.toBeInTheDocument();
    expect(getActivity).toHaveBeenCalledOnce();
  });

  it("shows every active Project-note kind without inventing an author or repository context", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const response = await fixture.getActivity({ source: "legacy", limit: 25 });
    const template = response.items.find((item) => item.source === "legacy");
    if (template?.source !== "legacy") throw new Error("Expected a Project-note fixture row.");
    const rows: ActivityItem[] = (["decision", "note", "risk", "todo"] as const).map((kind, index) => ({
      ...template,
      id: `legacy_${String.fromCharCode(97 + index).repeat(64)}`,
      action: kind,
      message: `${kind} project note`,
      sourceLine: index + 1,
    }));
    renderRoute("/activity?source=legacy", apiWith({
      getActivity: () => Promise.resolve({ ...emptyActivity(), items: rows }),
    }));

    for (const kind of ["Decision", "Note", "Risk", "Todo"]) {
      const row = await screen.findByRole("article", { name: `${kind.toLowerCase()} project note` });
      expect(within(row).getByText(kind)).toBeVisible();
      expect(within(row).getByText("Actor not recorded")).toBeVisible();
    }
    const decision = screen.getByRole("article", { name: "decision project note" });
    await user.click(within(decision).getByRole("button", { name: /^View context for decision project note:/ }));
    expect(await within(decision).findByRole("button", { name: /^Technical details for decision project note:/ })).toBeVisible();
    expect(within(decision).queryByRole("heading", { name: "Repository when recorded" })).not.toBeInTheDocument();
    await user.click(within(decision).getByRole("button", { name: /^Technical details for decision project note:/ }));
    expect(within(decision).getByText("This older project-log format does not record a verified actor or verified repository context.")).toBeVisible();
  });

  it("sends URL-backed source and UTC-midnight date filters to the API", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const getActivity = vi.fn((request) => fixture.getActivity(request));
    renderRoute("/activity?fixture=populated", apiWith({ getActivity }));
    await screen.findByRole("heading", { name: "Proposed a Spec change" });

    const allTab = screen.getByRole("tab", { name: "All activity" });
    allTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "MEX records" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(getActivity).toHaveBeenLastCalledWith(expect.objectContaining({ source: "activity" })));
    expect(screen.getByRole("tab", { name: "MEX records" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Project notes" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(getActivity).toHaveBeenLastCalledWith(expect.objectContaining({ source: "legacy" })));
    const from = screen.getByLabelText("From");
    from.focus();
    fireEvent.change(from, { target: { value: "2026-08-23" } });
    await waitFor(() => expect(getActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      source: "legacy",
      since: "2026-08-23T00:00:00.000Z",
    })));
    await waitFor(() => expect(from).toHaveFocus());
  });

  it("refreshes explicitly without polling and resets to the newest first page", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const populated = await fixture.getActivity({ limit: 25 });
    const getActivity = vi.fn()
      .mockResolvedValueOnce(emptyActivity())
      .mockResolvedValueOnce(populated);
    renderRoute("/activity", apiWith({ getActivity }));

    expect(await screen.findByRole("heading", { name: "No team activity yet" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("heading", { name: "Proposed a Spec change" })).toBeVisible();
    expect(screen.getByText("Activity refreshed.")).toBeInTheDocument();
    expect(getActivity).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getActivity).toHaveBeenCalledTimes(2);
  });

  it("announces a failed explicit Refresh without claiming success", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const populated = await fixture.getActivity({ limit: 25 });
    const getActivity = vi.fn()
      .mockResolvedValueOnce(populated)
      .mockRejectedValueOnce(new Error("private refresh failure"));
    renderRoute("/activity", apiWith({ getActivity }));

    expect(await screen.findByRole("heading", { name: "Proposed a Spec change" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Activity could not be refreshed. Try again.")).toBeVisible();
    expect(screen.queryByText("Activity refreshed.")).not.toBeInTheDocument();
    expect(getActivity).toHaveBeenCalledTimes(2);
  });

  it("keeps valid rows visible beside partial diagnostics and source truncation", async () => {
    const fixture = createFixtureApi();
    const response = await fixture.getActivity({ limit: 25 });
    renderRoute("/activity", apiWith({
      getActivity: () => Promise.resolve({ ...response, sourceTruncated: true, diagnosticsTruncated: true }),
    }));

    expect(await screen.findByRole("heading", { name: "Proposed a Spec change" })).toBeVisible();
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("This activity view is incomplete")).toBeVisible();
    expect(within(alert).getByText(/trustworthy records below remain available/)).toBeVisible();
    await userEvent.setup().click(within(alert).getByText("View trust details"));
    expect(within(alert).getByText("LEGACY_ACTIVITY_MALFORMED")).toBeVisible();
    expect(within(alert).getByText("A source scan stopped at its bounded safety limit.")).toBeVisible();
    expect(within(alert).getByText("Additional diagnostic entries were omitted by the response safety limit.")).toBeVisible();
  });

  it("keeps diagnostics and safety truncation visible when no row is trusted", async () => {
    renderRoute("/activity?source=legacy", apiWith({
      getActivity: () => Promise.resolve(emptyActivity({
        sourceTruncated: true,
        diagnostics: [{ code: "ACTIVITY_CONFLICT", severity: "error", message: "Conflicting canonical rows were excluded." }],
      })),
    }));

    expect(await screen.findByRole("heading", { name: "No trusted activity available" })).toBeVisible();
    expect(screen.getByText("This activity view is incomplete")).toBeVisible();
    expect(screen.getByText("MEX could not assemble a trusted record from this result.")).toBeVisible();
    expect(screen.getByText("The source scan is incomplete, so this result cannot confirm that no matching activity exists.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeVisible();
  });

  it("keeps raw subject and integrity details out of the default row", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const response = await fixture.getActivity({ limit: 25 });
    const canonical = response.items.find((item) => item.source === "activity");
    if (canonical?.source !== "activity") throw new Error("Expected a canonical fixture row.");
    renderRoute("/activity", apiWith({
      getActivity: () => Promise.resolve({
        ...response,
        items: [{ ...canonical, subjects: [], subjectCount: 3, subjectsTruncated: true }],
        nextCursor: null,
        hasMore: false,
      }),
    }));

    const row = await screen.findByRole("article", { name: "Proposed a Spec change" });
    expect(screen.queryByText("No linked subjects")).not.toBeInTheDocument();
    expect(screen.queryByText("3 subject references")).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /^View context for Proposed a Spec change:/ }));
    expect(await within(row).findByText("Showing 0 of 3 stored references.")).toBeVisible();
    await user.click(within(row).getByRole("button", { name: /^Technical details for Proposed a Spec change:/ }));
    expect(within(row).getByText("0 of 3 subject references included")).toBeVisible();
  });

  it("marks a legacy message when its bounded preview was shortened", async () => {
    const fixture = createFixtureApi();
    const response = await fixture.getActivity({ limit: 25 });
    const items = response.items.map((item) => item.source === "legacy" ? { ...item, messageTruncated: true } : item);
    renderRoute("/activity", apiWith({ getActivity: () => Promise.resolve({ ...response, items }) }));

    expect(await screen.findByText("This project-note message was shortened by the safe response limit.")).toBeVisible();
  });

  it("rejects a mixed-revision page while preserving the loaded rows", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const firstPage = await fixture.getActivity({ limit: 25 });
    const getActivity = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(emptyActivity({ deterministicRevision: "e".repeat(64) }));
    renderRoute("/activity", apiWith({ getActivity }));
    await screen.findByRole("heading", { name: "Proposed a Spec change" });

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(await screen.findByText("New activity arrived while you were browsing")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Proposed a Spec change" })).toBeVisible();
    expect(screen.queryByText("Project Hub foundations remain independent of the Wiki engine.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload newest" })).toBeEnabled();
  });

  it("surfaces a stale-cursor conflict without leaking problem internals", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const firstPage = await fixture.getActivity({ limit: 25 });
    const problem = new HubApiError({
      type: "about:blank",
      title: "Timeline changed",
      status: 409,
      code: "REVISION_CONFLICT",
      detail: "A newer revision exists.",
      requestId: "1e586537-c11b-4f73-9b5c-f4de2a8f7bad",
    });
    const getActivity = vi.fn().mockResolvedValueOnce(firstPage).mockRejectedValueOnce(problem);
    renderRoute("/activity", apiWith({ getActivity }));
    await screen.findByRole("heading", { name: "Proposed a Spec change" });

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(await screen.findByText("New activity arrived while you were browsing")).toBeVisible();
    expect(screen.queryByText("A newer revision exists.")).not.toBeInTheDocument();
  });

  it("preserves loaded rows and retries an ordinary older-page failure", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const firstPage = await fixture.getActivity({ limit: 25 });
    if (firstPage.nextCursor === null) throw new Error("Expected a paginated fixture response.");
    const olderPage = await fixture.getActivity({ limit: 25, cursor: firstPage.nextCursor });
    const getActivity = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error("private pagination failure"))
      .mockResolvedValueOnce(olderPage);
    renderRoute("/activity", apiWith({ getActivity }));
    await screen.findByRole("heading", { name: "Proposed a Spec change" });

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    const failureTitle = await screen.findByText("Older activity could not be loaded");
    const alert = failureTitle.closest('[role="alert"]');
    if (!(alert instanceof HTMLElement)) throw new Error("Expected a pagination alert.");
    expect(within(alert).getByText("Older activity could not be loaded")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Proposed a Spec change" })).toBeVisible();
    expect(screen.queryByText("private pagination failure")).not.toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Project Hub foundations remain independent of the Wiki engine.")).toBeVisible();
    expect(getActivity).toHaveBeenCalledTimes(3);
  });
});

describe("Search states", () => {
  it("renders the empty pre-search state without issuing a search", async () => {
    let calls = 0;
    renderRoute("/search", apiWith({ search: () => {
      calls += 1;
      return pending<SearchResponse>();
    } }));

    expect(await screen.findByRole("heading", { name: "Search project memory and code" })).toBeVisible();
    expect(calls).toBe(0);
  });

  it("renders a loading state while source queries are pending", async () => {
    renderRoute("/search?q=identity", apiWith({ search: () => pending<SearchResponse>() }));

    expect(await screen.findByRole("heading", { name: "Searching for “identity”" })).toBeVisible();
  });

  it("renders a bounded search error with retry", async () => {
    renderRoute("/search?q=identity", apiWith({ search: () => Promise.reject(new Error("raw backend error")) }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("distinguishes unavailable groups from successful empty groups", async () => {
    const fixture = createFixtureApi();
    const response = await fixture.search({ q: "identity", limit: 25 });
    const emptyGroup = { status: "available" as const, items: [], nextCursor: null, truncated: false, revision: "a".repeat(64) };
    const unavailableGroup = {
      status: "unavailable" as const,
      items: [],
      nextCursor: null,
      truncated: false,
      revision: null,
      detail: "The Wiki reader is not connected.",
    };
    renderRoute("/search?q=identity", apiWith({
      search: () => Promise.resolve({
        ...response,
        groups: { wiki: unavailableGroup, symbols: emptyGroup, sources: emptyGroup },
      }),
    }));

    expect(await screen.findByRole("heading", { name: "Knowledge unavailable" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "No code symbols found" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "No source matches found" })).toBeVisible();
  });
});

describe("Health states", () => {
  it("renders its loading state while the read-only inspection is pending", async () => {
    renderRoute("/health", apiWith({ getHealth: () => pending<HealthResponse>() }));

    expect(await screen.findByRole("heading", { name: "Inspecting system health" })).toBeVisible();
  });

  it("renders a bounded health error with retry", async () => {
    renderRoute("/health", apiWith({ getHealth: () => Promise.reject(new Error("database detail")) }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("renders an unavailable system assessment and disables unsupported repair", async () => {
    const fixture = createFixtureApi();
    const [capabilities, health] = await Promise.all([fixture.getCapabilities(), fixture.getHealth()]);
    renderRoute("/health", apiWith({
      getCapabilities: () => Promise.resolve({
        ...capabilities,
        graph: { ...capabilities.graph, refresh: unavailable("No graph refresh executor is registered.") },
      }),
      getHealth: () => Promise.resolve({
        ...health,
        status: "unavailable",
        components: [{
          id: "graph",
          label: "Code graph",
          status: "unavailable",
          summary: "The graph index cannot be inspected.",
          diagnostics: [],
          repairJobKind: "graph_refresh",
        }],
      }),
    }));

    expect(await screen.findByText("The graph index cannot be inspected.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh graph" })).toBeDisabled();
  });

  it("explains global index-job arbitration on Wiki controls", async () => {
    const fixture = createFixtureApi();
    renderRoute("/health", apiWith({ getHealth: () => fixture.getHealth() }));

    const wikiHeading = await screen.findByRole("heading", { name: "Project Wiki" });
    const wikiRow = wikiHeading.closest<HTMLElement>("[role='listitem']");
    expect(wikiRow).not.toBeNull();
    expect(within(wikiRow!).getByText("New operations wait for the active job.")).toBeVisible();
    expect(within(wikiRow!).getByRole("button", { name: "Wiki refresh" })).toBeDisabled();
    expect(within(wikiRow!).getByRole("button", { name: "Wiki rebuild" })).toBeDisabled();
  });

  it("starts Wiki refresh directly but confirms Wiki rebuild", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const health = await fixture.getHealth();
    const withoutActiveJob: HealthResponse = {
      ...health,
      components: health.components.map((component) => component.graph
        ? { ...component, graph: { ...component.graph, activeJobId: null } }
        : component),
    };
    const startJob = vi.fn((request: Parameters<HubApi["startJob"]>[0]) => fixture.startJob(request));
    const view = renderRoute("/health", apiWith({ getHealth: () => Promise.resolve(withoutActiveJob), startJob }));

    await user.click(await screen.findByRole("button", { name: "Wiki refresh" }));
    await waitFor(() => expect(startJob).toHaveBeenCalledWith({ kind: "wiki_refresh" }));

    view.unmount();
    startJob.mockClear();
    renderRoute("/health", apiWith({ getHealth: () => Promise.resolve(withoutActiveJob), startJob }));
    await user.click(await screen.findByRole("button", { name: "Wiki rebuild" }));
    expect(startJob).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Rebuild the Wiki index?" });
    await user.click(within(dialog).getByRole("button", { name: "Start wiki rebuild" }));
    await waitFor(() => expect(startJob).toHaveBeenCalledWith({ kind: "wiki_rebuild" }));
  });

  it("disables every index action while a Health start request is pending", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const health = await fixture.getHealth();
    const withoutActiveJob: HealthResponse = {
      ...health,
      components: health.components.map((component) => component.graph
        ? { ...component, graph: { ...component.graph, activeJobId: null } }
        : component.wiki
          ? { ...component, wiki: { ...component.wiki, activeJobId: null } }
          : component),
    };
    const startJob = vi.fn(() => pending<JobSummary>());
    renderRoute("/health", apiWith({ getHealth: () => Promise.resolve(withoutActiveJob), startJob }));

    await user.click(await screen.findByRole("button", { name: "Wiki refresh" }));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh graph" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rebuild graph" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Wiki rebuild" })).toBeDisabled();
    expect(startJob).toHaveBeenCalledTimes(1);
  });
});

describe("Jobs states", () => {
  it.each(["parse", "resolve", "validate", "publish"] as const)("shows parsed files without claiming overall completion during %s", async (phase) => {
    const fixture = createFixtureApi();
    const original = (await fixture.getJobs()).items[0]!;
    const job: JobSummary = { ...original, kind: "graph_refresh", state: "running", phase, progress: { completed: 10, total: 10 } };
    renderRoute("/jobs", apiWith({
      getJobs: async () => ({ items: [job], nextCursor: null }),
      subscribeToJob: () => ({ close: () => undefined }),
    }));
    expect(await screen.findByText("10 / 10 files parsed")).toBeVisible();
    if (phase === "parse") expect(screen.getByRole("progressbar", { name: "100% of files parsed" })).toBeVisible();
    else expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("renders its loading state while persisted summaries are pending", async () => {
    renderRoute("/jobs", apiWith({ getJobs: () => pending<JobsResponse>() }));

    expect(await screen.findByRole("heading", { name: "Loading jobs" })).toBeVisible();
  });

  it("renders the empty persisted-history state", async () => {
    renderRoute("/jobs", apiWith({ getJobs: () => Promise.resolve({ items: [], nextCursor: null }) }));

    expect(await screen.findByRole("heading", { name: "No jobs recorded" })).toBeVisible();
  });

  it("renders a bounded jobs error with retry", async () => {
    renderRoute("/jobs", apiWith({ getJobs: () => Promise.reject(new Error("sqlite detail")) }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("disables every operation when job execution is unavailable", async () => {
    const fixture = createFixtureApi();
    const capabilities = await fixture.getCapabilities();
    renderRoute("/jobs", apiWith({
      getCapabilities: () => Promise.resolve({ ...capabilities, jobs: unavailable("No executors are registered.") }),
    }));

    await screen.findByRole("heading", { name: "Operation log" });
    for (const name of ["Refresh graph", "Rebuild graph", "Refresh Wiki", "Rebuild Wiki"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeDisabled();
    }
  });
});
