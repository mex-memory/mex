import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate, useOutletContext } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";
import { HubLayout, type HubOutletContext } from "./HubLayout";

function renderRoute(route: string, api: HubApi = createFixtureApi()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={api}>
        <MemoryRouter initialEntries={[route]}>
          <AppRoutes />
        </MemoryRouter>
      </HubApiProvider>
    </QueryClientProvider>,
  );
}

const fixtureOverviewHeading = "Overview";

describe("Project Hub routes", () => {
  it.each([
    ["/", fixtureOverviewHeading],
    ["/search", "Search"],
    ["/knowledge", "Context"],
    ["/code", "Code"],
    ["/workstreams", "Workstreams"],
    ["/specs", "Specs"],
    ["/playbooks", "Playbooks"],
    ["/catch-up", "Catch Up"],
    ["/inbox", "Inbox"],
    ["/relays", "Relays"],
    ["/members", "Members"],
    ["/activity", "Activity"],
    ["/jobs", "Jobs"],
    ["/health", "Health"],
    ["/not-a-route", "Page not found"],
  ])("renders %s as an intentional view", async (route, heading) => {
    renderRoute(route);
    expect(await screen.findByRole("heading", { level: 1, name: heading }, { timeout: 10_000 })).toBeVisible();
  }, 15_000);

  it("exposes keyboard navigation and a skip link", async () => {
    const user = userEvent.setup();
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: fixtureOverviewHeading });
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    skip.focus();
    expect(skip).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Search project" })).toHaveFocus();
  });

  it("renders the sidebar information architecture in its exact semantic order", async () => {
    const user = userEvent.setup();
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: fixtureOverviewHeading });

    const sidebar = screen.getByRole("complementary", { name: "Project Hub navigation" });
    expect(within(sidebar).getByRole("link", { name: "Search project" })).toHaveAttribute("href", "/search");

    const primary = within(sidebar).getByRole("navigation", { name: "Primary" });
    expect(within(primary).getAllByRole("link").map((link) => link.querySelector("span")?.textContent)).toEqual([
      "Overview",
      "Context",
      "Code",
      "Inbox",
      "Relays",
      "Activity",
      "Team",
    ]);
    expect(within(primary).getByRole("region", { name: "Project" })).toHaveTextContent(
      "ContextCode",
    );
    expect(within(within(primary).getByRole("region", { name: "Teamwork" }))
      .getAllByRole("link")
      .map((link) => link.querySelector("span")?.textContent))
      .toEqual(["Relays", "Activity", "Team"]);
    expect(within(primary).queryByRole("region", { name: "Coming Soon" })).not.toBeInTheDocument();
    for (const label of ["Specs", "Workstreams", "Playbooks", "Catch Up"]) {
      expect(within(primary).queryByRole("link", { name: new RegExp(`^${label}`, "u") })).not.toBeInTheDocument();
    }

    const utilities = within(sidebar).getByRole("navigation", { name: "Project utilities" });
    expect(within(utilities).queryAllByRole("link")).toEqual([]);
    await user.click(within(utilities).getByRole("button", { name: /^System/u }));
    expect(within(utilities).getAllByRole("link").map((link) => link.querySelector("span")?.textContent)).toEqual([
      "Health",
      "Settings",
      "Jobs",
    ]);
  });

  it("keeps disclosure state independent and resets it after remount", async () => {
    const user = userEvent.setup();
    const first = renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: fixtureOverviewHeading });

    const projectMemory = screen.getByRole("button", { name: "Project" });
    const teamwork = screen.getByRole("button", { name: "Teamwork" });
    const system = screen.getByRole("button", { name: /^System/u });
    expect(projectMemory).toHaveAttribute("aria-expanded", "true");
    expect(teamwork).toHaveAttribute("aria-expanded", "true");
    expect(system).toHaveAttribute("aria-expanded", "false");

    await user.click(projectMemory);
    await user.click(system);
    expect(projectMemory).toHaveAttribute("aria-expanded", "false");
    expect(teamwork).toHaveAttribute("aria-expanded", "true");
    expect(system).toHaveAttribute("aria-expanded", "true");

    first.unmount();
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: fixtureOverviewHeading });
    expect(screen.getByRole("button", { name: "Project" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Teamwork" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /^System/u })).toHaveAttribute("aria-expanded", "false");
  });

  it.each([
    ["/knowledge/mx_01K36WVM6H7JK8M9NPQRSTVVWX", "Project", "Context"],
    ["/code/symbols/sym.createHubServer", "Project", "Code"],
    ["/jobs", "System", "Jobs"],
  ])("opens the active group and marks its nested route for %s", async (route, group, link) => {
    renderRoute(route);
    const disclosure = await screen.findByRole("button", { name: group });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: new RegExp(`^${link}(?: Soon| Unavailable)?$`, "u") }))
      .toHaveAttribute("aria-current", "page");
  });

  it("keeps a manually collapsed active group visibly active", async () => {
    const user = userEvent.setup();
    renderRoute("/knowledge/mx_01K36WVM6H7JK8M9NPQRSTVVWX");
    const disclosure = await screen.findByRole("button", { name: "Project" });
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).toHaveAttribute("data-active", "true");
    expect(screen.queryByRole("link", { name: "Context" })).not.toBeInTheDocument();
  });

  it("reopens a group when navigation enters one of its routes", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    function RouteDriver() {
      const navigate = useNavigate();
      return <button onClick={() => navigate("/jobs")} type="button">Open jobs route</button>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={createFixtureApi()}>
          <MemoryRouter initialEntries={["/"]}>
            <RouteDriver />
            <AppRoutes />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    );

    await screen.findByRole("heading", { level: 1, name: fixtureOverviewHeading });
    expect(screen.getByRole("button", { name: /^System/u })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "Open jobs route" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^System/u })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Jobs" })).toHaveAttribute("aria-current", "page");
    expect(document.querySelector("#main-content")).toHaveFocus();
  });

  it("uses slash to open Search and focus its existing project input", async () => {
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: fixtureOverviewHeading });
    expect(screen.getByRole("link", { name: "Search project" })).toHaveAttribute("aria-keyshortcuts", "/");

    fireEvent.keyDown(document, { key: "/", shiftKey: true });
    const input = await screen.findByRole("searchbox", { name: "Search project memory and code" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("");
  });

  it("refocuses Search without clearing its query", async () => {
    renderRoute("/search?q=alpha");
    const input = await screen.findByRole("searchbox", { name: "Search project memory and code" });
    expect(input).toHaveValue("alpha");
    screen.getByRole("link", { name: "Search project" }).focus();

    fireEvent.keyDown(document, { key: "/" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("alpha");
  });

  it("consumes shortcut focus so a later ordinary Search navigation focuses main content", async () => {
    const user = userEvent.setup();
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: fixtureOverviewHeading });

    fireEvent.keyDown(document, { key: "/" });
    expect(await screen.findByRole("searchbox", { name: "Search project memory and code" })).toHaveFocus();

    await user.click(screen.getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("heading", { level: 1, name: fixtureOverviewHeading })).toBeVisible();
    expect(document.querySelector("#main-content")).toHaveFocus();

    await user.click(screen.getByRole("link", { name: "Search project" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Search" })).toBeVisible();
    expect(document.querySelector("#main-content")).toHaveFocus();
  });

  it("ignores slash in editable controls, dialogs, and modified shortcuts", async () => {
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: fixtureOverviewHeading });

    for (const control of [
      document.createElement("input"),
      document.createElement("textarea"),
      document.createElement("select"),
    ]) {
      document.body.append(control);
      control.focus();
      fireEvent.keyDown(control, { key: "/" });
      expect(screen.queryByRole("heading", { level: 1, name: "Search" })).not.toBeInTheDocument();
      control.remove();
    }

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.tabIndex = 0;
    document.body.append(editable);
    editable.focus();
    fireEvent.keyDown(editable, { key: "/" });
    expect(screen.queryByRole("heading", { level: 1, name: "Search" })).not.toBeInTheDocument();
    editable.remove();

    for (const role of ["dialog", "alertdialog"] as const) {
      const dialog = document.createElement("div");
      const trigger = document.createElement("button");
      dialog.setAttribute("role", role);
      dialog.append(trigger);
      document.body.append(dialog);
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "/" });
      expect(screen.queryByRole("heading", { level: 1, name: "Search" })).not.toBeInTheDocument();
      dialog.remove();
    }

    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      fireEvent.keyDown(document, { key: "/", [modifier]: true });
      expect(screen.queryByRole("heading", { level: 1, name: "Search" })).not.toBeInTheDocument();
    }
  });

  it("marks both flat and read-scoped unavailable capabilities in navigation", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const capabilities = await api.getCapabilities();
    vi.spyOn(api, "getCapabilities").mockResolvedValue({
      ...capabilities,
      jobs: { availability: "unavailable", reason: "Job execution is disconnected." },
      relays: {
        ...capabilities.relays,
        read: { availability: "unavailable", reason: "Relay reads are disconnected." },
      },
    });

    renderRoute("/", api);
    await screen.findByRole("heading", { level: 1, name: fixtureOverviewHeading });

    expect(within(screen.getByRole("link", { name: /Relays/u })).getByText("Unavailable")).toBeVisible();
    expect(within(screen.getByRole("link", { name: "Context" })).queryByText("Unavailable")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^System/u }));
    expect(within(screen.getByRole("link", { name: /Jobs/u })).getByText("Unavailable")).toBeVisible();
  });

  it("fails closed when a Home refetch cannot refresh sidebar truth", async () => {
    const api = createFixtureApi();
    const initialHome = await api.getHome();
    const getHome = vi.spyOn(api, "getHome")
      .mockResolvedValueOnce(initialHome)
      .mockRejectedValueOnce(new Error("Home projection is unavailable."));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={api}>
          <MemoryRouter initialEntries={["/search"]}>
            <AppRoutes />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Ada Lovelace")).toBeVisible();
    const repositoryBar = screen.getByRole("banner", { name: "Repository context" });
    expect(within(repositoryBar).getByText(initialHome.repository.name)).toBeVisible();
    expect(screen.getByLabelText("2 open Relays for you.")).toBeVisible();

    // The Hub's only outbound link. `target="_blank"` without
    // `rel="noopener noreferrer"` would hand the opened tab a handle on this
    // one, so the rel is asserted rather than assumed.
    const discord = within(repositoryBar).getByRole("link", { name: "Join MEX Discord" });
    expect(discord).toHaveAttribute("href", "https://discord.gg/FEdNsQ4Qt4");
    expect(discord).toHaveAttribute("target", "_blank");
    expect(discord).toHaveAttribute("rel", "noopener noreferrer");

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["home"] });
    });

    expect(await screen.findByText("Set team identity")).toBeVisible();
    expect(within(repositoryBar).getByText("Current project")).toBeVisible();
    expect(screen.queryByLabelText("3 proposals awaiting team review.")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("2 open Relays for you.")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("1 active system operations.")).not.toBeInTheDocument();
    expect(getHome).toHaveBeenCalledTimes(2);
  });

  it("uses one Overview aggregate and no separate Home request on the root route", async () => {
    const api = createFixtureApi();
    const session = await api.getSession();
    const capabilities = await api.getCapabilities();
    const getHome = vi.spyOn(api, "getHome");
    const getOverview = vi.spyOn(api, "getOverview");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    function HomeOutletProbe() {
      const { home } = useOutletContext<HubOutletContext>();
      return <output aria-label="Outlet Home repository">{home?.repository.name ?? "Home unavailable"}</output>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={api}>
          <MemoryRouter>
            <Routes>
              <Route element={<HubLayout capabilities={capabilities} session={session} />}>
                <Route index element={<HomeOutletProbe />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Outlet Home repository")).toHaveTextContent("mex"));
    expect(getOverview).toHaveBeenCalledTimes(1);
    expect(getHome).not.toHaveBeenCalled();
  });

  it("keeps deep routes on the lightweight Home shell without loading Overview", async () => {
    const api = createFixtureApi();
    const session = await api.getSession();
    const capabilities = await api.getCapabilities();
    const getHome = vi.spyOn(api, "getHome");
    const getOverview = vi.spyOn(api, "getOverview");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    function DeepOutletProbe() {
      const { home } = useOutletContext<HubOutletContext>();
      return <output aria-label="Deep route Home repository">{home?.repository.name ?? "Home unavailable"}</output>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={api}>
          <MemoryRouter initialEntries={["/deep"]}>
            <Routes>
              <Route element={<HubLayout capabilities={capabilities} session={session} />}>
                <Route path="deep" element={<DeepOutletProbe />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Deep route Home repository")).toHaveTextContent("mex"));
    expect(getHome).toHaveBeenCalledTimes(1);
    expect(getOverview).not.toHaveBeenCalled();
  });

  it("keeps routes behind a safe, retryable capabilities error", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const getCapabilities = api.getCapabilities.bind(api);
    const capabilities = vi
      .spyOn(api, "getCapabilities")
      .mockRejectedValueOnce(new Error("sensitive filesystem detail: /private/repository"))
      .mockImplementation(getCapabilities);

    renderRoute("/code", api);

    expect(await screen.findByRole("heading", { name: "Project capabilities could not be loaded" })).toBeVisible();
    expect(screen.queryByText(/sensitive filesystem detail/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Code" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Code" })).toBeVisible();
    expect(capabilities).toHaveBeenCalledTimes(2);
  });

  it("renders real Wiki results beside independent graph groups", async () => {
    const user = userEvent.setup();
    renderRoute("/search");
    const input = await screen.findByRole("searchbox", { name: "Search project memory and code" });
    await user.type(input, "hub");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("createHubServer")).toBeVisible();
    expect(screen.getByText("Project Hub read boundaries")).toBeVisible();
    expect(screen.getByText("Source matches", { selector: "h2" })).toBeVisible();
  });

  it("links Overview focus, team memory, context, and active operation to exact supported routes", async () => {
    renderRoute("/");
    await screen.findByRole("heading", { name: "Context" }, { timeout: 10_000 });
    const focus = await screen.findByRole("region", { name: "Attention" }, { timeout: 10_000 });
    expect(within(screen.getByRole("region", { name: "Context" }))
      .getByRole("button", { name: "Open Context" })).toHaveAttribute("href", "/knowledge");
    expect(within(focus).getByRole("button", { name: "View Relays" })).toHaveAttribute("href", "/relays");
    expect(within(focus).queryByRole("button", { name: "Open Inbox" })).not.toBeInTheDocument();
    expect(within(focus).getByRole("button", { name: "Open handoff" })).toHaveAttribute(
      "href",
      "/relays?view=mine&state=open&relay=relay_01000000000000000000000001",
    );
    expect(within(focus).getByText("Continue the handoff you took").closest("a")).toHaveAttribute(
      "href",
      "/relays?view=mine&state=open&relay=relay_01000000000000000000000002",
    );

    expect(within(screen.getByRole("region", { name: "Latest team memory" }))
      .getByRole("button", { name: "View Activity" })).toHaveAttribute("href", "/activity");
    expect(within(screen.getByRole("region", { name: "Context readiness" }))
      .getByRole("button", { name: "Open full Health details" })).toHaveAttribute("href", "/health");
    expect(within(screen.getByRole("region", { name: "Active operation" }))
      .getByRole("button", { name: "View operation" })).toHaveAttribute(
      "href",
      "/jobs?job=job_01K36WVM6H7JK8M9NPQRSTVVWX",
    );

    expect(screen.getByRole("link", { name: "Activity" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Team" })).toHaveAttribute("href", "/members");
    expect(screen.getByRole("link", { name: /^Inbox/u })).toHaveAttribute("href", "/inbox");
    expect(screen.getByRole("link", { name: /^Relays/u })).toHaveAttribute("href", "/relays");
    expect(screen.queryByRole("region", { name: "Project sections" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recent jobs" })).not.toBeInTheDocument();
    expect(screen.queryByText("Canonical events")).not.toBeInTheDocument();
  }, 15_000);

  it("loads the lazy Relay workbench when the private Relay service is connected", async () => {
    const user = userEvent.setup();
    renderRoute("/relays");
    expect(await screen.findByRole("heading", { level: 1, name: "Relays" })).toBeVisible();
    expect(document.querySelector('[data-relay-workbench="ready"]')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-relay-id]")).toBeInTheDocument());
    expect(document.querySelector("[data-relay-draft-id]")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Drafts on this device" }));
    await waitFor(() => expect(document.querySelector("[data-relay-draft-id]")).toBeInTheDocument());
  });

  it("keeps the Search input synchronized with browser history", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    function BackButton() {
      const navigate = useNavigate();
      return <button onClick={() => navigate(-1)} type="button">Test browser back</button>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={createFixtureApi()}>
          <MemoryRouter initialEntries={["/search?q=alpha"]}>
            <BackButton />
            <AppRoutes />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const input = await screen.findByRole("searchbox", { name: "Search project memory and code" });
    expect(input).toHaveValue("alpha");
    await user.clear(input);
    await user.type(input, "beta");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(input).toHaveValue("beta");
    await user.click(screen.getByRole("button", { name: "Test browser back" }));
    expect(input).toHaveValue("alpha");
  });

  it("renders cancellation as requested until the executor settles", async () => {
    const user = userEvent.setup();
    renderRoute("/jobs?job=job_01K36WVM6H7JK8M9NPQRSTVVWX");
    const cancel = await screen.findByRole("button", { name: "Cancel job" });
    await user.click(cancel);
    expect(await screen.findByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.getByText("Cancellation requested")).toBeVisible();
  });
});
