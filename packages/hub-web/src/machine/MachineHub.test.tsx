import { StrictMode } from "react";
import type { MachineProject, MachineSession } from "@mex/hub-contracts/machine";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFixture } from "./fixtures";
import { localDateTime } from "./local-time";
import { MachineHub } from "./MachineHub";

const liveSession = {
  csrfToken: "write-proof",
  expiresAt: "2027-01-02T03:04:05.000Z",
  version: __MEX_HUB_VERSION__,
  mode: "background",
} satisfies MachineSession;

const projects = [
  {
    id: "repo-alder", name: "Alder", kind: "git", shared: false, provisional: null,
    checkouts: [{ path: "/work/alder", state: "on", offUntil: null, exists: true }],
  },
  {
    id: "repo-birch", name: "Birch", kind: "folder", shared: false, provisional: "unborn",
    checkouts: [
      { path: "/work/birch", state: "off", offUntil: null, exists: false },
      { path: "/work/birch-other", state: "off until", offUntil: "2027-01-02T03:04:05.000Z", exists: true },
    ],
  },
] satisfies MachineProject[];

function problem(status: number) {
  return Response.json(
    { title: "Request failed", status, code: "TEST_PROBLEM", detail: "Test detail", requestId: "test-id" },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function mockHub({ anonymous = false, projectList = projects, session = liveSession }: {
  anonymous?: boolean;
  projectList?: MachineProject[];
  session?: MachineSession;
} = {}) {
  let signedIn = !anonymous;
  const bootstrap = vi.fn(async () => {
    signedIn = true;
    return Response.json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt }, { status: 201 });
  });
  const readSession = vi.fn(async () => signedIn ? Response.json(session) : problem(401));
  const readProjects = vi.fn(async () => Response.json({ projects: projectList }));
  const heartbeat = vi.fn(async () => new Response(null, { status: 204 }));
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/v1/review?limit=1") return Response.json({ total: 0, byRepo: {} });
    if (url.startsWith("/api/v1/home?")) return Response.json(getFixture("empty").overview);
    switch (url) {
      case "/api/v1/session/bootstrap": return bootstrap();
      case "/api/v1/session": return readSession();
      case "/api/v1/projects": return readProjects();
      case "/api/v1/jobs": return Response.json([]);
      case "/api/v1/agents": return Response.json({ agents: [] });
      case "/api/v1/session/heartbeat": return heartbeat();
      default: throw new Error(`Unexpected request: ${url}`);
    }
  });
  vi.stubGlobal("fetch", fetch);
  return { bootstrap, readSession, readProjects, heartbeat, fetch };
}

function renderHub(path = "/") {
  window.history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <BrowserRouter><MachineHub /></BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
  return client;
}

