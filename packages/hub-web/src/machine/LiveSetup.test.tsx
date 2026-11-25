import type { MachineProject, MachineRepoSetup, MachineSetupQuote, MachineSetupStep } from "@mex/hub-contracts/machine";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { getFixture } from "./fixtures";
import { MachineHub } from "./MachineHub";

const csrf = "setup-csrf";
const project: MachineProject = {
  id: "g-" + "a".repeat(24), name: "Shop", kind: "git", provisional: null, shared: false,
  checkouts: [{ path: "/work/shop", state: "on", offUntil: null, exists: true }],
};
const other: MachineProject = {
  ...project, id: "g-" + "b".repeat(24), name: "Docs",
  checkouts: [{ path: "/work/docs", state: "on", offUntil: null, exists: false }],
};
const revision = "c".repeat(64), quoteRevision = "d".repeat(64);
const base = "/api/v1/setup";
const scoped = (projectId = project.id) => base + "?repo=" + projectId;
const action = (name: string) => base + "/" + project.id + "/" + name;
const url = "/repos/" + project.id + "/setup";
const overview = getFixture("home").overview;
const graph: MachineSetupStep = {
  kind: "graph-build", jobId: "map-job", label: "Code map", scope: "/work/shop-checkout",
  state: "running", progress: { done: 2, total: 5, message: "2 of 5 files" }, revision,
  cost: { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, startedAt: "2026-11-25T08:00:00Z", finishedAt: null,
};
const learn: MachineSetupStep = {
  ...graph, kind: "learn-deeper", jobId: "learn-job", label: "Learn deeper", scope: project.checkouts[0].path,
  state: "queued", progress: undefined, estimate: { tokens: 48_000, seconds: 240 },
};
const quote: MachineSetupQuote = {
  agent: "Codex", revision: quoteRevision, tokens: 48_000, ceilingTokens: 72_000, seconds: 240, weekly: true, privateRepo: true,
};

function setup(changes: Partial<MachineRepoSetup> = {}): MachineRepoSetup {
  return {
    repoId: project.id, checkout: project.checkouts[0].path, steps: [graph], questions: [],
    summary: { elapsedMs: 1600, commandsSaved: true, findings: [{ label: "Rule files", text: "Read 2 files." }] }, ...changes,
  };
}

function app(path: string, mock: (url: string, init?: RequestInit) => Response | undefined, events?: typeof EventSource) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const response = mock(url, init);
    if (response) return response;
    if (url === "/api/v1/session") return Response.json({
      csrfToken: csrf, expiresAt: "2027-01-02T03:04:05.000Z", version: __MEX_HUB_VERSION__, mode: "background",
    });
    if (url === "/api/v1/projects") return Response.json({ projects: [project, other] });
    if (url.startsWith("/api/v1/jobs")) return Response.json([]);
    if (url.startsWith("/api/v1/home?")) return Response.json(overview);
    if (url === "/api/v1/review?limit=1") return Response.json({ total: 0, byRepo: {} });
    if (url === "/api/v1/agents") return Response.json({ agents: [] });
    throw new Error("Unexpected request " + url);
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("EventSource", events);
  if (!window.PointerEvent) vi.stubGlobal("PointerEvent", MouseEvent);
  window.history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  render(<QueryClientProvider client={client}><BrowserRouter><MachineHub /></BrowserRouter></QueryClientProvider>);
  return fetch;
}

function credentials(init: RequestInit | undefined) {
  expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
  const headers = new Headers(init?.headers);
  expect(headers.get("x-mex-csrf")).toBe(csrf);
  expect(headers.get("idempotency-key")).toMatch(/^[a-f0-9-]{36}$/u);
  return headers.get("idempotency-key");
}

function problem(status: number, code: string, detail: string) {
  return Response.json({ status, code, title: detail, detail, requestId: "test" }, { status });
}

