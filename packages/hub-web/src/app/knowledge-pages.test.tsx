import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HubApiError, type HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

const HUB_ID = "mx_01K36WVM6H7JK8M9NPQRSTVVWX";
const GRAPH_TOPIC_ID = "mx_01K36R3X4A5BC6DE7FGHJKMNPQ";

function apiWith(overrides: Partial<HubApi>): HubApi {
  return Object.assign(createFixtureApi(), overrides);
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderRoute(route: string, api: HubApi = createFixtureApi()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    ...render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={api}>
        <MemoryRouter initialEntries={[route]}>
          <LocationProbe />
          <AppRoutes />
        </MemoryRouter>
      </HubApiProvider>
    </QueryClientProvider>,
    ),
    queryClient,
  };
}

describe("Read-only Knowledge browse", () => {
  it("renders real summaries and loads an older page without replacing trusted rows", async () => {
    const user = userEvent.setup();
    renderRoute("/knowledge?view=list");

    expect(await screen.findByRole("heading", { level: 1, name: "Context" })).toBeVisible();
    expect(await screen.findByText("Project Hub read boundaries")).toBeVisible();
    expect(screen.getByText("One snapshot per graph request")).toBeVisible();
    expect(screen.getByText("Some entries carry bounded diagnostics.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Load more Knowledge" }));
    expect(await screen.findByText("Review immutable activity")).toBeVisible();
    expect(screen.getByText("Project Hub read boundaries")).toBeVisible();
  });

  it("keeps filters in URL history and makes text search an explicit independent mode", async () => {
    const user = userEvent.setup();
    renderRoute("/knowledge?view=list");
    await screen.findByText("Project Hub read boundaries");

    await user.selectOptions(screen.getByLabelText("Lifecycle"), "promoted");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/knowledge?view=list&lifecycle=promoted"));
    const filteredSummary = await screen.findByText("Filtered Knowledge records");
    expect(filteredSummary.parentElement).toHaveFocus();
    expect(screen.queryByText("Review immutable activity")).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search titles, summaries, and bodies" }), "hub");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/knowledge?view=list&q=hub"));
    expect(screen.getByTestId("location")).not.toHaveTextContent("lifecycle");
    expect(await screen.findByText("Knowledge results for “hub”")).toBeVisible();
  });

  it("preserves a complete canonical topic ID through the URL-backed filter", async () => {
    const user = userEvent.setup();
    renderRoute("/knowledge?view=list");
    await screen.findByText("Project Hub read boundaries");

    const topic = screen.getByLabelText("Topic ID");
    expect(topic).toHaveAttribute("maxlength", "29");
    await user.type(topic, GRAPH_TOPIC_ID);
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(
      `/knowledge?view=list&topic=${GRAPH_TOPIC_ID}`,
    ));
    expect(screen.getByText("Project Hub read boundaries")).toBeVisible();
    expect(screen.queryByText("One snapshot per graph request")).not.toBeInTheDocument();
  });

  it("preserves loaded entries on an ordinary pagination failure", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const listWikiEntities = vi.fn((request: Parameters<HubApi["listWikiEntities"]>[0]) => (
      request.cursor ? Promise.reject(new Error("private path /tmp/wiki.sqlite")) : fixture.listWikiEntities(request)
    ));
    renderRoute("/knowledge?view=list", apiWith({ listWikiEntities }));

    expect(await screen.findByText("Project Hub read boundaries")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load more Knowledge" }));
    expect(await screen.findByText("Older Knowledge could not be loaded.")).toBeVisible();
    expect(screen.getByText("Project Hub read boundaries")).toBeVisible();
    expect(screen.queryByText(/private path/i)).not.toBeInTheDocument();
  });

  it("ignores an older page that resolves after the URL filter generation changes", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    type WikiPage = Awaited<ReturnType<HubApi["listWikiEntities"]>>;
    let resolveOlder!: (page: WikiPage) => void;
    const olderPage = new Promise<WikiPage>((resolve) => { resolveOlder = resolve; });
    const listWikiEntities = vi.fn((request: Parameters<HubApi["listWikiEntities"]>[0]) => (
      request.cursor ? olderPage : fixture.listWikiEntities(request)
    ));
    renderRoute("/knowledge?view=list", apiWith({ listWikiEntities }));

    await screen.findByText("Project Hub read boundaries");
    await user.click(screen.getByRole("button", { name: "Load more Knowledge" }));
    await user.type(screen.getByLabelText("Kind"), "decision");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/knowledge?view=list&kind=decision"));
    expect(await screen.findByText("One snapshot per graph request")).toBeVisible();
    expect(screen.queryByText("Project Hub read boundaries")).not.toBeInTheDocument();

    const stale = await fixture.listWikiEntities({ limit: 25, cursor: "fixture_wiki_2" });
    await act(async () => {
      resolveOlder(stale);
      await olderPage;
    });
    expect(screen.queryByText("Review immutable activity")).not.toBeInTheDocument();
    expect(screen.getByText("One snapshot per graph request")).toBeVisible();
  });

  it("distinguishes a successful filtered-empty read from an unavailable index", async () => {
    const user = userEvent.setup();
    renderRoute("/knowledge?view=list");
    await screen.findByText("Project Hub read boundaries");

    await user.type(screen.getByLabelText("Kind"), "nonexistent");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("heading", { name: "No Knowledge matches these filters" })).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent("/knowledge?view=list&kind=nonexistent");
  });

  it.each([
    ["INDEX_MISSING", "A trustworthy Knowledge index is unavailable"],
    ["INDEX_STALE", "The Knowledge index is stale"],
    ["INDEX_CORRUPT", "The Knowledge index is corrupt"],
    ["MIGRATION_REQUIRED", "Knowledge migration is required"],
  ] as const)("projects %s through the explicit Health boundary", async (code, title) => {
    const error = new HubApiError({ type: "about:blank", title, status: 409, code, detail: "Safe Wiki inspection failed.", requestId: `req_${code}` });
    renderRoute("/knowledge?view=list", apiWith({ listWikiEntities: () => Promise.reject(error) }));

    expect(await screen.findByRole("heading", { name: title })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Wiki health" })).toHaveAttribute("href", "/health");
  });

  it("latches a revision conflict and clears it only after a successful newest reload", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    let conflict = true;
    const listWikiEntities = vi.fn(async (request: Parameters<HubApi["listWikiEntities"]>[0]) => {
      const response = await fixture.listWikiEntities(request);
      if (request.cursor && conflict) return { ...response, indexedRevision: "f".repeat(64) };
      return response;
    });
    renderRoute("/knowledge?view=list", apiWith({ listWikiEntities }));

    await screen.findByText("Project Hub read boundaries");
    await user.click(screen.getByRole("button", { name: "Load more Knowledge" }));
    expect(await screen.findByText("Knowledge changed while you were paging.")).toBeVisible();
    expect(screen.queryByText("Review immutable activity")).not.toBeInTheDocument();
    conflict = false;
    await user.click(screen.getByRole("button", { name: "Reload latest" }));
    await waitFor(() => expect(screen.queryByText("Knowledge changed while you were paging.")).not.toBeInTheDocument());
    expect(screen.getByText("Project Hub read boundaries")).toBeVisible();
  });

  it("keeps Knowledge unavailable honest", async () => {
    const fixture = createFixtureApi();
    const capabilities = await fixture.getCapabilities();
    const api = apiWith({
      getCapabilities: () => Promise.resolve({
        ...capabilities,
        wiki: { ...capabilities.wiki, read: { availability: "unavailable", reason: "Wiki migration must be reviewed manually." } },
      }),
    });
    renderRoute("/knowledge?view=list", api);
    expect(await screen.findByRole("heading", { name: "Knowledge unavailable" })).toBeVisible();
    expect(screen.getByText("Wiki migration must be reviewed manually.")).toBeVisible();
  });

  it.each([
    ["/playbooks", "Playbooks", "Reusable team workflows are planned but are not available in this release."],
    ["/catch-up", "Catch Up", "A personalized summary of project changes and team activity is planned but is not available in this release."],
  ] as const)("keeps the %s roadmap destination honest and discoverable", async (route, title, copy) => {
    renderRoute(route);

    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: `${title} is coming soon` })).toBeVisible();
    expect(screen.getByText(copy)).toBeVisible();
    expect(screen.getByText("Soon", { selector: '[data-slot="badge"][role="status"]' })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Coming Soon" })).not.toBeInTheDocument();
    expect(screen.queryByText("Read only")).not.toBeInTheDocument();
    expect(screen.queryByText("No data requested")).not.toBeInTheDocument();
  });
});

