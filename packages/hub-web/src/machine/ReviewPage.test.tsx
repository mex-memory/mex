import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MachineReviewQueueSchema } from "@mex/hub-contracts/machine";
import { getFixture } from "./fixtures";
import { MachineHub } from "./MachineHub";

const normal = "Run the type checker before opening a pull request";
const conflict = "Read the live cart when checkout starts";
const migration = "Run checkout migrations during the release";
const judged = "Keep real customer names out of test data";
const personal = "Describe diagrams in their image captions";
const publicRule = "Use the shared spacing scale in new components";
const unknownRule = "Check links when moving a page";

function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  const user = userEvent.setup();
  render(<BrowserRouter><MachineHub /></BrowserRouter>);
  return user;
}

async function openReview(path = "/review?fixture=home") {
  const user = renderAt(path);
  await screen.findByRole("heading", { name: "Review", level: 1 });
  return user;
}

const queue = () => within(screen.getByRole("region", { name: "Review queue" }));
const row = (claim: string) => queue().getByRole("link", { name: new RegExp("^" + claim) });
const heading = (claim: string) => screen.getByRole("heading", { name: claim, level: 2 });
const action = (name: string) => within(screen.getByRole("group", { name: "Review actions" })).getByRole("button", { name });
const badge = () => within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Review" });

async function movedTo(claim: string) {
  await waitFor(() => expect(heading(claim)).toHaveFocus());
  expect(row(claim)).toHaveAttribute("aria-current", "page");
}

