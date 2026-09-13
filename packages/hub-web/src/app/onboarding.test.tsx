import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import type { SetupRun, SetupStatus } from "../api/types";
import { AppRoutes } from "./App";
import { hubOnboardingSteps } from "./onboarding";

function renderHub(route: string, api: HubApi) {
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

function firstRunApi() {
  return createFixtureApi({ onboardingFixture: "first-run" });
}

// The tour loads on demand, so its first dialog can trail the dashboard under load.
async function tourDialog() {
  return within(await screen.findByRole("dialog", { name: "Welcome to your local Hub" }, { timeout: 5_000 }));
}

async function expectCompleted(api: HubApi) {
  await waitFor(async () => expect(await api.getOnboardingState()).toEqual({ completed: true }));
}

describe("Hub first-run onboarding", () => {
  it("opens after the dashboard is ready and names this checkout", async () => {
    const api = firstRunApi();
    renderHub("/", api);
    const dialog = await tourDialog();
    expect(dialog.getByText(/control room for mex/i)).toBeVisible();
    expect(document.querySelector("[data-onboarding='sidebar']")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toBeVisible();
    expect(await api.getOnboardingState()).toEqual({ completed: false });
  });

  it("stays closed when this checkout already finished the tour", async () => {
    renderHub("/", createFixtureApi());
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays closed when the checkout's tour state cannot be read", async () => {
    const api = firstRunApi();
    api.getOnboardingState = async () => { throw new Error("Hub tour state unavailable."); };
    renderHub("/", api);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("walks through every step without a filler note and can finish on Context", async () => {
    const user = userEvent.setup();
    const api = firstRunApi();
    renderHub("/", api);
    const first = await tourDialog();
    const steps = hubOnboardingSteps("mex");
    expect(steps).toHaveLength(7);
    expect(first.queryByText(/only dimmed/i)).not.toBeInTheDocument();

    await user.click(first.getByRole("button", { name: "Show me around" }));
    expect(await screen.findByRole("dialog", { name: "Read the project, then add to it" })).toBeVisible();
    expect(document.querySelector("[data-onboarding='group-project-memory']")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("dialog", { name: "Hand work to people, not chat" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next" }));
    const search = within(await screen.findByRole("dialog", { name: "Find anything from here" }));
    expect(search.queryByText(/only dimmed/i)).not.toBeInTheDocument();
    expect(document.querySelector("[data-onboarding='search']")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("dialog", { name: "Stay oriented" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^System/u })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("dialog", { name: "Rewatch this tour anytime" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Settings" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next" }));

    const ready = within(await screen.findByRole("dialog", { name: "You’re set" }));
    expect(ready.queryByText(/only dimmed/i)).not.toBeInTheDocument();
    await user.click(ready.getByRole("button", { name: "Open Context" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Context" }, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await expectCompleted(api);
  });

  it("records a skip for this checkout so the next visit stays on the dashboard", async () => {
    const user = userEvent.setup();
    const api = firstRunApi();
    const complete = vi.spyOn(api, "completeOnboarding");
    renderHub("/", api);
    const dialog = await tourDialog();
    await user.click(dialog.getByRole("button", { name: "Skip tour" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(complete).toHaveBeenCalledTimes(1);
    await expectCompleted(api);
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  });

  it("replays the tour from Settings without writing completion again", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const complete = vi.spyOn(api, "completeOnboarding");
    renderHub("/settings", api);
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" }, { timeout: 5_000 })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Replay Hub tour" }));
    expect(await screen.findByRole("dialog", { name: "Welcome to your local Hub" }, { timeout: 5_000 })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(complete).not.toHaveBeenCalled();
    expect(await api.getOnboardingState()).toEqual({ completed: true });
  });

  it("does not replace the setup wizard with the Hub tour", async () => {
    const status: SetupStatus = {
      mode: "code-repo",
      projectName: "demo",
      hasGit: true,
      hasScaffold: false,
      populated: false,
      graphReady: false,
      wikiReady: false,
      state: "existing",
      stage: "needs_setup",
      configuredTools: [],
      tools: [],
      ready: false,
      commitCommands: [],
    };
    const run: SetupRun = {
      status: "idle",
      mode: "code-repo",
      stage: "needs_setup",
      populated: false,
      ready: false,
      selectedTools: [],
      prompt: null,
      populationTool: null,
      populationCompleted: false,
      commitCommands: [],
      anchorNotes: [],
      message: "MEX is not set up in this checkout yet.",
      progress: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    };
    const api = firstRunApi();
    api.getSetupStatus = async () => status;
    api.getSetupRun = async () => run;
    renderHub("/", api);
    expect(await screen.findByRole("heading", { name: "Build a Hub for this checkout" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Welcome to your local Hub" })).not.toBeInTheDocument();
  });
});