describe("Knowledge detail and Code linking", () => {
  it("renders bounded plain text, provenance, evidence, relations, backlinks, and explicit code links", async () => {
    const user = userEvent.setup();
    renderRoute(`/knowledge/${HUB_ID}`);

    expect(await screen.findByRole("heading", { level: 1, name: "Project Hub read boundaries" })).toBeVisible();
    expect(screen.getByLabelText("Knowledge body as plain text")).toHaveTextContent("Every indexed response belongs to one stable revision");
    expect(screen.getByRole("link", { name: /sym\.createHubServer/ })).toHaveAttribute("href", "/code/symbols/sym.createHubServer");
    expect(screen.getByText("Canonical Wiki source")).toBeVisible();
    expect(screen.getByText("Human")).toBeVisible();
    expect(screen.getByText("One snapshot per graph request")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Backlinks" }));
    expect(screen.getByText("Review immutable activity")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Backlinks" })).toHaveFocus();
  });

  it("points a record whose linked code changed at mex check and mex sync", async () => {
    renderRoute(`/knowledge/${GRAPH_TOPIC_ID}`);
    expect(await screen.findByRole("heading", { level: 1, name: "One snapshot per graph request" })).toBeVisible();
    const notice = screen.getByText("The linked code changed since this record was checked.").closest("[role=status]")!;
    expect(notice).toHaveTextContent("mex check");
    expect(notice).toHaveTextContent("mex sync");
  });

  it("shows no review notice for a fresh record", async () => {
    renderRoute(`/knowledge/${HUB_ID}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Project Hub read boundaries" })).toBeVisible();
    expect(screen.queryByText("The linked code changed since this record was checked.")).not.toBeInTheDocument();
  });

  it("keeps a trustworthy body visible when a relation panel fails independently", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    let failed = false;
    const getWikiRelations = vi.fn((...args: Parameters<HubApi["getWikiRelations"]>) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error("sqlite at /private/repo"));
      }
      return fixture.getWikiRelations(...args);
    });
    renderRoute(`/knowledge/${HUB_ID}`, apiWith({ getWikiRelations }));
    expect(await screen.findByLabelText("Knowledge body as plain text")).toBeVisible();
    expect(await screen.findByText("Relations could not be loaded.")).toBeVisible();
    expect(screen.getByText("This is a bounded or partial projection.")).toBeVisible();
    expect(screen.queryByText(/private\/repo/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("One snapshot per graph request")).toBeVisible();
    await waitFor(() => expect(screen.queryByText("Relations could not be loaded.")).not.toBeInTheDocument());
    expect(screen.queryByText("This is a bounded or partial projection.")).not.toBeInTheDocument();
  });

  it("clears a recovered backlink failure even when the successful page is bounded independently", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    let failed = false;
    const getWikiBacklinks = vi.fn((...args: Parameters<HubApi["getWikiBacklinks"]>) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error("private backlink failure"));
      }
      return fixture.getWikiBacklinks(...args);
    });
    renderRoute(`/knowledge/${HUB_ID}`, apiWith({ getWikiBacklinks }));

    expect(await screen.findByLabelText("Knowledge body as plain text")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Backlinks" }));
    expect(await screen.findByText("Backlinks could not be loaded.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Review immutable activity")).toBeVisible();
    await waitFor(() => expect(screen.queryByText("Backlinks could not be loaded.")).not.toBeInTheDocument());
  });

  it("freezes the displayed detail workspace until all panels reload at one revision", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    let revision = "6".repeat(64);
    const getWikiEntity = vi.fn(async (id: string) => {
      const current = await fixture.getWikiEntity(id);
      return {
        ...current,
        indexedRevision: revision,
        body: {
          ...current.body,
          content: revision.startsWith("f") ? "new revision body" : current.body.content,
          totalBytes: revision.startsWith("f") ? 17 : current.body.totalBytes,
        },
      };
    });
    const getWikiRelations = vi.fn(async (...args: Parameters<HubApi["getWikiRelations"]>) => ({
      ...await fixture.getWikiRelations(...args),
      indexedRevision: revision,
    }));
    const getWikiBacklinks = vi.fn(async (...args: Parameters<HubApi["getWikiBacklinks"]>) => ({
      ...await fixture.getWikiBacklinks(...args),
      indexedRevision: revision,
    }));
    const { queryClient } = renderRoute(`/knowledge/${HUB_ID}`, apiWith({
      getWikiEntity,
      getWikiRelations,
      getWikiBacklinks,
    }));

    expect(await screen.findByLabelText("Knowledge body as plain text")).toHaveTextContent(
      "Every indexed response belongs to one stable revision",
    );
    expect(screen.getByText("One snapshot per graph request")).toBeVisible();

    revision = "f".repeat(64);
    await queryClient.invalidateQueries({ queryKey: ["wiki-entity", HUB_ID] });
    expect(await screen.findByText("Knowledge changed while this record was open.")).toBeVisible();
    expect(screen.getByLabelText("Knowledge body as plain text")).not.toHaveTextContent("new revision body");
    expect(screen.getByText("One snapshot per graph request")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Reload latest" }));
    await waitFor(() => expect(screen.queryByText("Knowledge changed while this record was open.")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Knowledge body as plain text")).toHaveTextContent("new revision body");
  });

  it("projects missing and migration states through a safe Health recovery boundary", async () => {
    const error = new HubApiError({ type: "about:blank", title: "Index missing", status: 409, code: "INDEX_MISSING", detail: "No Wiki index is published.", requestId: "req_safe" });
    renderRoute(`/knowledge/${HUB_ID}`, apiWith({ getWikiEntity: () => Promise.reject(error) }));
    expect(await screen.findByRole("heading", { name: "A trustworthy Knowledge index is unavailable" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Wiki health" })).toHaveAttribute("href", "/health");
  });

  it("adds Related Knowledge to the symbol identity rail without blocking graph reads", async () => {
    const fixture = createFixtureApi();
    type CodeKnowledge = Awaited<ReturnType<HubApi["getCodeKnowledge"]>>;
    let resolveKnowledge!: (response: CodeKnowledge) => void;
    const pendingKnowledge = new Promise<CodeKnowledge>((resolve) => { resolveKnowledge = resolve; });
    renderRoute("/code/symbols/sym.createHubServer", apiWith({
      getCodeKnowledge: () => pendingKnowledge,
    }));

    expect(await screen.findByRole("heading", { level: 1, name: "createHubServer" })).toBeVisible();
    const rail = await screen.findByRole("heading", { name: "Related Knowledge" });
    expect(rail).toBeVisible();
    expect(screen.getByRole("heading", { name: "Finding explicit Knowledge links" })).toBeVisible();

    const response = await fixture.getCodeKnowledge("sym.createHubServer", { limit: 25 });
    await act(async () => {
      resolveKnowledge(response);
      await pendingKnowledge;
    });

    expect(await screen.findByRole("link", { name: /Project Hub read boundaries/ })).toHaveAttribute("href", `/knowledge/${HUB_ID}`);
  });
});