describe("Review fixtures", () => {
  it("orders contradictions then older cards inside each repo, with counts and provenance", async () => {
    expect(MachineReviewQueueSchema.parse(getFixture("home").review).total).toBe(8);
    await openReview();

    expect(queue().getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Storefront4", "Design kit2", "Docs site2"]);
    const storefront = within(queue().getByRole("list", { name: "Storefront" }));
    expect(storefront.getAllByRole("link")).toEqual([row(conflict), row(migration), row(normal), row(judged)]);
    expect(row(conflict)).toHaveTextContent("Contradiction");
    expect(row(normal)).toHaveTextContent("Rule · 6 days");
    expect(row(judged)).toHaveTextContent("Checked by model");
    expect(within(queue().getByRole("list", { name: "Design kit" })).getAllByRole("link")[0]).toBe(row(publicRule));
    expect(screen.getByText(/8 waiting/)).toHaveTextContent("8 waiting · oldest 6 days");
    expect(heading(conflict)).toBeVisible();
  });

  it("opens a shareable card URL and keeps Review when changing repo scope", async () => {
    const user = await openReview();
    await user.click(row(normal));
    expect(window.location.pathname).toBe("/review/storefront%3Atype-check");
    expect(window.location.search).toBe("?fixture=home");
    expect(heading(normal)).toHaveFocus();
    expect(badge()).toHaveAttribute("aria-current", "page");

    await user.selectOptions(screen.getByRole("combobox", { name: "Repo switcher" }), "design-kit");
    expect(window.location.pathname).toBe("/repos/design-kit/review");
    expect(queue().queryByRole("heading")).toBeNull();
    expect(queue().getAllByRole("link")).toHaveLength(2);
    await user.click(row(publicRule));
    expect(window.location.pathname).toBe("/repos/design-kit/review/design-kit%3Aspacing");
    expect(heading(publicRule)).toHaveFocus();
  });

  it("supports arrows and action keys and treats those keys as input in the editor", async () => {
    const user = await openReview();
    await user.keyboard("{ArrowDown}");
    await movedTo(migration);
    await user.keyboard("{ArrowUp}");
    await movedTo(conflict);
    await user.click(row(normal));
    await user.keyboard("s");
    const preview = await screen.findByRole("alertdialog", { name: "Share with team" });
    expect(within(preview).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(preview).not.toBeInTheDocument());
    expect(heading(normal)).toHaveFocus();

    await user.keyboard("e");
    const input = await screen.findByRole("textbox", { name: "Claim" });
    expect(input).toHaveFocus();
    await user.keyboard("{End}ske{ArrowDown}");
    expect(input).toHaveValue(normal + "ske");
    expect(heading(normal)).toBeVisible();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(action("Cancel"));
    expect(action("Edit")).toHaveFocus();
    await user.keyboard("k");
    expect(await screen.findByText("Kept for you", { exact: true })).toBeVisible();
    await movedTo(judged);
  });

  it("previews a private team file, confirms, selects the next card and opens the shared note", async () => {
    const user = await openReview("/review/storefront%3Atype-check?fixture=home");
    await user.click(action("Share with team"));
    const dialog = await screen.findByRole("alertdialog", { name: "Share with team" });
    expect(within(dialog).getByRole("list", { name: "Sharing checks" })).toHaveTextContent("No secrets or private data found");
    expect(within(dialog).getByText("Repository is private")).toBeVisible();
    expect(within(dialog).getByText("Checks still hold")).toBeVisible();
    expect(within(dialog).getByRole("region", { name: "File diff" })).toHaveTextContent(".mex/learned/mx_typecheck.md");
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await movedTo(judged);
    expect(queue().queryByRole("link", { name: new RegExp("^" + normal) })).toBeNull();
    expect(window.location.pathname).toBe("/review/storefront%3Afixtures");
    const toast = screen.getByText("Shared to .mex/learned/mx_typecheck.md").closest<HTMLElement>("[role=status]")!;
    expect(toast).toHaveAttribute("aria-live", "polite");
    expect(within(toast).getByText("Commit it to share with your team")).toBeVisible();
    await user.click(within(toast).getByRole("link", { name: "Open in Knowledge" }));
    expect(await screen.findByRole("region", { name: normal })).toHaveTextContent("Your team");
  });

  it("shows the public-repo approval requirement and can confirm", async () => {
    const user = await openReview("/repos/design-kit/review/design-kit%3Aspacing?fixture=home");
    await user.click(action("Share with team"));
    const dialog = await screen.findByRole("alertdialog", { name: "Share with team" });
    expect(within(dialog).getByText("Repository is public: sessions-based rules need your approval")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await movedTo("Add a keyboard example for new controls");
    expect(action("Share with team")).toBeDisabled();
    expect(action("Share with team")).toHaveAccessibleDescription("Record the checks before sharing this rule.");
  });

  it("disables confirmation with a reason when repo visibility can't be checked", async () => {
    const user = await openReview();
    await user.click(row(unknownRule));
    await user.click(action("Share with team"));
    const dialog = await screen.findByRole("alertdialog", { name: "Share with team" });
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAccessibleDescription("Couldn't check the repository. Sharing needs GitHub access (gh)");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(action("Share with team")).toHaveFocus());
    expect(row(unknownRule)).toHaveAttribute("aria-current", "page");
  });

  it("keeps a note immediately and links to the personal copy", async () => {
    const user = await openReview("/review/storefront%3Atype-check?fixture=home");
    await user.click(action("Keep for me"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await movedTo(judged);
    expect(screen.getByText("Kept for you", { exact: true })).toBeVisible();
    await user.click(screen.getByRole("link", { name: "Open in Knowledge" }));
    const note = await screen.findByRole("region", { name: normal });
    expect(note).toHaveTextContent("Only you");
    expect(window.location.pathname).toBe("/knowledge/storefront%3AonlyYou%3Amx_typecheck");
  });

  it("keeps the edited claim, text, kind and scope", async () => {
    const user = await openReview("/review/storefront%3Atype-check?fixture=home");
    await user.click(action("Edit"));
    const claim = "Run workspace checks locally";
    const text = "Run the type check at the root before pushing a change.";
    await user.clear(await screen.findByRole("textbox", { name: "Claim" }));
    expect(action("Keep for me")).toBeDisabled();
    expect(action("Keep for me")).toHaveAccessibleDescription("Enter a claim and note text to save.");
    await user.type(screen.getByRole("textbox", { name: "Claim" }), claim);
    await user.clear(screen.getByRole("textbox", { name: "Note text" }));
    await user.type(screen.getByRole("textbox", { name: "Note text" }), text);
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "procedure");
    await user.type(screen.getByRole("textbox", { name: "Scope pattern 1" }), "apps/api/**");
    await user.click(action("Keep for me"));
    await movedTo(judged);
    await user.click(screen.getByRole("link", { name: "Open in Knowledge" }));
    const note = await screen.findByRole("region", { name: claim });
    expect(note).toHaveTextContent(text);
    expect(note).toHaveTextContent("Procedure");
    expect(note).toHaveTextContent("Applies to apps/api");
  });

  it("previews the edited text before sharing", async () => {
    const user = await openReview("/review/storefront%3Atype-check?fixture=home");
    await user.click(action("Edit"));
    const text = await screen.findByRole("textbox", { name: "Note text" });
    await user.clear(text);
    await user.type(text, "Check all workspace imports before opening the pull request.");
    await user.click(action("Share with team"));
    const dialog = await screen.findByRole("alertdialog", { name: "Share with team" });
    expect(within(dialog).getByRole("region", { name: "File diff" })).toHaveTextContent("+Check all workspace imports");
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await movedTo(judged);
  });

  it("lists every retirement before using a proposal and moves both notes to Forgotten", async () => {
    const user = await openReview();
    await user.click(action("Use proposal"));
    const dialog = await screen.findByRole("alertdialog", { name: "Use this proposal?" });
    expect(within(dialog).getByText("Saves the proposal as your note.")).toBeVisible();
    expect(dialog).toHaveTextContent("Retires: Start checkout from a saved cart snapshot, Use the checkout seed when testing the guest cart (they move to Forgotten).");
    expect(within(dialog).getByText("Cost: free")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Use proposal" }));

    await movedTo(migration);
    expect(screen.getByText("Proposal used; 2 notes retired")).toBeVisible();
    await user.click(screen.getByRole("link", { name: "Open in Knowledge" }));
    expect(await screen.findByRole("region", { name: conflict })).toHaveTextContent("Only you");
    await user.click(screen.getByRole("link", { name: /Forgotten/ }));
    const table = await screen.findByRole("table", { name: "Forgotten items" });
    expect(table).toHaveTextContent("mx_snapshot");
    expect(table).toHaveTextContent("mx_guestcart");
  });

  it("keeps current notes and dismisses a proposal without a dialog", async () => {
    const user = await openReview();
    await user.click(action("Keep current"));
    await movedTo(migration);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("Kept your current notes. The proposal was dismissed.")).toBeVisible();
    await user.click(screen.getByRole("link", { name: "Open in Knowledge" }));
    expect(await screen.findByRole("region", { name: "Start checkout from a saved cart snapshot" })).toBeVisible();
  });

  it("retires a personal judged note using Knowledge's wording and focuses it in Forgotten", async () => {
    const user = await openReview("/repos/docs-site/review/docs-site%3Aalt-text?fixture=home");
    expect(heading(personal)).toBeVisible();
    expect(screen.getByText("Checked by model.")).toBeVisible();
    await user.click(action("Retire"));
    const dialog = await screen.findByRole("alertdialog", { name: "Forget this note?" });
    expect(dialog).toHaveTextContent("MEX stops using it. The file stays on disk, and it moves to Forgotten.");
    expect(dialog).toHaveTextContent("Cost: free");
    await user.click(within(dialog).getByRole("button", { name: "Forget" }));
    await movedTo(unknownRule);
    await user.click(screen.getByRole("link", { name: "View in Forgotten" }));
    expect(await screen.findByRole("row", { name: /mx_diagrams/ })).toHaveFocus();
  });

  it("shows a file diff before retiring a judged team note", async () => {
    const user = await openReview("/repos/storefront/review/storefront%3Afixtures?fixture=home");
    await user.click(action("Retire"));
    const dialog = await screen.findByRole("alertdialog", { name: "Forget this team note?" });
    await user.click(within(dialog).getByRole("button", { name: "Review changes" }));
    const preview = await screen.findByRole("alertdialog", { name: "Review retirement" });
    expect(within(preview).getByRole("region", { name: "File diff" })).toHaveTextContent("status: retired");
    await user.click(within(preview).getByRole("button", { name: "Confirm" }));
    await movedTo(normal);
    expect(screen.getByText("Moved to Forgotten")).toBeVisible();
  });

  it.each([
    ["review-handled", "Already handled elsewhere (Kept)"],
    ["review-handled-unknown", "Already handled elsewhere"],
  ])("shows the handled result inline in %s and lets the user move on", async (variant, message) => {
    const user = await openReview("/review/storefront%3Atype-check?fixture=" + variant);
    await user.click(action("Keep for me"));
    expect(await screen.findByText(message, { exact: true })).toBeVisible();
    expect(action("Next")).toHaveFocus();
    expect(row(normal)).toHaveAttribute("aria-current", "page");
    await user.click(action("Next"));
    await movedTo(judged);
    expect(screen.queryByText(message, { exact: true })).toBeNull();
  });

  it("retries a busy write once, surfaces the failure, and permits another attempt", async () => {
    const user = await openReview("/review/storefront%3Atype-check?fixture=review-busy");
    await user.click(action("Keep for me"));
    expect(await screen.findByText("MEX is busy, retrying…")).toHaveAttribute("role", "status");
    expect(action("Keep for me")).toBeDisabled();
    expect(action("Keep for me")).toHaveAccessibleDescription("MEX is busy, retrying…");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
    expect(heading(normal)).toBeVisible();
    await user.click(action("Keep for me"));
    await movedTo(judged);
  });

  it("shows an illustration-free empty state with a working Knowledge link", async () => {
    const user = await openReview("/review?fixture=review-empty");
    expect(screen.getByRole("heading", { name: "Nothing to review." })).toBeVisible();
    expect(screen.getByText("MEX will ask when it learns something worth sharing.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Review queue" })).toBeNull();
    expect(badge()).toHaveTextContent(/^Review$/);
    await user.click(screen.getByRole("link", { name: "Open Knowledge" }));
    expect(await screen.findByRole("heading", { name: "Knowledge", level: 1 })).toBeVisible();
  });

  it("shows loading while waiting for the first queue", async () => {
    const user = await openReview("/review?fixture=review-loading");
    expect(screen.getByText("Loading Review…")).toHaveAttribute("role", "status");
    expect(screen.queryByText("Nothing to review.")).toBeNull();
    await user.click(badge());
    expect(window.location.search).toBe("?fixture=review-loading");
  });

  it("keeps the last queue visible while updating", async () => {
    await openReview("/review?fixture=updating");
    expect(screen.getByText("Updating…")).toHaveAttribute("role", "status");
    expect(queue().getAllByRole("link")).toHaveLength(8);
  });

  it("links Home's tile, card action and scoped rule rows directly to Review", async () => {
    const user = renderAt("/?fixture=home");
    const tile = await screen.findByRole("link", { name: "Needs you" });
    await user.click(tile);
    expect(await screen.findByRole("heading", { name: "Review", level: 1 })).toBeVisible();
    expect(window.location.pathname).toBe("/review");

    await user.click(screen.getByRole("link", { name: "Home" }));
    const card = within(await screen.findByRole("region", { name: "Needs you" }));
    await user.click(card.getByRole("link", { name: "Open Review" }));
    expect(window.location.pathname).toBe("/review");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.selectOptions(screen.getByRole("combobox", { name: "Repo switcher" }), "storefront");
    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(screen.getByRole("link", { name: "Needs you" })).toHaveAttribute("href", "/repos/storefront/review?fixture=home");
    const scoped = within(screen.getByRole("region", { name: "Needs you" }));
    expect(scoped.getByRole("link", { name: "Open Review" })).toHaveAttribute("href", "/repos/storefront/review?fixture=home");
    await user.click(scoped.getByRole("link", { name: new RegExp("^" + normal) }));
    expect(window.location.pathname).toBe("/repos/storefront/review/storefront%3Atype-check");
    expect(heading(normal)).toHaveFocus();
  });

  it("updates the nav badge as the queue changes and switches to the repo count", async () => {
    const user = await openReview();
    expect(badge()).toHaveTextContent("8");
    expect(badge()).toHaveAccessibleDescription("8 waiting");
    await user.click(action("Keep current"));
    await movedTo(migration);
    expect(badge()).toHaveAccessibleDescription("7 waiting");
    await user.selectOptions(screen.getByRole("combobox", { name: "Repo switcher" }), "storefront");
    expect(badge()).toHaveAccessibleDescription("3 waiting");
  });
});
