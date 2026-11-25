import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { MachineHub } from "./MachineHub";
import { getFixture } from "./fixtures";
import type { MachineAgent, MachineSettings } from "./types";

const csrf = "test-csrf";
const revision = "a".repeat(64);
const previewToken = "d68f76e9-c491-4814-8655-208344dde420";
const data = getFixture("home");
const missing = getFixture("agents-broken").agents;

function app(path: string, own: (url: string, init: RequestInit | undefined) => Response | undefined) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const response = own(url, init);
    if (response) return response;
    if (url === "/api/v1/session") return Response.json({
      csrfToken: csrf, expiresAt: "2027-01-02T03:04:05.000Z", version: __MEX_HUB_VERSION__, mode: "background",
    });
    if (url === "/api/v1/projects") return Response.json({ projects: [] });
    if (url === "/api/v1/jobs") return Response.json([]);
    if (url.startsWith("/api/v1/home?")) return Response.json(data.overview);
    if (url === "/api/v1/review?limit=1") return Response.json({ total: 0, byRepo: {} });
    if (url === "/api/v1/agents") return Response.json({ agents: [] });
    throw new Error("Unexpected request " + url);
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("EventSource", undefined);
  if (!window.PointerEvent) vi.stubGlobal("PointerEvent", MouseEvent);
  window.history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  render(<QueryClientProvider client={client}><BrowserRouter><MachineHub /></BrowserRouter></QueryClientProvider>);
  return fetch;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("uses a live agent preview, sends the reviewed revision and updates the warning dot and detail", async () => {
  const user = userEvent.setup();
  const claude = { ...missing.agents[0], detected: true, errors: [] };
  let agent: MachineAgent = claude;
  const plan = { ...missing.repairPreviews["claude-code"], revision, previewToken };
  const fetch = app("/agents", (url) => {
    if (url === "/api/v1/agents") return Response.json({ agents: [agent] });
    if (url === "/api/v1/agents/claude-code") return Response.json({ agent });
    if (url.endsWith("/repair/preview")) return Response.json(plan);
    if (url.endsWith("/repair")) {
      agent = { ...claude, state: "working", repair: "unavailable", hooks: {
        canVerify: true, events: claude.hooks.events.map(event => ({ ...event, status: "installed" })),
      } };
      return Response.json({ agent });
    }
  });
  const card = within(await screen.findByRole("article", { name: "Claude Code" }));
  const nav = within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Agents" });
  expect(nav).toHaveAccessibleDescription("Some agents need attention");
  await user.click(card.getByRole("button", { name: "Repair" }));
  const dialog = within(await screen.findByRole("alertdialog", { name: "Repair Claude Code" }));
  expect(dialog.getByRole("region")).toHaveTextContent("PreToolUse");
  await user.click(dialog.getByRole("button", { name: "Confirm" }));
  expect(await screen.findByText("Claude Code is working again")).toBeVisible();
  expect(card.getByText("Working", { exact: true })).toBeVisible();
  expect(nav).not.toHaveAttribute("aria-description");

  const calls = fetch.mock.calls.filter(([url]) => url.endsWith("/repair/preview") || url.endsWith("/repair"));
  expect(calls).toHaveLength(2);
  for (const [, init] of calls) {
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(init?.headers).get("idempotency-key")).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Headers(init?.headers).get("x-mex-csrf")).toBe(csrf);
  }
  expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ revision, previewToken });
  await user.click(card.getByRole("link", { name: "Details for Claude Code" }));
  expect(await screen.findByText("12 of 12 installed")).toBeVisible();
  expect(screen.getByText("No hook error history is recorded.")).toBeVisible();
  expect(fetch.mock.calls.some(([url]) => url === "/api/v1/agents/claude-code")).toBe(true);
});

it("posts a live setting with its revision and shows the recorded uninstall preview", async () => {
  const user = userEvent.setup();
  let settings: MachineSettings = { ...data.settings.settings, capture: { enabled: true, source: "default", revision } };
  const fetch = app("/settings", (url, init) => {
    if (url === "/api/v1/settings/uninstall") return Response.json({ preview: data.settings.uninstall });
    if (url === "/api/v1/settings" && init?.method === "POST") {
      settings = { ...settings, capture: { enabled: false, source: "global", revision: "b".repeat(64) } };
      return Response.json({ saved: true });
    }
    if (url === "/api/v1/settings") return Response.json({ settings });
  });
  const capture = await screen.findByRole("switch", { name: "Capture everywhere" });
  expect(capture).toBeChecked();
  await user.click(capture);
  expect(await screen.findByText("Setting saved")).toBeVisible();
  await waitFor(() => expect(capture).not.toBeChecked());
  const init = fetch.mock.calls.find(([url, init]) => url === "/api/v1/settings" && init?.method === "POST")?.[1];
  expect(JSON.parse(String(init?.body))).toEqual({ change: { type: "capture", enabled: false }, expectedRevision: revision });
  expect(new Headers(init?.headers).get("x-mex-csrf")).toBe(csrf);
  expect(new Headers(init?.headers).get("idempotency-key")).toBeTruthy();
  expect(screen.getByText(/GitHub fetch history is unavailable/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Preview uninstall" }));
  const preview = within(await screen.findByRole("dialog", { name: "Uninstall preview" }));
  expect(preview.getByRole("heading", { name: "Not removed by uninstall" })).toBeVisible();
  expect(preview.getByText("mex uninstall", { exact: true })).toBeVisible();
  expect(preview.queryByRole("button", { name: /^Uninstall$/ })).toBeNull();
});

it("signs every browser out after confirmation and returns to the sign-in screen", async () => {
  const user = userEvent.setup();
  let signedIn = true;
  const fetch = app("/settings", (url, init) => {
    if (url === "/api/v1/session" && !signedIn) return Response.json({ title: "Sign in from the terminal", status: 401 }, { status: 401 });
    if (url === "/api/v1/settings/uninstall") return Response.json({ preview: data.settings.uninstall });
    if (url === "/api/v1/settings") return Response.json({ settings: { ...data.settings.settings, browser: { signOut: { source: "default" }, signOutEverywhere: { source: "default" } } } });
    if (url === "/api/v1/session/sign-out-everywhere" && init?.method === "POST") {
      signedIn = false;
      return new Response(null, { status: 204 });
    }
  });
  await user.click(await screen.findByRole("button", { name: "Sign out everywhere" }));
  await user.click(within(await screen.findByRole("alertdialog", { name: "Sign out everywhere?" })).getByRole("button", { name: "Sign out everywhere" }));
  expect(await screen.findByRole("heading", { name: "Open the Hub from the terminal" })).toBeVisible();
  const init = fetch.mock.calls.find(([url]) => url === "/api/v1/session/sign-out-everywhere")?.[1];
  expect(new Headers(init?.headers).get("x-mex-csrf")).toBe(csrf);
});

it("polls live agent status every ten seconds when events are unavailable", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let agents = missing.agents;
  const fetch = app("/agents", url => url === "/api/v1/agents" ? Response.json({ agents }) : undefined);
  expect(await screen.findByRole("article", { name: "Claude Code" })).toHaveTextContent("Needs repair");
  const reads = fetch.mock.calls.filter(([url]) => url === "/api/v1/agents").length;
  agents = data.agents.agents;
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  await waitFor(() => expect(screen.getByRole("article", { name: "Claude Code" })).toHaveTextContent("Working"));
  expect(fetch.mock.calls.filter(([url]) => url === "/api/v1/agents").length).toBeGreaterThan(reads);
});
