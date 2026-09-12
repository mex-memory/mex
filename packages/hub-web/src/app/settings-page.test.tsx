import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HubApiError, type HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

function renderSettings(api: HubApi) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}><HubApiProvider api={api}>
    <MemoryRouter initialEntries={["/settings"]}><AppRoutes /></MemoryRouter>
  </HubApiProvider></QueryClientProvider>) };
}

describe("Checkout logging settings", () => {
  it("loads the quiet default without writing and exposes the project-notes destination", async () => {
    const api = createFixtureApi();
    const save = vi.spyOn(api, "setLoggingPolicy");
    renderSettings(api);
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" }, { timeout: 5_000 })).toBeVisible();
    expect(await screen.findByRole("radio", { name: "Significant events" })).toBeChecked();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Save preference" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Replay Hub tour" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Read project notes/ })).toHaveAttribute("href", "/activity?source=legacy");
    expect(save).not.toHaveBeenCalled();
  });

  it("saves only on explicit action and uses the returned revision for the next edit", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const save = vi.spyOn(api, "setLoggingPolicy");
    renderSettings(api);
    await user.click(await screen.findByRole("radio", { name: "Only when asked" }));
    expect(save).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save preference" }));
    const notice = await screen.findByText("Logging preference saved for this checkout.");
    expect(save).toHaveBeenLastCalledWith({ mode: "manual", expectedRevision: null });
    await waitFor(() => expect(notice).toHaveFocus());
    const saved = await api.getLoggingPolicy();
    await user.click(screen.getByRole("radio", { name: "Task checkpoints" }));
    await user.click(screen.getByRole("button", { name: "Save preference" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ mode: "checkpoints", expectedRevision: saved.revision }));
    expect((await api.getLoggingPolicy()).mode).toBe("checkpoints");
  });

  it("requires a reload after a concurrent preference change without overwriting it", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const save = vi.spyOn(api, "setLoggingPolicy").mockRejectedValueOnce(new HubApiError({
      type: "about:blank", status: 409, code: "REVISION_CONFLICT", title: "Revision conflict", detail: "Changed elsewhere.",
      requestId: "settings-test",
    }));
    renderSettings(api);
    await user.click(await screen.findByRole("radio", { name: "Only when asked" }));
    await user.click(screen.getByRole("button", { name: "Save preference" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed in another session");
    expect(screen.getByRole("button", { name: "Save preference" })).toBeDisabled();
    await api.setLoggingPolicy({ mode: "checkpoints", expectedRevision: null });
    await user.click(screen.getByRole("button", { name: "Reload preference" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Task checkpoints" })).toBeChecked());
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Logging preference saved for this checkout.")).not.toBeInTheDocument();
  });

  it("cancels unsaved edits and never presents unreadable preferences as the default", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const save = vi.spyOn(api, "setLoggingPolicy");
    const view = renderSettings(api);
    await user.click(await screen.findByRole("radio", { name: "Task checkpoints" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("radio", { name: "Significant events" })).toBeChecked();
    expect(save).not.toHaveBeenCalled();
    view.unmount();
    vi.spyOn(api, "getLoggingPolicy").mockRejectedValue(new Error("Unreadable preference"));
    renderSettings(api);
    expect(await screen.findByText("This view could not be loaded")).toBeVisible();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("does not let an older in-flight read replace a confirmed saved preference", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const { client } = renderSettings(api);
    await screen.findByRole("radio", { name: "Significant events" });
    let release!: (value: Awaited<ReturnType<HubApi["getLoggingPolicy"]>>) => void;
    const old = new Promise<Awaited<ReturnType<HubApi["getLoggingPolicy"]>>>((resolve) => { release = resolve; });
    vi.spyOn(api, "getLoggingPolicy").mockReturnValueOnce(old);
    const read = client.refetchQueries({ queryKey: ["settings", "logging"] });
    await user.click(screen.getByRole("radio", { name: "Only when asked" }));
    await user.click(screen.getByRole("button", { name: "Save preference" }));
    await screen.findByText("Logging preference saved for this checkout.");
    release({ mode: "significant", source: "default", revision: null });
    await read;
    await waitFor(() => expect(client.getQueryData(["settings", "logging"])).toMatchObject({ mode: "manual", source: "local" }));
    expect(screen.getByRole("radio", { name: "Only when asked" })).toBeChecked();
  });
});
