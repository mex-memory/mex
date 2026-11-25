import { MachineSetupSchema } from "@mex/hub-contracts/machine";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { fixtureSetup, startFixtureLearning } from "./fixture-setup";
import { MachineHub } from "./MachineHub";

const storefront = "/repos/storefront/setup?fixture=setup";
const steps = () => within(screen.getByRole("region", { name: "Setup steps" }));
const selectRepo = () => screen.getByRole("combobox", { name: "Repo switcher" });

async function openHub(path = storefront, page = "Setup") {
  window.history.replaceState(null, "", path);
  const user = userEvent.setup();
  render(<BrowserRouter><MachineHub /></BrowserRouter>);
  await screen.findByRole("heading", { level: 1, name: page });
  return user;
}

describe("Setup fixtures", () => {
  it("validates the fixtures and only accepts the current learning estimate once", () => {
    const data = fixtureSetup(Date.now());
    expect(MachineSetupSchema.parse(data).repos).toHaveLength(4);
    const repo = data.repos.find(({ repoId }) => repoId === "storefront")!;
    const offer = repo.learnDeeper;
    expect(offer?.state).toBe("offered");
    if (offer?.state !== "offered") throw new Error("The fixture needs a quote.");
    expect(startFixtureLearning(repo, { ...offer.quote, tokens: 1 }, "2026-11-25T00:00:00Z")).toBe(repo);
    const queued = startFixtureLearning(repo, offer.quote, "2026-11-25T00:00:00Z");
    expect(queued.steps.at(-1)).toMatchObject({ kind: "learn-deeper", state: "queued", estimate: { tokens: 48_000 } });
    expect(startFixtureLearning(queued, offer.quote, "2026-11-25T00:00:00Z")).toBe(queued);
  });

  it("opens from the nav and keeps the terminal order when switching repos", async () => {
    const user = await openHub("/?fixture=setup", "Home");
    await user.click(screen.getByRole("link", { name: "Setup" }));
    await screen.findByRole("heading", { level: 1, name: "Setup" });
    expect(window.location.pathname).toBe("/setup");
    expect(screen.getByRole("list", { name: "Repos" })).toHaveTextContent("2 questions waiting");
    await user.selectOptions(selectRepo(), "storefront");
    expect(window.location.pathname).toBe("/repos/storefront/setup");
    expect(window.location.search).toBe("?fixture=setup");
    expect(steps().getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "File index", "Code facts", "Code map", "Learn deeper",
    ]);
    expect(screen.getByRole("region", { name: "Free setup" })).toHaveTextContent("Test and build commands for 3 packages.");
    expect(steps().getByRole("progressbar", { name: "Code map progress" })).toHaveAttribute("value", "1504");
    expect(steps().getByText("About 4 minutes · about 48,000 tokens")).toBeVisible();
    expect(screen.getByRole("heading", { name: "2 quick questions" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Summary" })).toBeVisible();
  });

  it("pauses, resumes and cancels at the fixture batch boundary and opens the matching job", async () => {
    const user = await openHub();
    const pause = steps().getByRole("button", { name: "Pause" });
    await user.click(pause);
    expect(pause).toHaveAttribute("aria-disabled", "true");
    expect(pause).toHaveAccessibleDescription(/Pausing after this batch.*resume or cancel/);
    const resume = await steps().findByRole("button", { name: "Resume" });
    expect(steps().getByText("Paused", { exact: true })).toBeVisible();
    expect(steps().getByText("1,504 of 4,280 files", { exact: true })).toBeVisible();
    await user.click(resume);
    expect(steps().getByText("Queued", { exact: true })).toBeVisible();
    await steps().findByText("Running", { exact: true });

    const cancel = steps().getByRole("button", { name: "Cancel" });
    await user.click(cancel);
    const dialog = within(await screen.findByRole("alertdialog", { name: "Cancel code map?" }));
    await user.click(dialog.getByRole("button", { name: "Keep job" }));
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.click(cancel);
    const reopened = within(await screen.findByRole("alertdialog", { name: "Cancel code map?" }));
    await user.click(reopened.getByRole("button", { name: "Cancel job" }));
    expect(await steps().findByText(/Cancelling after this batch/)).toBeVisible();
    expect(await steps().findByText("Cancelled", { exact: true })).toBeVisible();
    expect(steps().queryByRole("progressbar")).not.toBeInTheDocument();

    await user.click(steps().getByRole("link", { name: "View job for Code map" }));
    const job = await screen.findByRole("button", { name: /^Code map.*Stopped/ });
    expect(window.location.hash).toBe("#job-storefront-map");
    expect(job).toHaveAttribute("aria-expanded", "true");
    expect(job).toHaveFocus();
    expect(job.closest("details")).toHaveAttribute("open");
    const row = within(job.closest("li")!);
    expect(row.getByText("No AI cost", { exact: true })).toBeVisible();
  });

  it("shows the estimate before consent and queues one job after keyboard confirmation", async () => {
    const user = await openHub();
    expect(steps().getByText("Give your agents what your team already knows.")).toBeVisible();
    expect(within(steps().getByRole("list", { name: "What it learns" })).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["Review conventions", "Past decisions", "Known pitfalls"]);
    const start = steps().getByRole("button", { name: "Learn deeper" });
    start.focus();
    await user.keyboard("{Enter}");
    const dialog = within(await screen.findByRole("alertdialog", { name: "Learn from your team’s reviews?" }));
    for (const detail of ["About 4 minutes", "48,000 tokens", "72,000 tokens"]) expect(dialog.getByText(detail)).toBeVisible();
    expect(dialog.getByText(/Starts after the code map\./)).toBeVisible();
    expect(dialog.getByText(/Claude Code plan/)).toBeVisible();
    expect(dialog.getByText(/Lessons stay personal until you share them/)).toBeVisible();
    expect(dialog.getByText(/every 7–14 days/)).toBeVisible();
    await waitFor(() => expect(dialog.getByRole("button", { name: "Back" })).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(start).toHaveFocus());
    expect(steps().queryByRole("link", { name: "View job for Learn deeper" })).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    const reopened = within(await screen.findByRole("alertdialog", { name: "Learn from your team’s reviews?" }));
    await waitFor(() => expect(reopened.getByRole("button", { name: "Back" })).toHaveFocus());
    await user.tab();
    expect(reopened.getByRole("button", { name: "Start learning" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(steps().getByText("Starts after the code map and other setup work.")).toBeVisible();
    expect(steps().getByText("48,000 tokens estimated")).toBeVisible();
    expect(steps().queryByRole("button", { name: "Learn deeper" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Setup steps" })).toHaveFocus());

    await user.click(steps().getByRole("link", { name: "View job for Learn deeper" }));
    expect(await screen.findByRole("button", { name: /^Learn deeper.*Queued/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button", { name: /^Learn deeper.*Queued/ })).toHaveLength(1);
  });

  it("skips learning without a job or charge and keeps the questions available", async () => {
    const user = await openHub();
    await user.click(steps().getByRole("button", { name: "Not now" }));
    expect(steps().getByText(/Not started · run/)).toBeVisible();
    expect(steps().getByText("mex learn", { exact: true })).toBeVisible();
    expect(steps().queryByRole("link", { name: "View job for Learn deeper" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2 quick questions" })).toBeVisible();
  });

  it("offers the template choices and remembers an answer and a skip during navigation", async () => {
    const user = await openHub();
    const conflict = screen.getByRole("group", { name: /Which is right\?/ });
    const testCommand = screen.getByRole("group", { name: /Which is the real one\?/ });
    expect(within(conflict).getAllByRole("button")).toHaveLength(3);
    expect(within(testCommand).getAllByRole("button").map((button) => button.textContent)).toEqual(["npm test", "make test", "both", "Skip"]);

    await user.click(within(conflict).getByRole("button", { name: /AGENTS\.md is right/ }));
    expect(screen.getByRole("heading", { name: /Which is right\?/ })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "1 quick question" })).toBeVisible();
    await user.click(within(testCommand).getByRole("button", { name: "Skip" }));
    expect(screen.getByRole("heading", { name: "Setup questions" })).toBeVisible();

    await user.selectOptions(selectRepo(), "design-kit");
    expect(screen.queryByRole("heading", { name: "Setup questions" })).not.toBeInTheDocument();
    await user.selectOptions(selectRepo(), "storefront");
    expect(screen.getByText('Saved: your agents get it as "you said"')).toBeVisible();
    expect(screen.getByText("Skipped", { exact: true })).toBeVisible();
  });

  it("skips all of the waiting questions together", async () => {
    const user = await openHub();
    await user.click(screen.getByRole("button", { name: "Skip all" }));
    const questions = within(screen.getByRole("region", { name: "Setup questions" }));
    expect(questions.getAllByText("Skipped", { exact: true })).toHaveLength(2);
    expect(questions.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows completed cost, gaps and the repo's Review link", async () => {
    const user = await openHub("/repos/design-kit/setup?fixture=setup");
    expect(steps().getByText("Done with gaps")).toBeVisible();
    expect(steps().getByText(/Four files couldn’t be read/)).toBeVisible();
    expect(steps().getByText("31,200 tokens used · 36,000 tokens estimated")).toBeVisible();
    await user.click(steps().getByRole("link", { name: "Open Review" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Review" })).toBeVisible();
    expect(window.location.pathname).toBe("/repos/design-kit/review");
    expect(window.location.search).toBe("?fixture=setup");
  });

  it("shows a failed or unavailable step and the $0 no-remote case", async () => {
    const user = await openHub("/repos/docs-site/setup?fixture=setup");
    expect(steps().getByText("Failed", { exact: true })).toBeVisible();
    expect(steps().getByText("Couldn’t read the repo folder.")).toBeVisible();
    expect(steps().getByText(/This is a shallow clone/)).toBeVisible();
    expect(steps().getByText(/Restore it and run/)).toBeVisible();
    expect(steps().queryByRole("button", { name: "Learn deeper" })).not.toBeInTheDocument();
    await user.selectOptions(selectRepo(), "field-notes");
    expect(steps().getByText(/no GitHub or GitLab remote.*\$0, nothing started/)).toBeVisible();
    expect(steps().queryByRole("link", { name: "View job for Learn deeper" })).not.toBeInTheDocument();
  });

  it("copies the terminal command when there are no repos", async () => {
    const user = await openHub("/setup?fixture=empty");
    expect(screen.getByRole("heading", { name: "Set up your first repo" })).toBeVisible();
    expect(screen.getByText("mex", { exact: true })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe("mex");
  });
});
