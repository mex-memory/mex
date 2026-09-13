import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFixtureApi } from "../dev/fixture-api";
import { SetupCompletion } from "./SetupCompletion";
import { TeamAccessCard } from "./TeamAccessCard";

function fixture(status: "unasked" | "submitted" | "skipped" = "unasked") {
  const installation = { state: "idle" as const, version: "0.8.2", command: "npm install -g mex-agent@0.8.2", message: "Optional installation." };
  const api = Object.assign(createFixtureApi(), {
    getContactPreference: vi.fn(async () => ({ status })),
    rememberContactPreference: vi.fn(async (input: { status: "submitted" | "skipped" }) => input),
    submitSetupContact: vi.fn(async (_input: { email: string; name?: string }) => ({ ok: true, status: "submitted" as const, message: "Thanks — details sent." })),
    getSetupInstallation: vi.fn(async () => installation),
    installSetupGlobally: vi.fn(async () => ({ ...installation, state: "failed" as const, message: "Global installation failed. Setup is still complete." })),
  });
  const onOpen = vi.fn();
  return { api, onOpen, render: (agentMemory = false) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <SetupCompletion api={api} agentMemory={agentMemory} pending={false} onOpen={onOpen} />
  </QueryClientProvider>) };
}

describe("setup completion", () => {
  it("shows the fresh-session guide and versioned commands without installing or submitting automatically", async () => {
    const user = userEvent.setup(); const harness = fixture(); harness.render();
    expect(await screen.findByLabelText("Email")).toBeVisible();
    expect(screen.getByText("npm install -g mex-agent@0.8.2")).toBeVisible();
    expect(screen.getByText("Read .mex/ROUTER.md and tell me what you know about this project.")).toBeVisible();
    expect(harness.api.installSetupGlobally).not.toHaveBeenCalled(); expect(harness.api.submitSetupContact).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open Hub" }));
    await waitFor(() => expect(harness.onOpen).toHaveBeenCalledOnce());
    expect(harness.api.rememberContactPreference).toHaveBeenCalledExactlyOnceWith({ status: "skipped" });
  });

  it("allows email without a name, keeps failed input for retry, then clears contact fields", async () => {
    const user = userEvent.setup(); const harness = fixture();
    harness.api.submitSetupContact.mockRejectedValueOnce(new Error("offline")); harness.render();
    const email = await screen.findByLabelText("Email");
    await user.type(email, "person@example.com");
    await user.click(screen.getByRole("button", { name: "Send details" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not send");
    expect(email).toHaveValue("person@example.com");
    await user.click(screen.getByRole("button", { name: "Send details" }));
    expect(await screen.findByText("Thanks — details sent.")).toBeVisible();
    expect(harness.api.submitSetupContact).toHaveBeenLastCalledWith({ email: "person@example.com", name: "" });
    expect(screen.queryByLabelText("Email")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open Hub" }));
    expect(harness.api.rememberContactPreference).not.toHaveBeenCalled();
  });

  it("lets a failed global install be retried, copied, or skipped while setup stays complete", async () => {
    const user = userEvent.setup(); const harness = fixture("skipped"); harness.render();
    const install = await screen.findByRole("button", { name: "Install globally" });
    await waitFor(() => expect(install).toBeEnabled()); await user.click(install);
    expect(await screen.findByRole("button", { name: "Retry installation" })).toBeEnabled();
    expect(screen.getByText("Global installation failed. Setup is still complete.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Copy install command" }));
    expect(await navigator.clipboard.readText()).toBe("npm install -g mex-agent@0.8.2");
    expect(screen.getByRole("button", { name: "Open Hub" })).toBeEnabled();
    await user.click(within(screen.getByRole("region", { name: "Optional global installation" })).getByRole("button", { name: "Skip" }));
    expect(screen.queryByRole("button", { name: "Retry installation" })).toBeNull();
  });

  it.each(["submitted", "skipped"] as const)("honors a %s preference in setup and Overview", async (status) => {
    const harness = fixture(status); const rendered = harness.render(true);
    await waitFor(() => expect(harness.api.getContactPreference).toHaveBeenCalled());
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Hub" })).toBeNull();
    rendered.unmount();
    render(<TeamAccessCard api={harness.api} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Request access" })).toBeNull());
    expect(harness.api.submitSetupContact).not.toHaveBeenCalled();
  });
});