const steps = () => within(screen.getByRole("region", { name: "Setup steps" }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("opens live Setup, switches repos, and sends the quote the person approved", async () => {
  const user = userEvent.setup();
  let repo = setup({ offerRevision: revision });
  const fetch = app("/", path => {
    if (path === base) return Response.json({ repos: [
      { repoId: project.id, status: "running", checkout: repo.checkout }, { repoId: other.id, status: "missing" },
    ] });
    if (path === scoped()) return Response.json({ repo });
    if (path === scoped(other.id)) return Response.json({ repo: setup({ repoId: other.id, missingCheckout: true, checkout: "/work/docs", steps: [] }) });
    if (path === action("quote")) return Response.json({ state: "offered", quote });
    if (path === action("learn")) {
      repo = setup({ steps: [graph, learn] });
      return Response.json(learn);
    }
    if (path === "/api/v1/jobs?job=learn-job") return Response.json([
      { id: "learn-job", label: "Learn deeper", kind: "learn-deeper", repoId: project.id, state: { phase: "queued" }, cost: null },
    ]);
  });
  await user.click(await screen.findByRole("link", { name: "Setup" }));
  const list = within(await screen.findByRole("list", { name: "Repos" }));
  expect(list.getByText("In progress", { exact: true })).toBeVisible();
  expect(list.getByText("Folder missing", { exact: true })).toBeVisible();
  expect(fetch.mock.calls.some(([path]) => path === action("quote"))).toBe(false);
  await user.selectOptions(screen.getByRole("combobox", { name: "Repo switcher" }), other.id);
  expect(await screen.findByText(/The repo folder is missing/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Copy command" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Locate/ })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByRole("combobox", { name: "Repo switcher" }), project.id);
  expect(await screen.findByText("/work/shop-checkout")).toBeVisible();
  expect(steps().getByRole("progressbar")).toHaveAttribute("value", "2");
  await user.click(await screen.findByRole("button", { name: "Learn deeper" }));
  const dialog = within(await screen.findByRole("alertdialog", { name: "Learn from your team’s reviews?" }));
  expect(dialog.getByText(/Starts after the code map\./)).toBeVisible();
  expect(dialog.getByText("48,000 tokens")).toBeVisible();
  expect(dialog.getByText("72,000 tokens")).toBeVisible();
  expect(dialog.getByText(/every 7–14 days/)).toBeVisible();
  expect(dialog.queryByText(/\$[0-9]/u)).not.toBeInTheDocument();
  expect(fetch.mock.calls.some(([path]) => path === action("learn"))).toBe(false);
  await user.click(dialog.getByRole("button", { name: "Start learning" }));
  expect(await screen.findByText("48,000 tokens estimated")).toBeVisible();
  expect(screen.getByText(/Starts after the code map and other setup work/)).toBeVisible();
  const requests = fetch.mock.calls.filter(([path]) => path === action("quote") || path === action("learn"));
  expect(requests.map(([path, init]) => [path, JSON.parse(String(init?.body))])).toEqual([
    [action("quote"), { expectedRevision: revision }], [action("learn"), { quoteRevision }],
  ]);
  expect(new Set(requests.map(([, init]) => credentials(init))).size).toBe(2);
  await user.click(screen.getByRole("link", { name: "View job for Learn deeper" }));
  const job = await screen.findByRole("button", { name: /^Learn deeper.*Queued/ });
  expect(job).toHaveAttribute("aria-expanded", "true");
  expect(job).toHaveFocus();
});

it("requires a new confirmation when the quote changes", async () => {
  const user = userEvent.setup();
  let offer = quote;
  const fetch = app(url, path => {
    if (path === scoped()) return Response.json({ repo: setup({ offerRevision: revision }) });
    if (path === action("quote")) return Response.json({ state: "offered", quote: offer });
    if (path === action("learn")) {
      offer = { ...quote, tokens: 60_000, revision: "e".repeat(64) };
      return problem(409, "REVISION_CONFLICT", "Open the current estimate and try again.");
    }
  });
  await user.click(await screen.findByRole("button", { name: "Learn deeper" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Start learning" }));
  expect(await screen.findByText("Open the current estimate and try again.")).toBeVisible();
  expect(await screen.findByText(/about 60,000 tokens/)).toBeVisible();
  expect(fetch.mock.calls.filter(([path]) => path === action("learn"))).toHaveLength(1);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

it("sends step revisions, retries a busy job with the same key, and shows the batch request", async () => {
  const user = userEvent.setup();
  let step = graph, calls = 0;
  const eventSource = class extends EventTarget {
    static live: EventTarget;
    onopen: (() => void) | null = null;
    constructor() { super(); eventSource.live = this; queueMicrotask(() => this.onopen?.()); }
    close() {}
  };
  const fetch = app(url, path => {
    if (path === scoped()) return Response.json({ repo: setup({ steps: [step] }) });
    if (path === action("steps/map-job")) {
      if (++calls === 1) return problem(503, "MEX_BUSY", "Try again in a moment.");
      step = { ...step, pending: "pause", revision: "f".repeat(64) };
      return Response.json(step);
    }
  }, eventSource as unknown as typeof EventSource);
  await user.click(await screen.findByRole("button", { name: "Pause" }));
  expect(await screen.findByText("MEX is busy, retrying…")).toBeVisible();
  const pause = await steps().findByText(/Pausing after this batch/);
  expect(pause).toBeVisible();
  expect(steps().getByRole("button", { name: "Pause" })).toHaveAttribute("aria-disabled", "true");
  const seen = fetch.mock.calls.filter(([path]) => path === action("steps/map-job"));
  expect(seen).toHaveLength(2);
  expect(seen.map(([, init]) => credentials(init))).toEqual([expect.any(String), new Headers(seen[0][1]?.headers).get("idempotency-key")]);
  expect(JSON.parse(String(seen[1][1]?.body))).toEqual({ action: "pause", expectedRevision: revision });

  step = { ...step, state: "paused", pending: undefined };
  act(() => eventSource.live.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ topics: ["setup"] }) })));
  expect(await steps().findByRole("button", { name: "Resume" })).toBeEnabled();
});

it("remembers Not now on navigation and shows the real Review link for finished learning", async () => {
  const user = userEvent.setup();
  let repo = setup({ offerRevision: revision });
  const fetch = app(url, path => {
    if (path === base) return Response.json({ repos: [{ repoId: project.id, status: "running" }] });
    if (path === scoped()) return Response.json({ repo });
    if (path === action("quote")) return Response.json({ state: "offered", quote });
    if (path === action("skip-learning")) {
      repo = setup({ learnDeeper: { state: "skipped" } });
      return Response.json({ saved: true });
    }
  });
  await user.click(await screen.findByRole("button", { name: "Not now" }));
  expect(await screen.findByText(/Not started · run/)).toBeVisible();
  const write = fetch.mock.calls.find(([path]) => path === action("skip-learning"))?.[1];
  credentials(write);
  expect(JSON.parse(String(write?.body))).toEqual({ quoteRevision });
  await user.click(screen.getByRole("link", { name: "Show every repo" }));
  await user.click(await screen.findByRole("link", { name: project.name }));
  expect(await screen.findByText(/Not started · run/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Learn deeper" })).not.toBeInTheDocument();

  repo = setup({ steps: [{ ...learn, state: "done", finishedAt: "2026-11-25T08:02:00Z" }] });
  await user.click(screen.getByRole("link", { name: "Show every repo" }));
  await user.click(await screen.findByRole("link", { name: project.name }));
  expect(await screen.findByRole("link", { name: "Open Review" })).toHaveAttribute("href", "/repos/" + project.id + "/review");
});

it("keeps outcomes visible while pending questions refresh", async () => {
  const user = userEvent.setup();
  let questions: MachineRepoSetup["questions"] = ["a", "b", "c"].map((hex, i) => ({
    id: hex.repeat(24), revision: hex.repeat(64), type: "test-command", question: "Which command for package " + i + "?",
    details: [], choices: [{ key: "1", label: "Use make" }, { key: "2", label: "Use npm" }],
  }));
  const [first, ...rest] = questions;
  const fetch = app(url, (path, init) => {
    if (path === scoped()) return Response.json({ repo: setup({ questions }) });
    if (path === action("questions")) {
      const body = JSON.parse(String(init?.body));
      const decided = body.action === "answer" ? questions.filter(question => question.id === body.question.id) : questions;
      questions = questions.filter(question => !decided.includes(question));
      return Response.json({ questions: decided.map(question => ({ ...question, outcome: body.action === "answer"
        ? { status: "saved", line: 'Saved: your agents get it as "you said"' } : { status: "skipped" } })) });
    }
  });
  const firstQuestion = within(await screen.findByRole("group", { name: first.question }));
  await user.click(firstQuestion.getByRole("button", { name: "Use make" }));
  expect(await screen.findByText('Saved: your agents get it as "you said"')).toBeVisible();
  expect(screen.getByRole("heading", { name: first.question })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Skip all" }));
  await waitFor(() => expect(screen.getAllByText("Skipped", { exact: true })).toHaveLength(2));
  const writes = fetch.mock.calls.filter(([path]) => path === action("questions"));
  expect(writes.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { action: "answer", question: { id: first.id, revision: first.revision }, choice: "1" },
    { action: "skipAll", questions: rest.map(({ id, revision }) => ({ id, revision })) },
  ]);
  for (const [, init] of writes) credentials(init);
});

it("refreshes a last-good setup snapshot every ten seconds without events", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  let sample: { repo: MachineRepoSetup; updatingSince?: string } = { repo: setup(), updatingSince: "2026-11-25T08:00:00Z" };
  const fetch = app(url, path => path === scoped() ? Response.json(sample) : undefined);
  expect(await screen.findByText("Updating setup…")).toBeVisible();
  expect(screen.getByText("Read 2 files.")).toBeVisible();
  const reads = fetch.mock.calls.filter(([path]) => path === scoped()).length;
  sample = { repo: setup({ steps: [{ ...graph, state: "done", finishedAt: "2026-11-25T08:01:00Z" }] }) };
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(await steps().findByText("Done", { exact: true })).toBeVisible();
  expect(fetch.mock.calls.filter(([path]) => path === scoped())).toHaveLength(reads + 1);
});
