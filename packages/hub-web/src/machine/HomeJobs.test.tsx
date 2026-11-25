import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter, MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFixture } from "./fixtures";
import { HomePage } from "./HomePage";
import { localDateTime } from "./local-time";
import { MachineHub } from "./MachineHub";
import type { HomeOverview, HubJob } from "./types";

function renderFixture(path: string) {
  window.history.replaceState(null, "", path);
  render(<BrowserRouter><MachineHub /></BrowserRouter>);
}

function jobRow(label: string) {
  const toggle = screen.getByRole("button", { name: new RegExp(`^${label}\\b`) });
  const element = toggle.closest("li")!;
  return { toggle, element, row: within(element) };
}

function finishedToggle(count: number) {
  return screen.getByText(`Finished in the last 7 days (${count})`, { selector: "summary h2" }).closest("summary")!;
}

describe("Home and Jobs fixtures", () => {
  it("shows the empty Home and Jobs states", async () => {
    const user = userEvent.setup();
    renderFixture("/?fixture=empty");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    expect(screen.getByText("Nothing waiting")).toBeVisible();
    expect(screen.getByText("Nothing needs you right now.")).toBeVisible();
    expect(screen.getByText("No agent sessions in the last 7 days.")).toBeVisible();
    expect(screen.getByText("Nothing learned yet.")).toBeVisible();
    expect(screen.getByText("No jobs running")).toBeVisible();
    expect(screen.getByRole("img", { name: /^MEX's AI use this week: 0%/ })).toBeVisible();
    expect(screen.queryByRole("img", { name: /agent sessions|Knowledge/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /\d jobs? running/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy command" })).toBeVisible();

    await user.click(screen.getByRole("link", { name: "Jobs" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
    expect(screen.getByText("No jobs to show.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Running and waiting" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Queued" })).toBeNull();
    expect(screen.queryByText(/Finished in the last 7 days/)).toBeNull();
  });

  it("keeps the last numbers during an update and limits the review and session previews", async () => {
    renderFixture("/?fixture=updating");
    expect(await screen.findByText("Updating…")).toHaveAttribute("role", "status");
    const knowledge = within(screen.getByRole("region", { name: "What MEX knows" }));
    expect(screen.getByText("27 up to date · 8 need a look")).toBeVisible();
    expect(knowledge.getByText("14 only you · 21 your team")).toBeVisible();

    const needs = within(screen.getByRole("region", { name: "Needs you" }));
    expect(needs.getAllByRole("listitem")).toHaveLength(4);
    expect(needs.getByText("+4 more")).toBeVisible();
    expect(needs.getByRole("link", { name: "Open Review" })).toBeVisible();
    expect(needs.getByText("Run the type checker before opening a pull request")).toBeVisible();
    expect(needs.getAllByText("Storefront")).toHaveLength(2);
    const sessions = within(screen.getByRole("region", { name: "What MEX did" }));
    expect(sessions.getByRole("list", { name: "Activity legend" })).toBeVisible();
    const latest = sessions.getByRole("heading", { name: "Latest sessions" }).closest<HTMLElement>("#latest-sessions")!;
    expect(within(latest).getAllByRole("listitem").map((row) => (
      Array.from(row.children, (part) => part.textContent).join(" · ")
    ))).toEqual([
      "Claude Code · Storefront · 42 min ago · gave 6 · held back 2",
      "Codex · Design kit · 3 h ago · gave 4 · held back 0",
      "Claude Code · Storefront · 5 h ago · gave 3 · held back 0",
    ]);
    expect(screen.getByRole("img", { name: /^MEX's AI use this week: 1.2% of your usage \(estimate\)/ })).toBeInTheDocument();
  });

  it("shows the missing folder in Needs you with the path and reports a zero-result session", async () => {
    const user = userEvent.setup();
    renderFixture("/?fixture=populated");
    expect(await screen.findByText("Folder not found: Docs site")).toHaveAttribute("title", "/work/docs-site");
    const fix = screen.getByRole("link", { name: "Fix" });
    expect(fix).toHaveAttribute("href", "/repos/docs-site?fixture=populated#checkouts");
    await user.click(fix);
    expect(screen.getByText("1 checkout", { selector: "summary" }).closest("details")).toHaveAttribute("open");
    const needs = within(screen.getByRole("region", { name: "Needs you" }));
    expect(needs.getByText("Folder not found: Docs site")).toHaveAttribute("title", "/work/docs-site");
    expect(needs.getByText("Check links when moving a page")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "What MEX did" })).getByText("gave 0 · held back 0")).toBeVisible();
    expect(screen.queryByRole("link", { name: /\d jobs? running/ })).toBeNull();
  });

  it("formats session ages and exposes the full local timestamp with its zone", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = new Date(2026, 10, 24, 16);
      vi.setSystemTime(now);
      const { overview, projects } = getFixture("populated");
      const localZone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" });
      const oldDate = new Date(2026, 10, 20, 14);
      const sessions = [
        { ...overview.sessions[0], at: now.toISOString() },
        { ...overview.sessions[1], at: new Date(2026, 10, 23, 14).toISOString() },
        { ...overview.sessions[2], at: oldDate.toISOString() },
      ];
      render(
        <MemoryRouter>
          <HomePage jobsHref="/jobs" overview={{ ...overview, sessions }} projects={projects} />
        </MemoryRouter>,
      );

      const times = [
        screen.getByText("just now", { selector: "time" }),
        screen.getByText("yesterday", { selector: "time" }),
        screen.getByText(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(oldDate), { selector: "time" }),
      ];
      for (const [index, element] of times.entries()) {
        const at = sessions[index].at;
        const zone = localZone.formatToParts(new Date(at)).find(({ type }) => type === "timeZoneName")!.value;
        expect(element).toHaveAttribute("datetime", at);
        expect(element).toHaveAttribute("title", expect.stringContaining(zone));
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the jobs pill only while a job is running", () => {
    const { overview, projects, jobs } = getFixture("populated");
    const waiting = jobs.filter(({ id }) => id === "storefront-check");
    const home = (visibleJobs: typeof jobs) => (
      <MemoryRouter><HomePage jobs={visibleJobs} jobsHref="/jobs" overview={overview} projects={projects} /></MemoryRouter>
    );
    const { rerender } = render(home(waiting));
    expect(screen.queryByRole("link", { name: /\d jobs? (running|waiting)/ })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Jobs" })).getByText("Waiting: offline")).toBeVisible();
    rerender(home(jobs));
    expect(screen.getByRole("link", { name: "2 jobs running" })).toHaveAttribute("href", "/jobs");
  });

  it("keeps the current page when changing scope and preserves machine queue positions", async () => {
    const user = userEvent.setup();
    renderFixture("/?fixture=home");
    await screen.findByRole("heading", { level: 1, name: "Home" });
    expect(screen.getByRole("link", { name: "2 jobs running" })).toHaveAttribute("href", "/jobs?fixture=home");
    const switcher = screen.getByRole("combobox", { name: "Repo switcher" });
    await user.selectOptions(switcher, "storefront");

    expect(window.location.pathname).toBe("/repos/storefront");
    expect(within(screen.getByRole("heading", { level: 1, name: "Home" }).parentElement!).getByText("· Storefront")).toBeVisible();
    const checkouts = screen.getByText("2 checkouts", { selector: "summary" });
    expect(checkouts.closest("details")).not.toHaveAttribute("open");
    await user.click(checkouts);
    expect(screen.getByRole("button", { name: "Copy path /work/storefront-checkout" })).toBeVisible();
    const needs = within(screen.getByRole("region", { name: "Needs you" }));
    expect(needs.getAllByRole("listitem")).toHaveLength(4);
    expect(needs.queryByText(/\d+ more/)).toBeNull();
    expect(needs.getAllByText("Storefront")).toHaveLength(4);
    expect(needs.queryByText("Design kit")).toBeNull();
    expect(screen.getByText("15 up to date · 5 need a look")).toBeVisible();

    await user.click(screen.getByRole("link", { name: "2 jobs running" }));
    expect(await screen.findByText("Jobs for Storefront")).toBeVisible();
    expect(window.location.pathname + window.location.search).toBe("/repos/storefront/jobs?fixture=home");
    const tests = jobRow("Learning from your tests");
    await user.click(tests.toggle);
    expect(tests.row.getByText("2nd in line")).toBeVisible();
    expect(tests.toggle).not.toHaveTextContent("Storefront");
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/repos/storefront?fixture=home");
    expect(screen.getByRole("link", { name: "Jobs" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("Mapping component examples")).toBeNull();

    await user.selectOptions(switcher, "design-kit");
    expect(await screen.findByText("Jobs for Design kit")).toBeVisible();
    expect(window.location.pathname).toBe("/repos/design-kit/jobs");

    await user.click(screen.getByRole("link", { name: "Show every repo" }));
    expect(await screen.findByText("Every job on this machine")).toBeVisible();
    expect(window.location.pathname + window.location.search).toBe("/jobs?fixture=home");
  });

  it("describes each Home chart and exposes its numbers in a visually hidden table", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2024, 10, 24, 16));
      const { jobs, overview, projects } = getFixture("home");
      const { container } = render(
        <MemoryRouter><HomePage jobs={jobs} jobsHref="/jobs" overview={overview} projects={projects} /></MemoryRouter>,
      );
      const charts = [
        [/^16 agent sessions over the last 7 days/, "Agent sessions by day", ["2024-11-22", "3"]],
        [/^Last 7 days: 16 agent sessions, 91 items given and 34 items held back/, "Daily agent activity", ["2024-11-22", "3", "26", "11", "3"]],
        [/^Knowledge status totals: 35 items, 27 up to date/, "Knowledge status totals", ["All repos", "27", "3", "1", "4", "35"]],
        [/^Knowledge by repo: 35 items, 27 up to date/, "Knowledge by repo", ["Storefront", "15", "2", "1", "2", "20"]],
        [/^MEX's AI use this week: 1.2%/, "MEX's AI use this week", ["Estimate", "1.2%"]],
      ] as const;
      for (const [label, caption, values] of charts) {
        expect(screen.getByRole("img", { name: label }).tagName.toLowerCase()).toBe("svg");
        const table = screen.getByRole("table", { name: caption });
        expect(table.parentElement).toHaveStyle({ position: "absolute", overflow: "hidden" });
        const row = within(table).getByRole("rowheader", { name: values[0] }).closest("tr")!;
        expect(Array.from(row.cells, (cell) => cell.textContent)).toEqual(values);
      }
      const daily = within(screen.getByRole("table", { name: "Daily agent activity" }));
      expect(daily.getAllByRole("rowheader")).toHaveLength(7);
      expect(daily.getByRole("rowheader", { name: "2024-11-20" }).parentElement).toHaveTextContent("2024-11-200000");
      const legend = within(screen.getByRole("list", { name: "Knowledge status totals" }));
      for (const item of legend.getAllByRole("listitem")) expect(item.querySelector("svg")).toBeVisible();
      expect(legend.getAllByRole("listitem")[0]).toHaveTextContent(/^27up to date$/);
      expect(screen.getByText("Storefront 4 · Design kit 2 · +1")).toBeVisible();
      expect(container).not.toHaveTextContent(/\b(?:saved|savings)\b/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the same activity column counts on hover and keyboard focus", () => {
    const { overview, projects } = getFixture("home");
    render(<MemoryRouter><HomePage jobsHref="/jobs" overview={overview} projects={projects} /></MemoryRouter>);
    const busyDay = overview.activity[4];
    const column = screen.getByRole("button", { name: new RegExp(`items given ${busyDay.gave}, items held back ${busyDay.heldBack}`) });
    fireEvent.pointerEnter(column);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent(`Long outputs replaced${busyDay.replaced}`);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(column);
    expect(screen.getByRole("tooltip")).toHaveTextContent(`Items held back${busyDay.heldBack}`);
    fireEvent.blur(column);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("switches knowledge to kinds and uses the scoped activity and AI estimate", async () => {
    const user = userEvent.setup();
    renderFixture("/?fixture=home");
    await screen.findByRole("table", { name: "Knowledge by repo" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Repo switcher" }), "storefront");
    const table = await screen.findByRole("table", { name: "Knowledge by kind" });
    expect(within(table).getAllByRole("rowheader").map((row) => row.textContent)).toEqual([
      "Rule", "Recipe", "Decision", "Pitfall", "Procedure", "Fact",
    ]);
    expect(within(table).getByRole("rowheader", { name: "Rule" }).closest("tr")).toHaveTextContent("Rule51017");
    expect(screen.queryByRole("img", { name: /^Knowledge by repo/ })).toBeNull();
    expect(screen.getByRole("img", { name: /^8 agent sessions over/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^MEX's AI use this week: 1.2%/ })).toBeInTheDocument();
    expect(screen.getByText("7 only you · 13 your team")).toBeVisible();
    expect(screen.getByText("of your usage this week, all repos (estimate)")).toBeVisible();
  });

  it("uses the specified state words and icons and keeps finished jobs collapsed", async () => {
    const user = userEvent.setup();
    renderFixture("/jobs?fixture=populated");
    await screen.findByRole("heading", { level: 1, name: "Jobs" });
    const finished = finishedToggle(4);
    expect(finished.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Done with gaps")).not.toBeVisible();
    await user.click(finished);
    expect(finished.closest("details")).toHaveAttribute("open");

    for (const label of [
      "Queued",
      "Running",
      "Paused",
      "Waiting: you're coding — resumes when idle",
      "Waiting: offline",
      "Done",
      "Done with gaps",
      "Failed: couldn’t read the repo folder",
      "Stopped — kept 9 rules",
    ]) {
      const badges = screen.getAllByText(label).map((element) => element.closest('[data-slot="badge"]')).filter(Boolean);
      expect(badges.length).toBeGreaterThan(0);
      for (const badge of badges) {
        expect(badge?.querySelector("svg")).toBeVisible();
      }
    }
  });

  it("shows counts only when known and keeps the cost, queue position and cancel in job details", async () => {
    const user = userEvent.setup();
    renderFixture("/jobs?fixture=home");
    await screen.findByRole("heading", { level: 1, name: "Jobs" });
    const map = jobRow("Building the code map · Storefront");
    const learn = jobRow("Learning from your code");
    const tests = jobRow("Learning from your tests");
    expect(map.row.getByText("Reading 412 of 1,180 files")).toBeVisible();
    expect(map.element.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({ width: "35%" });
    expect(learn.element.querySelector('[data-slot="progress-indicator"]')).toBeNull();
    expect(tests.toggle).toHaveTextContent("Learning from your tests · Storefront");
    expect(tests.row.getAllByRole("button")).toEqual([tests.toggle]);
    expect(tests.row.getByText("2nd in line")).not.toBeVisible();

    tests.toggle.focus();
    await user.keyboard("{Enter}");
    expect(tests.toggle).toHaveAttribute("aria-expanded", "true");
    expect(tests.row.getByText("2nd in line")).toBeVisible();
    expect(tests.row.getByText("About 38k tokens (estimated) · starts when you're not coding")).toBeVisible();
    expect(tests.row.getByRole("button", { name: "Cancel" })).toBeVisible();

    expect(learn.row.getByText("12.4k of about 40k tokens (estimated)")).not.toBeVisible();
    await user.click(learn.toggle);
    expect(learn.row.getByText("Deeper learning")).toBeVisible();
    expect(learn.row.getByText("Learned 9 rules")).toBeVisible();
    expect(learn.row.getByText("12.4k of about 40k tokens (estimated)")).toBeVisible();
    const at = getFixture("home").jobs.find(({ id }) => id === "storefront-learn")!.started!;
    const started = learn.row.getByText(localDateTime.format(new Date(at)), { selector: "time" });
    expect(started).toHaveAttribute("datetime", at);
    await user.click(map.toggle);
    expect(map.row.getByText("No AI cost")).toBeVisible();
  });

  it("keeps running when the dialog is dismissed and keeps finished work when a stop is confirmed", async () => {
    const user = userEvent.setup();
    renderFixture("/repos/storefront/jobs?fixture=home");
    await screen.findByRole("heading", { level: 1, name: "Jobs" });
    const { toggle, row } = jobRow("Learning from your code");
    expect(row.queryByRole("button", { name: "Cancel" })).toBeNull();
    await user.click(toggle);
    const cancel = row.getByRole("button", { name: "Cancel" });
    await user.click(cancel);

    const dialog = await screen.findByRole("alertdialog", { name: "Stop Learning from your code?" });
    expect(within(dialog).getByText("Finished work is kept (9 rules so far).")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Keep running" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(row.getByText("Running")).toBeVisible();
    expect(cancel).toHaveFocus();

    await user.click(cancel);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Stop job" }));
    const finished = finishedToggle(2);
    expect(finished.closest("details")).not.toHaveAttribute("open");
    await user.click(finished);
    const stopped = jobRow("Learning from your code");
    expect(stopped.row.getByText("Stopped — kept 9 rules")).toBeVisible();
    await user.click(stopped.toggle);
    expect(stopped.row.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("gives the disabled Pause button a visible reason and can resume the job", async () => {
    const user = userEvent.setup();
    renderFixture("/repos/storefront/jobs?fixture=home");
    await screen.findByRole("heading", { level: 1, name: "Jobs" });
    const { toggle, row } = jobRow("Building the code map");
    const pause = row.getByRole("button", { name: "Pause" });
    await user.click(pause);

    expect(pause).toBeDisabled();
    expect(pause).toHaveAccessibleDescription("Pausing after this batch…");
    expect(row.getByText("Pausing after this batch…")).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(await row.findByRole("button", { name: "Resume" }));
    expect(row.getByText("Running")).toBeVisible();
    expect(row.getByRole("button", { name: "Pause" })).toBeEnabled();
  });

  it("requeues a job after three identical failures", async () => {
    const user = userEvent.setup();
    renderFixture("/repos/docs-site/jobs?fixture=home");
    await screen.findByRole("heading", { level: 1, name: "Jobs" });
    await user.click(finishedToggle(1));
    const reset = screen.getByRole("button", { name: "Reset this job" });
    await user.click(reset);
    const { toggle, row } = jobRow("Building the code map");
    expect(row.getByText("Queued")).toBeVisible();
    expect(row.queryByRole("button", { name: "Cancel" })).toBeNull();
    await user.click(toggle);
    expect(row.getByText("3rd in line")).toBeVisible();
    expect(row.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});

class MockEventSource extends EventTarget {
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = 0;
  onopen?: () => void;
  onerror?: () => void;
  close = vi.fn(() => { this.readyState = MockEventSource.CLOSED; });

  constructor(readonly url: string) {
    super();
    MockEventSource.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  disconnect() {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }

  change(...topics: string[]) {
    this.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ topics }) }));
  }
}

function problem(status: number, job?: HubJob) {
  return Response.json({ status, title: "Couldn’t complete the request", detail: "Test response", code: "TEST", requestId: "test", job }, {
    status, headers: { "content-type": "application/problem+json" },
  });
}

function liveHub(path = "/", overview?: HomeOverview) {
  window.history.replaceState(null, "", path);
  vi.stubGlobal("EventSource", MockEventSource);
  const fixture = getFixture("home");
  const getSession = vi.fn(async () => Response.json(fixture.session));
  const getHome = vi.fn(async (_path: string) => Response.json(overview ?? fixture.overview));
  const getJobs = vi.fn(async () => Response.json(fixture.jobs));
  const postAction = vi.fn(async (_path: string, _init?: RequestInit) => problem(500));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === "/api/v1/review?limit=1") return Response.json({ total: 0, byRepo: {} });
    if (url.startsWith("/api/v1/home?")) return getHome(url);
    if (url.includes("/actions")) return postAction(url, init);
    if (url === "/api/v1/agents") return Response.json({ agents: [] });
    if (url === "/api/v1/jobs") return getJobs();
    if (url === "/api/v1/session") return getSession();
    if (url === "/api/v1/session/heartbeat") return new Response(null, { status: 204 });
    if (url === "/api/v1/projects") return Response.json({ projects: fixture.projects });
    throw new Error("Unexpected Hub request");
  }));
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const view = render(
    <QueryClientProvider client={client}>
      <BrowserRouter><MachineHub /></BrowserRouter>
    </QueryClientProvider>,
  );
  return { ...view, fixture, getHome, getJobs, getSession, postAction };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  MockEventSource.instances = [];
});

describe("live Home and Jobs", () => {
  it("shows Home loading and Retry, then keeps the last result if a live refetch fails", async () => {
    const user = userEvent.setup();
    const api = liveHub();
    let finish!: (response: Response) => void;
    api.getHome.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    expect(await screen.findByText("Loading Home…")).toBeVisible();
    expect(api.getHome).toHaveBeenCalledWith(`/api/v1/home?${new URLSearchParams({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}`);
    act(() => finish(problem(500)));
    expect(await screen.findByText("Couldn’t load Home.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("27 up to date · 8 need a look")).toBeVisible();
    expect(screen.queryByText("Couldn’t load Home.")).toBeNull();

    const [stream] = MockEventSource.instances;
    expect(stream.url).toBe("/api/v1/events");
    api.getHome.mockResolvedValueOnce(problem(500));
    act(() => stream.change("home"));
    expect(await screen.findByText("Couldn’t load Home.")).toBeVisible();
    expect(screen.getByText("27 up to date · 8 need a look")).toBeVisible();
  });

  it("uses dashes for the pending snapshot and omits the meter for an unknown usage share", async () => {
    const { overview } = getFixture("home");
    liveHub("/", { ...overview, pending: true, knowledge: {}, needs: [], needsCount: {}, week: { percent: null, capPercent: 3 } });
    expect(await screen.findByText("Updating…")).toHaveAttribute("role", "status");
    const knowledge = within(screen.getByRole("region", { name: "What MEX knows" }));
    expect(knowledge.getByText("—")).toBeVisible();
    expect(knowledge.queryByText("Nothing learned yet.")).toBeNull();
    const needs = screen.getByRole("link", { name: "Needs you" }).closest('[class*="tile_"]');
    expect(needs).toHaveTextContent("—");
    expect(screen.queryByText(/0 up to date/)).toBeNull();
    expect(screen.getByText("share of your usage unknown")).toBeVisible();
    expect(screen.queryByRole("img", { name: /MEX's AI use this week/ })).toBeNull();
    expect(screen.getByRole("img", { name: /^16 agent sessions/ })).toBeVisible();
  });

  it("uses counts and oldest values even when the listed waiting rules are a small preview", async () => {
    const { overview } = getFixture("home");
    liveHub("/", {
      ...overview, needs: overview.needs.slice(0, 1), needsCount: {
        storefront: { count: 31, oldest: new Date(Date.now() - 12 * 86_400_000).toISOString() },
        "design-kit": { count: 4, oldest: overview.needs[1].waitingSince },
      },
    });
    expect(await screen.findByText("oldest waiting 12 days")).toBeVisible();
    expect(within(screen.getByText("oldest waiting 12 days").parentElement!).getByText("35")).toBeVisible();
    expect(screen.getByText("Storefront 31 · Design kit 4")).toBeVisible();
    const card = within(screen.getByRole("region", { name: "Needs you" }));
    expect(card.getAllByRole("listitem")).toHaveLength(1);
    expect(card.getByText("+34 more")).toBeVisible();
  });

  it("polls Home and Jobs every ten seconds while the stream is closed and stops when open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = liveHub();
    await screen.findByText("27 up to date · 8 need a look");
    const [stream] = MockEventSource.instances;
    act(() => stream.open());
    await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.getJobs).toHaveBeenCalledTimes(2));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(api.getHome).toHaveBeenCalledTimes(2);
    expect(api.getJobs).toHaveBeenCalledTimes(2);

    act(() => stream.disconnect());
    expect(screen.getByText("Live updates are off. Refreshing every 10 s.")).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(9_999));
    expect(api.getHome).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    await waitFor(() => expect(api.getHome).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(api.getJobs).toHaveBeenCalledTimes(3));
    api.unmount();
    expect(stream.close).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("closes the stream and re-links after an unauthorized reconnect", async () => {
    const api = liveHub();
    await screen.findByRole("heading", { name: /^Home$/u });
    const [stream] = MockEventSource.instances;
    api.getSession.mockResolvedValueOnce(problem(401));
    act(() => stream.disconnect());
    expect(await screen.findByRole("heading", { name: "Open the Hub from the terminal" })).toBeVisible();
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it("shows Jobs load errors with Retry and retains rows on a failed refresh", async () => {
    const user = userEvent.setup();
    const api = liveHub("/jobs");
    api.getJobs.mockResolvedValueOnce(problem(500));
    expect(await screen.findByText("Couldn’t load jobs.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Running and waiting" })).toBeVisible();
    api.getJobs.mockResolvedValueOnce(problem(500));
    act(() => MockEventSource.instances[0].change("jobs"));
    expect(await screen.findByText("Couldn’t load jobs.")).toBeVisible();
    expect(jobRow("Building the code map · Storefront").toggle).toBeVisible();
  });

  it("moves focus to Jobs when a live update removes the focused row", async () => {
    const api = liveHub("/jobs");
    await screen.findByRole("heading", { name: "Running and waiting" });
    const row = jobRow("Building the code map · Storefront");
    act(() => row.toggle.focus());
    api.getJobs.mockResolvedValueOnce(Response.json(api.fixture.jobs.slice(1)));
    act(() => MockEventSource.instances[0].change("jobs"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Jobs" })).toHaveFocus());
  });

  it("disables the action in flight, silently refetches a 409 and puts other errors near the button", async () => {
    const user = userEvent.setup();
    const api = liveHub("/jobs");
    await screen.findByRole("heading", { name: "Running and waiting" });
    const job = api.fixture.jobs[0];
    const paused = { ...job, state: { phase: "paused" } } satisfies HubJob;
    let settle!: (response: Response) => void;
    api.postAction.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const { row } = jobRow("Building the code map · Storefront");
    const pause = row.getByRole("button", { name: "Pause" });
    await user.click(pause);
    expect(pause).toBeDisabled();
    expect(pause).toHaveAccessibleDescription("Pausing after this batch…");
    const [path, init] = api.postAction.mock.calls[0];
    expect(path).toBe(`/api/v1/jobs/${job.id}/actions`);
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ action: "pause", expectedState: "running" }) });
    expect(new Headers(init?.headers).get("x-mex-csrf")).toBe(api.fixture.session.csrfToken);
    api.getJobs.mockResolvedValueOnce(Response.json([paused, ...api.fixture.jobs.slice(1)]));
    act(() => settle(problem(409, paused)));
    const resume = await row.findByRole("button", { name: "Resume" });
    await waitFor(() => expect(resume).toBeEnabled());
    expect(row.queryByText(/Couldn’t update/)).toBeNull();

    api.postAction.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    await user.click(resume);
    expect(resume).toBeDisabled();
    expect(resume).toHaveAccessibleDescription("Resuming…");
    act(() => settle(problem(500)));
    expect(await row.findByText("Couldn’t update this job. Try again.")).toBeVisible();
    expect(resume).toBeEnabled();
  });
});