function advance(milliseconds: number) {
  return act(() => vi.advanceTimersByTimeAsync(milliseconds));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("machine Hub", () => {
  it("explains how to sign in from the terminal and copies the command", async () => {
    const user = userEvent.setup();
    mockHub({ anonymous: true });
    renderHub();
    expect(await screen.findByRole("heading", { name: "Open the Hub from the terminal" })).toBeVisible();
    expect(screen.getByText(/Your sign-in then lasts 30 days on this browser/)).toBeVisible();
    expect(screen.queryByText(/already used or has expired/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe("mex hub");
  });

  it("explains a rejected link and strips its fragment while preserving the path and query", async () => {
    const api = mockHub({ anonymous: true });
    api.bootstrap.mockResolvedValueOnce(problem(401));
    renderHub("/repos/repo-alder?from=terminal#token=used-link");
    expect(await screen.findByText("That sign-in link was already used or has expired.")).toBeVisible();
    expect(window.location.pathname + window.location.search).toBe("/repos/repo-alder?from=terminal");
    expect(window.location.hash).toBe("");
    expect(api.readProjects).not.toHaveBeenCalled();
  });

  it("exchanges the link once and removes the fragment before checking the cookie", async () => {
    const api = mockHub({ anonymous: true });
    api.readSession.mockImplementationOnce(async () => {
      expect(window.location.hash).toBe("");
      return Response.json(liveSession);
    });
    renderHub("/#token=new-link");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    expect(api.fetch.mock.calls[0]).toEqual(["/api/v1/session/bootstrap", expect.objectContaining({
      body: JSON.stringify({ token: "new-link" }),
      credentials: "same-origin",
      method: "POST",
    })]);
  });

  it("accepts a new link pasted into an open re-link page", async () => {
    mockHub({ anonymous: true });
    renderHub();
    await screen.findByRole("heading", { name: "Open the Hub from the terminal" });
    act(() => { window.location.hash = "token=new-link"; });
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    expect(window.location.hash).toBe("");
  });

  it("lists repos in the switcher and navigates to their checkout states", async () => {
    const user = userEvent.setup();
    mockHub();
    renderHub();
    await screen.findByRole("heading", { level: 1, name: "Home" });
    const switcher = screen.getByRole("combobox", { name: "Repo switcher" });
    expect(within(switcher).getAllByRole("option").map((option) => option.textContent)).toEqual(["All repos", "Alder", "Birch"]);
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("link")).toEqual([
      screen.getByRole("link", { name: "Home" }),
      screen.getByRole("link", { name: "Review" }),
      screen.getByRole("link", { name: "Knowledge" }),
      screen.getByRole("link", { name: "Setup" }),
      screen.getByRole("link", { name: "Jobs" }),
      screen.getByRole("link", { name: "Agents" }),
      screen.getByRole("link", { name: "Settings" }),
    ]);
    await user.selectOptions(switcher, "repo-birch");
    expect(window.location.pathname).toBe("/repos/repo-birch");
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    expect(screen.getByText("· Birch", { selector: "header span" })).toBeVisible();
    const checkouts = screen.getByText("2 checkouts", { selector: "summary" });
    expect(checkouts.closest("details")).not.toHaveAttribute("open");
    await user.click(checkouts);
    expect(screen.getByText("MEX is off")).toBeVisible();
    const time = screen.getByText(/Off until/).querySelector("time");
    expect(time).toHaveTextContent(localDateTime.format(new Date("2027-01-02T03:04:05.000Z")));
    expect(screen.getByText("Folder not found: Birch")).toHaveAttribute("title", "/work/birch");
    await user.click(screen.getByRole("button", { name: "Copy path /work/birch-other" }));
    expect(await navigator.clipboard.readText()).toBe("/work/birch-other");
    await user.selectOptions(switcher, "");
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  });

  it("links an unknown repo back to All repos", async () => {
    const user = userEvent.setup();
    mockHub();
    renderHub("/repos/unknown");
    expect(await screen.findByRole("heading", { name: "This repo isn't known to MEX on this machine" })).toBeVisible();
    await user.click(screen.getByRole("link", { name: "All repos" }));
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  });

  it("offers the setup command from Home when there are no repos", async () => {
    mockHub({ projectList: [] });
    renderHub();
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "What MEX did" })).toBeVisible();
    expect(screen.getByText(/inside a repo to set it up/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeVisible();
  });

  it("surfaces missing folders from the live project list in Needs you", async () => {
    mockHub();
    renderHub();
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("Folder not found: Birch")).toHaveAttribute("title", "/work/birch");
  });

  it("keeps the last repos on a network failure and recovers by checking every ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = mockHub();
    const client = renderHub();
    await screen.findByRole("heading", { level: 1, name: "Home" });

    api.readProjects.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    api.readSession.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(() => client.refetchQueries({ queryKey: ["machine", "projects"] }));
    expect(await screen.findByText(/The Hub stopped/)).toBeVisible();
    expect(screen.getByText(/The Hub stopped/).closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("option", { name: "Alder" })).toBeInTheDocument();
    await advance(9_999);
    expect(api.readSession).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.readSession).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/The Hub stopped/)).toBeVisible();
    await advance(10_000);
    await waitFor(() => expect(screen.queryByText(/The Hub stopped/)).not.toBeInTheDocument());
    expect(api.readSession).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("option", { name: "Alder" })).toBeInTheDocument();
  });

  it("offers reload when MEX has been updated", async () => {
    mockHub({ session: { ...liveSession, version: "3000.0.0" } });
    renderHub();
    const message = await screen.findByText("MEX was updated. Reload to get the new Hub.");
    expect(message.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("button", { name: "Reload" })).toBeVisible();
  });

  it("shows when the terminal is running the Hub", async () => {
    mockHub({ session: { ...liveSession, mode: "terminal" } });
    renderHub();
    expect(await screen.findByText("Running from this terminal; closing it stops the Hub.")).toBeVisible();
    expect(screen.getByText("Running from this terminal")).toBeVisible();
  });

  it("sends the heartbeat on return to a visible tab and once a minute while visible", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const api = mockHub();
    renderHub();
    await screen.findByRole("heading", { level: 1, name: "Home" });
    await advance(60_000);
    expect(api.heartbeat).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    const init = api.fetch.mock.calls.find(([url]) => url === "/api/v1/session/heartbeat")?.[1];
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(init?.headers).get("x-mex-csrf")).toBe(liveSession.csrfToken);
    await advance(60_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(2);

    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await advance(60_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
  });

  it("shows the stopped banner only when the heartbeat cannot reach the Hub", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const api = mockHub();
    api.heartbeat.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderHub();
    await screen.findByRole("heading", { level: 1, name: "Home" });
    await advance(60_000);
    expect(await screen.findByText(/The Hub stopped/)).toBeVisible();
  });

  it("does not claim the Hub stopped when it answers the heartbeat with an error", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const api = mockHub();
    api.heartbeat.mockResolvedValueOnce(problem(500));
    renderHub();
    await screen.findByRole("heading", { level: 1, name: "Home" });
    await advance(60_000);
    await waitFor(() => expect(api.readSession.mock.calls.length).toBeGreaterThan(1));
    expect(screen.queryByText(/The Hub stopped/)).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  });

  it("asks to sign in again when every browser was signed out", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const api = mockHub();
    renderHub();
    await screen.findByRole("heading", { level: 1, name: "Home" });
    api.heartbeat.mockResolvedValueOnce(problem(401));
    api.readSession.mockImplementation(async () => problem(401));
    await advance(60_000);
    expect(await screen.findByRole("heading", { name: "Open the Hub from the terminal" })).toBeVisible();
    expect(screen.queryByText(/The Hub stopped/)).toBeNull();
  });
});
