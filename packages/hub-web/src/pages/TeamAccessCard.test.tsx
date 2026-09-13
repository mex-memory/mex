import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TEAM_ACCESS_FOLLOW_UP_SUBJECT,
  TEAM_ACCESS_STORAGE_KEY,
  TEAM_ACCESS_SUBJECT,
  WEB3FORMS_SUBMIT_URL,
  __setWeb3FormsAccessKeyForTests,
} from "../lib/team-access-lead";
import { TeamAccessCard } from "./TeamAccessCard";

function postedBodies() {
  return vi.mocked(fetch).mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
}

beforeEach(() => {
  __setWeb3FormsAccessKeyForTests("public-test-key");
  window.localStorage.removeItem(TEAM_ACCESS_STORAGE_KEY);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true }),
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __setWeb3FormsAccessKeyForTests(null);
  window.localStorage.removeItem(TEAM_ACCESS_STORAGE_KEY);
  vi.unstubAllGlobals();
});

describe("TeamAccessCard", () => {
  it("preserves unsent contact details when the lazy dialog is reopened", async () => {
    const user = userEvent.setup();
    render(<TeamAccessCard />);
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const dialog = await screen.findByRole("dialog", undefined, { timeout: 5_000 });
    await user.type(within(dialog).getByLabelText("Name"), "Ada Lovelace");
    await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Request access" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).getByLabelText("Name")).toHaveValue("Ada Lovelace");
    expect(within(reopened).getByLabelText("Email")).toHaveValue("ada@example.com");
    expect(fetch).not.toHaveBeenCalled();
  }, 15_000);

  it("unlocks a stalled contact request and lets the user close and retry", async () => {
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(() => {}));
    const user = userEvent.setup();
    render(<TeamAccessCard />);
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Ada Lovelace");
    await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
    vi.useFakeTimers();
    fireEvent.submit(within(dialog).getByRole("button", { name: "Request access" }).closest("form")!);
    expect(within(dialog).getByRole("button", { name: "Sending…" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    vi.useRealTimers();

    expect(screen.getByRole("alert")).toHaveTextContent("Could not send your request. Try again.");
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(within(dialog).getByLabelText("Email")).toBeEnabled();
    expect(window.localStorage.getItem(TEAM_ACCESS_STORAGE_KEY)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).getByLabelText("Email")).toHaveValue("ada@example.com");
    await user.click(within(reopened).getByRole("button", { name: "Request access" }));
    expect(await screen.findByRole("heading", { name: "You’re on the list" })).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("allows skipping a stalled optional submission after its deadline", async () => {
    const user = userEvent.setup();
    render(<TeamAccessCard />);
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Ada Lovelace");
    await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Request access" }));
    await screen.findByRole("heading", { name: "You’re on the list" });
    await user.type(within(dialog).getByLabelText("Company"), "Analytical Engines");
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(() => {}));
    vi.useFakeTimers();
    fireEvent.submit(within(dialog).getByRole("button", { name: "Continue" }).closest("form")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    vi.useRealTimers();

    expect(screen.getByRole("alert")).toHaveTextContent("Could not send your request. Try again.");
    expect(within(dialog).getByLabelText("Company")).toHaveValue("Analytical Engines");
    await user.click(within(dialog).getByRole("button", { name: "Skip" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Thanks for sharing your details. Keep using this Hub with your team.")).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("opens an in-Hub contact step with only name and email", async () => {
    const user = userEvent.setup();
    render(<TeamAccessCard />);

    expect(screen.getByRole("heading", { name: "From mex" })).toBeVisible();
    expect(screen.getByText("This Hub already works with your team.")).toBeVisible();
    expect(screen.getByText("Design-partner access is open for shared team memory.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Request access" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Request access" })).toBeVisible();
    expect(within(dialog).getByLabelText("Name")).toBeVisible();
    expect(within(dialog).getByLabelText("Email")).toBeVisible();
    expect(within(dialog).queryByLabelText("Company")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Team size")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Used only to follow up about team access.")).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the lead on the first valid submit, then asks optional questions", async () => {
    const user = userEvent.setup();
    render(<TeamAccessCard />);
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Ada Lovelace");
    await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Request access" }));

    expect(await screen.findByRole("heading", { name: "You’re on the list" })).toBeVisible();
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(WEB3FORMS_SUBMIT_URL);
    expect(postedBodies()[0]).toEqual({
      access_key: "public-test-key",
      name: "Ada Lovelace",
      email: "ada@example.com",
      subject: TEAM_ACCESS_SUBJECT,
      from_name: "mex Hub",
      source: "mex-hub",
    });
    expect(within(screen.getByRole("dialog")).getByLabelText("Company")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByLabelText("Team size")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByLabelText("How did you find mex?")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByLabelText("Why did you install it?")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByLabelText("Your repo is")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByLabelText("Do others use agents on this repo?")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByLabelText("I need")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByLabelText("What’s missing?")).toBeVisible();
  });

  it("keeps the user on step 1 when Web3Forms rejects the contact submit", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ success: false }),
    } as Response);
    const user = userEvent.setup();
    render(<TeamAccessCard />);
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Ada Lovelace");
    await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Request access" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not send your request. Try again.");
    expect(within(dialog).getByRole("heading", { name: "Request access" })).toBeVisible();
    expect(within(dialog).queryByLabelText("Company")).not.toBeInTheDocument();
  });

  it("does not resubmit name and email when the optional step is skipped", async () => {
    const user = userEvent.setup();
    render(<TeamAccessCard />);
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Ada Lovelace");
    await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Request access" }));
    await screen.findByRole("heading", { name: "You’re on the list" });
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Skip" }));

    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Thanks for sharing your details. Keep using this Hub with your team.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Request access" })).not.toBeInTheDocument();
  });

  it("keeps the captured lead if the panel is closed after the contact submit", async () => {
    const user = userEvent.setup();
    render(<TeamAccessCard />);
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Ada Lovelace");
    await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Request access" }));
    await screen.findByRole("heading", { name: "You’re on the list" });
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));

    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Thanks for sharing your details. Keep using this Hub with your team.")).toBeVisible();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("sends optional follow-up details with the same name and email", async () => {
    const user = userEvent.setup();
    render(<TeamAccessCard />);
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Ada Lovelace");
    await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Request access" }));
    await screen.findByRole("heading", { name: "You’re on the list" });
    const details = screen.getByRole("dialog");
    await user.type(within(details).getByLabelText("Company"), "Analytical Engines");
    await user.selectOptions(within(details).getByLabelText("Team size"), "2–10");
    await user.selectOptions(within(details).getByLabelText("How did you find mex?"), "GitHub");
    await user.selectOptions(within(details).getByLabelText("Why did you install it?"), "Agent memory");
    await user.selectOptions(within(details).getByLabelText("Your repo is"), "Work");
    await user.selectOptions(within(details).getByLabelText("Do others use agents on this repo?"), "Yes");
    await user.selectOptions(within(details).getByLabelText("I need"), "Shared team memory");
    await user.type(within(details).getByLabelText("What’s missing?"), "Shared follow-up");
    await user.click(within(details).getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(postedBodies()[1]).toEqual({
      access_key: "public-test-key",
      name: "Ada Lovelace",
      email: "ada@example.com",
      subject: TEAM_ACCESS_FOLLOW_UP_SUBJECT,
      from_name: "mex Hub",
      source: "mex-hub",
      company: "Analytical Engines",
      team_size: "2–10",
      found_mex: "GitHub",
      install_reason: "Agent memory",
      repo_kind: "Work",
      others_use_agents: "Yes",
      i_need: "Shared team memory",
      whats_missing: "Shared follow-up",
    });
  });

  it("shows the done card on the next Overview render after a successful contact submit", async () => {
    const user = userEvent.setup();
    const view = render(<TeamAccessCard />);
    await user.click(screen.getByRole("button", { name: "Request access" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Ada Lovelace");
    await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Request access" }));
    await screen.findByRole("heading", { name: "You’re on the list" });
    view.unmount();

    render(<TeamAccessCard />);
    expect(screen.getByText("Thanks for sharing your details. Keep using this Hub with your team.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Request access" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByText("Help shape MEX")).not.toBeInTheDocument();
  });
});
