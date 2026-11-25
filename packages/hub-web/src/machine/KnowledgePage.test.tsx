import type { MachineProject } from "@mex/hub-contracts/machine";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFixture } from "./fixtures";
import { MachineHub } from "./MachineHub";
import type { KnowledgeDetail } from "./types";

const personal = "Validate checkout inputs at the API boundary";
const team = "Keep the checkout total in integer cents";
const hint = "Try the compact menu story when checking keyboard focus";
const outdated = "Avoid reusing checkout fixtures after a schema change";
const changedMenu = "Keep the keyboard focus ring on menu items";
const changedCart = "Use the checkout seed when testing the guest cart";
const landingPath = "/knowledge?fixture=home";

function renderFixture(path = landingPath + "&view=list") {
  window.history.replaceState(null, "", path);
  render(<BrowserRouter><MachineHub /></BrowserRouter>);
  return userEvent.setup();
}

const params = () => new URLSearchParams(window.location.search);
const list = () => within(screen.getByRole("list", { name: "Items" }));
const row = (claim: string) => list().getByRole("link", { name: new RegExp(`^${claim}`) });
const detail = (claim: string) => within(screen.getByRole("region", { name: claim }));
const card = (name: string) => within(screen.getByRole("region", { name }));

async function openItem(user: ReturnType<typeof userEvent.setup>, claim: string) {
  await screen.findByRole("list", { name: "Items" });
  await user.click(row(claim));
  return await screen.findByRole("heading", { level: 2, name: claim });
}

describe("Knowledge landing", () => {
  it("opens by kind with the status summary and the three most recently used rules", async () => {
    renderFixture(landingPath);
    expect(await screen.findByRole("radio", { name: "By kind" })).toBeChecked();
    expect(screen.getAllByRole("heading", { level: 2 }).map(({ textContent }) => textContent)).toEqual([
      "Needs a look (4)", "Rules", "Decisions", "Recipes", "Pitfalls", "Procedures", "Facts", "Hints from your agent",
    ]);
    expect(card("Knowledge status totals").getByText("40")).toBeVisible();
    expect(card("Rules").getByRole("img", { name: "12 up to date, 2 code changed, 0 out of date, 2 not checked" })).toBeVisible();
    expect(card("Rules").getByRole("list")).toBeVisible();
    expect(within(card("Rules").getByRole("list")).getAllByRole("link").map(({ textContent }) => textContent)).toEqual([
      personal, "Use the shared spacing scale in new components", "Check links when moving a page",
    ]);
    expect(screen.queryByRole("list", { name: "Items" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Kind" })).toBeNull();
  });

  it("sees all rules in a filtered list and returns to the landing", async () => {
    const user = renderFixture(landingPath);
    await screen.findByRole("heading", { name: "Rules" });
    await user.click(card("Rules").getByRole("link", { name: "See all 16 in Rules" }));
    expect(params().get("kind")).toBe("rule");
    expect(list().getAllByRole("link")).toHaveLength(16);
    expect(row(personal)).toBeVisible();
    expect(card("Knowledge status totals").getByText("40")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Kind" })).toHaveValue("rule");

    await user.selectOptions(screen.getByRole("combobox", { name: "Who sees it" }), "team");
    await user.click(screen.getByRole("link", { name: "All knowledge" }));
    expect(window.location.pathname + window.location.search).toBe(landingPath);
    expect(screen.getByRole("radio", { name: "By kind" })).toBeChecked();
  });

  it("opens the full list and selects a note directly from a kind card", async () => {
    const user = renderFixture(landingPath);
    await user.click(await screen.findByRole("link", { name: "View all items" }));
    expect(params().get("view")).toBe("list");
    expect(screen.getByText("Showing 20 of 40")).toBeVisible();
    await user.click(screen.getByRole("link", { name: "All knowledge" }));

    await user.click(card("Rules").getByRole("link", { name: personal }));
    expect(await screen.findByRole("heading", { level: 2, name: personal })).toHaveFocus();
    expect(params().get("kind")).toBe("rule");
    expect(row(personal)).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("link", { name: "Close item" }));
    expect(row(personal)).toHaveFocus();
  });

  it("groups multi-pattern notes under each area and filters to the area and repo", async () => {
    const user = renderFixture(landingPath);
    const group = within(await screen.findByRole("radiogroup", { name: "Group knowledge by" }));
    await user.click(group.getByText("By area"));
    expect(params().get("view")).toBe("area");
    expect(group.getByRole("radio", { name: "By area" })).toBeChecked();
    expect(screen.getAllByRole("heading", { level: 2 }).slice(1, 5).map(({ textContent }) => textContent)).toEqual([
      "Whole repo", "Storefront · apps/api", "Design kit · packages/ui", "Storefront · apps/web",
    ]);
    expect(card("Storefront · apps/api").getByRole("link", { name: team + " Rule" })).toBeVisible();
    expect(card("Storefront · packages/money").getByRole("link", { name: team + " Rule" })).toBeVisible();
    expect(screen.getByText(/Most items apply to the whole repo/)).toBeVisible();

    await user.click(card("Storefront · apps/api").getByRole("link", { name: /^See all / }));
    expect(params().get("area")).toBe("apps/api/**");
    expect(params().get("repo")).toBe("storefront");
    expect(screen.getByRole("combobox", { name: "Area" })).toHaveValue("apps/api/**");
    expect(list().getAllByRole("link")).toHaveLength(4);
    expect(row(team)).toBeVisible();
    expect(list().queryByRole("link", { name: new RegExp(`^${changedCart}`) })).toBeNull();
  });

  it("keeps the area view in a repo and matches an exact path", async () => {
    const user = renderFixture(landingPath + "&view=area");
    await screen.findByRole("heading", { name: "Storefront · apps/api" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Repo switcher" }), "storefront");
    expect(window.location.pathname).toBe("/repos/storefront/knowledge");
    expect(params().get("view")).toBe("area");
    expect(screen.getByRole("heading", { name: "apps/api" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Design kit · packages/ui" })).toBeNull();

    await user.click(card("apps/api/src/checkout.ts").getByRole("link", { name: changedCart + " Recipe" }));
    expect(params().get("area")).toBe("apps/api/src/checkout.ts");
    expect(params().has("repo")).toBe(false);
    expect(list().getAllByRole("link")).toHaveLength(1);
    expect(row(changedCart)).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { name: changedCart })).toHaveFocus();
    await user.click(screen.getByRole("link", { name: "All knowledge" }));
    expect(window.location.pathname).toBe("/repos/storefront/knowledge");
    expect(window.location.search).toBe("?fixture=home");
    expect(screen.getByRole("radio", { name: "By kind" })).toBeChecked();
  });

  it("shows three review items with out of date first and older changes ahead of newer ones", async () => {
    const user = renderFixture(landingPath);
    await screen.findByRole("heading", { name: "Needs a look (4)" });
    const review = card("Needs a look (4)");
    const items = review.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(outdated);
    expect(items[0]).toHaveTextContent("A check no longer holds");
    expect(items[1]).toHaveTextContent(team);
    expect(items[1]).toHaveTextContent("Code changed in packages/money/src/totals.ts");
    expect(items[2]).toHaveTextContent(changedMenu);
    expect(items[2]).toHaveTextContent("Rule · Design kit · Your team");

    await user.click(review.getByRole("link", { name: "Show all 4" }));
    expect(params().get("status")).toBe("needs-look");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("needs-look");
    expect(list().getAllByRole("link")).toHaveLength(4);
    expect(row(outdated)).toBeVisible();
    expect(row(changedCart)).toBeVisible();
  });

  it("keeps a compact calm state when every checked note holds", async () => {
    renderFixture("/knowledge?fixture=calm");
    const review = await screen.findByRole("region", { name: "Needs a look" });
    expect(review).toHaveTextContent("Nothing needs a look. Every checked item still holds.");
    expect(within(review).queryByRole("link")).toBeNull();
    expect(screen.getByRole("heading", { name: "Rules" })).toBeVisible();
  });

  it("starts the editor from a review row and uses the team diff flow", async () => {
    const user = renderFixture(landingPath);
    await user.click(await screen.findByRole("button", { name: `Edit ${team}` }));
    expect(params().get("status")).toBe("needs-look");
    const summary = await screen.findByRole("textbox", { name: "One-line summary" });
    expect(summary).toHaveValue(team);
    expect(summary).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: "Note text" }), { target: { value: "Send the total as whole cents." } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alertdialog", { name: "Review changes to team note" })).toBeVisible();
  });

  it("starts the forget flow from a review row and updates the landing after confirmation", async () => {
    const user = renderFixture(landingPath);
    await user.click(await screen.findByRole("button", { name: `Forget ${outdated}` }));
    const dialog = within(await screen.findByRole("alertdialog", { name: "Forget this note?" }));
    await user.click(dialog.getByRole("button", { name: "Forget" }));
    expect(screen.getByText("Showing 3 of 3")).toBeVisible();
    await user.click(screen.getByRole("link", { name: "All knowledge" }));
    expect(screen.getByRole("heading", { name: "Needs a look (3)" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Forgotten (4)" })).toBeVisible();
    expect(card("Needs a look (3)").getByText(changedCart)).toBeVisible();
  });
});

describe("Knowledge fixtures", () => {
  it("reads every filter from the URL and writes selection changes back", async () => {
    const user = renderFixture("/knowledge?fixture=home&kind=rule&audience=team&status=code-changed&repo=design-kit&q=focus");
    await screen.findByRole("list", { name: "Items" });
    expect(list().getAllByRole("link")).toHaveLength(1);
    expect(row("Keep the keyboard focus ring on menu items")).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search knowledge" })).toHaveValue("focus");
    expect(screen.getByRole("combobox", { name: "Who sees it" })).toHaveValue("team");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("code-changed");
    expect(screen.getByRole("combobox", { name: "Repo" })).toHaveValue("design-kit");

    const kind = screen.getByRole("combobox", { name: "Kind" });
    expect(kind).toHaveValue("rule");
    await user.selectOptions(kind, "");
    expect(params().has("kind")).toBe(false);
    expect(params().get("audience")).toBe("team");
    expect(params().get("q")).toBe("focus");
    expect(kind).toHaveFocus();
  });

  it("opens the Knowledge page from Home with a shared status filter", async () => {
    const user = renderFixture("/repos/storefront?fixture=home");
    const card = await screen.findByRole("region", { name: "What MEX knows" });
    expect(within(card).getByRole("link", { name: "Open Knowledge" })).toHaveAttribute("href", "/repos/storefront/knowledge?fixture=home");
    expect(screen.getByRole("link", { name: "What MEX knows" })).toHaveAttribute("href", "/repos/storefront/knowledge?fixture=home");
    await user.click(within(card).getByRole("link", { name: /^View code changed items \(Rule,/ }));
    await screen.findByRole("heading", { name: "Knowledge" });
    expect(window.location.pathname).toBe("/repos/storefront/knowledge");
    expect(params().get("status")).toBe("code-changed");
    expect(list().getAllByRole("link")).toHaveLength(2);
    expect(screen.queryByRole("combobox", { name: "Repo" })).toBeNull();
  });

  it("toggles status filtering from the bar and legend and clears it", async () => {
    const user = renderFixture("/knowledge?fixture=home");
    const segment = await screen.findByRole("button", { name: "Filter by code changed (3 items)" });
    expect(segment).toHaveAttribute("aria-pressed", "false");
    await user.click(segment);
    expect(segment).toHaveAttribute("aria-pressed", "true");
    expect(params().get("status")).toBe("code-changed");
    expect(list().getAllByRole("link")).toHaveLength(3);
    const legend = within(screen.getByRole("list", { name: "Status legend" }));
    const changed = legend.getByRole("button", { name: /Code changed\s*3/i });
    expect(changed).toHaveAttribute("aria-pressed", "true");
    await user.click(changed);
    expect(params().has("status")).toBe(false);
    await user.click(legend.getByRole("button", { name: /Not checked\s*9/i }));
    expect(list().getAllByRole("link")).toHaveLength(9);
    await user.click(screen.getByRole("button", { name: "Clear status filter" }));
    expect(list().getAllByRole("link")).toHaveLength(20);
    expect(params().get("fixture")).toBe("home");
  });

  it("debounces search, matches note text, and preserves the fixture in the URL", async () => {
    const user = renderFixture(landingPath);
    const search = await screen.findByRole("searchbox", { name: "Search knowledge" });
    expect(screen.queryByRole("list", { name: "Items" })).toBeNull();
    await user.type(search, "declined-card");
    expect(params().has("q")).toBe(false);
    await waitFor(() => expect(params().get("q")).toBe("declined-card"));
    expect(list().getAllByRole("link")).toHaveLength(1);
    expect(row("Reproduce a checkout failure with the payment sandbox")).toBeVisible();
    expect(search).toHaveFocus();
    expect(params().get("fixture")).toBe("home");
  });

  it("appends the next fixture page and lets a keyboard user open and close a row from it", async () => {
    const user = renderFixture();
    expect(await screen.findByText("Showing 20 of 40")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(screen.getByText("Showing 40 of 40")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    const link = row("Check the generated navigation in a local preview");
    link.focus();
    await user.keyboard("{Enter}");
    const heading = await screen.findByRole("heading", { level: 2, name: "Check the generated navigation in a local preview" });
    expect(heading).toHaveFocus();
    expect(link).toHaveAttribute("aria-current", "page");
    expect(decodeURIComponent(window.location.pathname)).toBe("/knowledge/docs-site:hint:mx_previewhint");
    await user.click(screen.getByRole("link", { name: "Close item" }));
    expect(link).toHaveFocus();
  });

  it("opens a scoped detail and shows its evidence, checks, use and history", async () => {
    const user = renderFixture("/repos/storefront/knowledge?fixture=home&view=list");
    const heading = await openItem(user, personal);
    const panel = detail(personal);
    expect(heading).toHaveFocus();
    expect(decodeURIComponent(window.location.pathname)).toBe("/repos/storefront/knowledge/storefront:onlyYou:mx_checkout");
    expect(panel.getByText("Applies to").parentElement).toHaveTextContent("Applies to apps/api");
    expect(panel.getByText(/The provider got an invalid address from guest checkout/).tagName).toBe("BLOCKQUOTE");
    expect(panel.getAllByText("Last checked", { exact: false })).toHaveLength(2);
    expect(panel.getByText(/Given to agents 14 times/)).toBeVisible();
    expect(panel.getAllByText(/Checked by model: still true/)).toHaveLength(2);
    await user.click(row("The checkout tax total is calculated on the server"));
    const nextPanel = detail("The checkout tax total is calculated on the server");
    const timeline = nextPanel.getByRole("button", { name: "Show all" });
    const events = document.getElementById(timeline.getAttribute("aria-controls")!)!;
    expect(within(events).getAllByRole("listitem")).toHaveLength(5);
    await user.click(timeline);
    expect(within(events).getAllByRole("listitem")).toHaveLength(7);
  });

  it("saves a personal edit and returns focus to the Edit button", async () => {
    const user = renderFixture();
    await openItem(user, personal);
    await user.click(detail(personal).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "One-line summary" })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: "One-line summary" }), { target: { value: "Validate every checkout request" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Note text" }), { target: { value: "Use the same checkout validator for both cart types." } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    const panel = detail("Validate every checkout request");
    expect(panel.getByText("Use the same checkout validator for both cart types.")).toBeVisible();
    expect(panel.getByText("Saved")).toHaveAttribute("role", "status");
    expect(panel.getByRole("button", { name: "Edit" })).toHaveFocus();
    expect(panel.getByText(/No checks/)).toBeVisible();
  });

  it("reviews and confirms the team file diff for an edit", async () => {
    const user = renderFixture();
    await openItem(user, team);
    expect(detail(team).getByText(/Added by Priya/)).toHaveTextContent("a1b2c3d");
    expect(detail(team).getByText("Applies to").parentElement).toHaveTextContent("apps/api/**, packages/money/**");
    await user.click(detail(team).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note text" }), { target: { value: "Send and store integer cents. Format only at display time." } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alertdialog", { name: "Review changes to team note" });
    const dialog = within(alert);
    expect(dialog.getByText(/This changes the file in/)).toHaveTextContent("/work/storefront");
    const diff = dialog.getByRole("region", { name: "File diff" });
    expect(diff).toHaveTextContent("--- a/.mex/learned/mx_checkout.md");
    expect(diff.querySelector('[data-line="-"]')).toHaveTextContent(/Calculate and store/);
    expect(diff.querySelector('[data-line="+"]')).toHaveTextContent(/Send and store integer cents/);
    await user.click(dialog.getByRole("button", { name: "Confirm" }));
    expect(detail(team).getByText("Send and store integer cents. Format only at display time.")).toBeVisible();
    expect(detail(team).getByText("Saved")).toBeVisible();
    expect(row(personal)).toBeVisible();
  });

  it.each(["Use current", "Keep my edit", "Edit again"] as const)("resolves a stale edit with %s", async (action) => {
    const user = renderFixture("/knowledge?fixture=conflict&view=list");
    await openItem(user, personal);
    await user.click(detail(personal).getByRole("button", { name: "Edit" }));
    const attempt = "Normalize the shipping address before validation.";
    fireEvent.change(screen.getByRole("textbox", { name: "Note text" }), { target: { value: attempt } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = within(await screen.findByRole("dialog", { name: "This item changed since you opened it" }));
    expect(dialog.getByRole("heading", { name: "Current (theirs)" })).toBeVisible();
    expect(dialog.getByRole("heading", { name: "Your edit (mine)" })).toBeVisible();
    expect(dialog.getByText(/against the saved cart/)).toBeVisible();
    expect(dialog.getByText(attempt)).toBeVisible();
    await user.click(dialog.getByRole("button", { name: action }));
    if (action === "Edit again") {
      expect(screen.getByRole("textbox", { name: "Note text" })).toHaveValue(attempt);
      await user.click(screen.getByRole("button", { name: "Save" }));
    }
    if (action === "Use current") expect(detail(personal).getByText(/against the saved cart/)).toBeVisible();
    else expect(detail(personal).getByText(attempt)).toBeVisible();
  });

  it.each([
    { claim: personal, title: "Forget this note?", copy: /file stays on disk/, id: "mx_checkout", audience: "Only you" },
    { claim: team, title: "Forget this team note?", copy: /marks this note as retired/, id: "mx_checkout", audience: "Your team" },
    { claim: hint, title: "Forget this hint?", copy: /own memory is untouched/, id: "mx_hintmenu", audience: "Hint from your agent" },
  ])("forgets $audience items after the correct confirmation", async ({ claim, title, copy, id, audience }) => {
    const user = renderFixture();
    await openItem(user, claim);
    const panel = detail(claim);
    if (claim === hint) {
      expect(panel.getByRole("button", { name: "Edit" })).toBeDisabled();
      expect(panel.getByRole("button", { name: "Edit" })).toHaveAccessibleDescription(/Edit this hint/);
      expect(panel.queryByRole("button", { name: "Share…" })).toBeNull();
    }
    await user.click(panel.getByRole("button", { name: "Forget" }));
    const dialog = within(await screen.findByRole("alertdialog", { name: title }));
    expect(dialog.getByText(copy)).toBeVisible();
    await user.type(dialog.getByRole("textbox", { name: /Reason/ }), "Retired after checking the new behaviour.");
    if (claim === team) {
      await user.click(dialog.getByRole("button", { name: "Review changes" }));
      const review = within(await screen.findByRole("alertdialog", { name: "Review retirement" }));
      expect(review.getByText(/Commit it to share/)).toHaveTextContent(".mex/learned/mx_checkout.md");
      expect(review.getByRole("region", { name: "File diff" })).toHaveTextContent(/status: retired/);
      await user.click(review.getByRole("button", { name: "Confirm" }));
    } else {
      await user.click(dialog.getByRole("button", { name: "Forget" }));
    }
    const link = await screen.findByRole("link", { name: "Forgotten (4)" });
    expect(list().queryByRole("link", { name: new RegExp(`^${claim}`) })).toBeNull();
    await user.click(link);
    const table = await screen.findByRole("table", { name: "Forgotten items" });
    const retired = within(table).getByRole("rowheader", { name: id }).closest("tr");
    expect(retired).toHaveTextContent(audience);
    expect(table).not.toHaveTextContent(claim);
    expect(table).not.toHaveTextContent("Retired after checking");
  });

  it("shows only metadata in the Forgotten view and preserves its repo scope", async () => {
    renderFixture("/repos/storefront/knowledge/forgotten?fixture=home");
    const table = await screen.findByRole("table", { name: "Forgotten items" });
    expect(within(table).getAllByRole("columnheader").map(({ textContent }) => textContent)).toEqual([
      "ID", "Date forgotten", "Repo", "Who sees it",
    ]);
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(table).toHaveTextContent("mx_legacycart");
    expect(table).not.toHaveTextContent("mx_oldtokens");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Knowledge" }))
      .toHaveAttribute("href", "/repos/storefront/knowledge?fixture=home");
  });

  it("shows and copies the Share command for a personal note", async () => {
    const user = renderFixture();
    await openItem(user, personal);
    const share = detail(personal).getByRole("button", { name: "Share…" });
    await user.click(share);
    const dialog = within(await screen.findByRole("dialog", { name: "Share with your team" }));
    expect(dialog.getByText("mex share")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe("mex share");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(share).toHaveFocus());
  });

  it("adds a personal note and selects it with its original text and scope", async () => {
    const user = renderFixture("/knowledge?fixture=home&q=checkout");
    await user.click(await screen.findByRole("button", { name: "Add a note" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Add a note" }));
    const note = dialog.getByRole("textbox", { name: "What should MEX remember?" });
    await waitFor(() => expect(note).toHaveFocus());
    expect(dialog.getByRole("combobox", { name: "Kind" })).toHaveValue("rule");
    expect(dialog.getByPlaceholderText("Whole repo")).toBeVisible();
    expect(dialog.getByText("Only you")).toBeVisible();
    await user.selectOptions(dialog.getByRole("combobox", { name: "Repo" }), "design-kit");
    await user.selectOptions(dialog.getByRole("combobox", { name: "Kind" }), "procedure");
    await user.click(dialog.getByRole("button", { name: "Add pattern" }));
    const scope = dialog.getByRole("textbox", { name: "Scope pattern 1" });
    expect(scope).toHaveFocus();
    fireEvent.change(scope, { target: { value: "packages/ui/**" } });
    fireEvent.change(note, { target: { value: "Review the design tokens\n\n<mark>Keep this as plain text.</mark>" } });
    await user.click(dialog.getByRole("button", { name: "Save note" }));
    const heading = await screen.findByRole("heading", { name: "Review the design tokens" });
    expect(heading).toHaveFocus();
    expect(params().has("q")).toBe(false);
    expect(row("Review the design tokens")).toHaveAttribute("aria-current", "page");
    const panel = detail("Review the design tokens");
    expect(panel.getByText("<mark>Keep this as plain text.</mark>")).toBeVisible();
    expect(panel.getByText("Applies to").parentElement).toHaveTextContent("packages/ui");
  });

  it("shows the empty state, with an Add action and an explanation when there are no repos", async () => {
    const user = renderFixture("/knowledge?fixture=empty");
    const empty = within(await screen.findByRole("region", { name: "Knowledge items" }));
    expect(empty.getByText("Nothing learned yet. Add a note, or let MEX learn from your sessions.")).toBeVisible();
    await user.click(empty.getByRole("button", { name: "Add a note" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Add a note" }));
    expect(dialog.getByRole("button", { name: "Save note" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "Save note" })).toHaveAccessibleDescription("Register a repo before saving a note.");
  });

  it("clears a no-match search and keeps the list visible during an update", async () => {
    const user = renderFixture("/knowledge?fixture=updating&q=zigzag&kind=hint");
    expect(await screen.findByText("No items match these filters.")).toBeVisible();
    expect(screen.getByText("Updating…")).toHaveAttribute("role", "status");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Showing 20 of 40")).toBeVisible();
    expect(params().get("fixture")).toBe("updating");
    expect(params().has("q")).toBe(false);
    expect(params().has("kind")).toBe(false);
  });
});

const repoId = "g-" + "a".repeat(24);
const checkout = "/work/alder";
const knownRepo = {
  id: repoId, name: "Alder", kind: "git", shared: false, provisional: null,
  checkouts: [{ path: checkout, state: "on", offUntil: null, exists: true }],
} satisfies MachineProject;
const time = "2026-11-24T18:00:00.000Z";
const statusCounts = { upToDate: 0, codeChanged: 0, outOfDate: 0, notChecked: 3 };

function item(id: string, oneLine: string, audience: "onlyYou" | "team" = "onlyYou"): KnowledgeDetail {
  return {
    id, key: repoId + ":" + audience + ":" + id, repoId, audience, oneLine, text: oneLine + ".",
    kind: "rule", scope: ["**"], status: "notChecked", revision: "a".repeat(64),
    lastUsedAt: null, useCount30Days: 0, history: [], checks: [],
    ...(audience === "team" ? { checkout, source: { type: "team", path: ".mex/learned/" + id + ".md", checkout } }
      : { source: { type: "note", at: time } }),
  };
}

function livePage(items: KnowledgeDetail[], nextCursor: string | null = null, total = items.length) {
  return Response.json({ items, nextCursor, total, generatedAt: time,
    counts: { status: { ...statusCounts, notChecked: total }, kind: { rule: total }, audience: {} } });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return Response.json({ title: "Try again", status, code, detail: "This request needs attention.", requestId: "test", ...extra }, { status });
}

function renderLive(request: (url: URL, init?: RequestInit) => Response | Promise<Response>, path = "/knowledge?view=list") {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, window.location.origin);
    switch (url.pathname) {
      case "/api/v1/session": return Response.json({ version: __MEX_HUB_VERSION__, csrfToken: "signed", expiresAt: time, mode: "background" });
      case "/api/v1/projects": return Response.json({ projects: [knownRepo] });
      case "/api/v1/home": return Response.json(getFixture("empty").overview);
      case "/api/v1/jobs": return Response.json([]);
      default: return request(url, init);
    }
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  window.history.replaceState(null, "", path);
  render(<QueryClientProvider client={client}><BrowserRouter><MachineHub /></BrowserRouter></QueryClientProvider>);
  return { user: userEvent.setup(), fetch };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("Live Knowledge", () => {
  it("shows loading, reports a read failure, and retries the list", async () => {
    const note = item("mx_first123", "Read from the server");
    let fail!: (response: Response) => void;
    const blocked = new Promise<Response>((resolve) => { fail = resolve; });
    const read = vi.fn().mockReturnValueOnce(blocked).mockImplementation(() => livePage([note]));
    const { user } = renderLive(() => read());
    expect(await screen.findByText("Loading Knowledge…")).toBeVisible();
    fail(problem(500, "INTERNAL_ERROR"));
    expect(await screen.findByText("Couldn’t load Knowledge.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await listLink(note.oneLine)).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("uses the next cursor, appends rows, and focuses the first new one", async () => {
    const first = item("mx_first123", "First result");
    const second = item("mx_second123", "Second result");
    const read = vi.fn((url: URL) => url.searchParams.has("cursor") ? livePage([second], null, 2) : livePage([first], "after-first", 2));
    const { user } = renderLive(read);
    await listLink(first.oneLine);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await listLink(second.oneLine)).toHaveFocus();
    expect(row(first.oneLine)).toBeVisible();
    expect(screen.getByText("Showing 2 of 2")).toBeVisible();
    expect(read.mock.calls.map(([url]) => url.searchParams.get("cursor"))).toEqual([null, "after-first"]);
  });

  it("starts at page one when a newer snapshot invalidates the cursor", async () => {
    const first = item("mx_first123", "Old first result");
    const latest = item("mx_latest123", "New first result");
    let changed = false;
    const read = vi.fn((url: URL) => {
      if (url.searchParams.has("cursor")) { changed = true; return problem(409, "KNOWLEDGE_CHANGED"); }
      return changed ? livePage([latest]) : livePage([first], "old-generation", 2);
    });
    const { user } = renderLive(read);
    await listLink(first.oneLine);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await listLink(latest.oneLine)).toBeVisible();
    expect(list().queryByRole("link", { name: /Old first result/ })).toBeNull();
    expect(read.mock.calls.map(([url]) => url.searchParams.get("cursor"))).toEqual([null, "old-generation", null]);
  });

  it("shows a conflict returned by the server and can keep the file’s current text", async () => {
    const original = item("mx_first123", "Opened rule");
    const latest = { ...original, oneLine: "Terminal rule", text: "A newer version written in the terminal.", revision: "b".repeat(64) };
    let current = original;
    const { user } = renderLive((url, init) => {
      if (init?.method === "POST") {
        current = latest;
        return problem(409, "REVISION_CONFLICT", { current, attempted: JSON.parse(String(init.body)) });
      }
      return url.pathname.includes("/items/") ? Response.json(current) : livePage([current]);
    });
    await openItem(user, original.oneLine);
    await user.click(detail(original.oneLine).getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByRole("textbox", { name: "Note text" }));
    await user.type(screen.getByRole("textbox", { name: "Note text" }), "My browser edit.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "This item changed since you opened it" });
    expect(within(dialog).getByText(latest.text)).toBeVisible();
    expect(within(dialog).getByText("My browser edit.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Use current" }));
    expect(await screen.findByText(latest.text)).toBeVisible();
  });

  it("posts a team edit preview, shows the diff, then sends its revision on confirm", async () => {
    const original = item("mx_shared123", "A team rule", "team");
    const diff = "-Original text\n+Reviewed text";
    const revision = "c".repeat(64);
    let saved = original;
    const writes: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const { user } = renderLive((url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        writes.push({ body, headers: new Headers(init.headers) });
        if (!body.apply) return Response.json({ preview: { diff, checkout, path: ".mex/learned/mx_shared123.md", revision } });
        saved = { ...original, text: body.text, revision };
        return Response.json(saved);
      }
      return url.pathname.includes("/items/") ? Response.json(saved) : livePage([saved]);
    });
    await openItem(user, original.oneLine);
    await user.click(detail(original.oneLine).getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByRole("textbox", { name: "Note text" }));
    await user.type(screen.getByRole("textbox", { name: "Note text" }), "Reviewed text");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const preview = await screen.findByRole("alertdialog", { name: "Review changes to team note" });
    expect(within(preview).getByRole("region", { name: "File diff" })).toHaveTextContent("+Reviewed text");
    expect(writes[0].body).toMatchObject({ text: "Reviewed text", expectedRevision: original.revision, checkout });
    expect(writes[0].body).not.toHaveProperty("apply");
    await user.click(within(preview).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Saved")).toBeVisible();
    expect(writes[1].body).toMatchObject({ apply: true, previewRevision: revision, checkout });
    expect(writes[0].headers.get("x-mex-csrf")).toBe("signed");
    expect(writes[0].headers.get("idempotency-key")).not.toBe(writes[1].headers.get("idempotency-key"));
  });

  it("announces a busy retry, reuses the key, and reports a second busy failure", async () => {
    const note = item("mx_first123", "Locked note");
    const requests: Headers[] = [];
    const { user } = renderLive((url, init) => {
      if (init?.method === "POST") {
        requests.push(new Headers(init.headers));
        return problem(503, "MEX_BUSY", { detail: "MEX is busy. Try again in a moment." });
      }
      return url.pathname.includes("/items/") ? Response.json(note) : livePage([note]);
    });
    await openItem(user, note.oneLine);
    await user.click(detail(note.oneLine).getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("MEX is busy, retrying…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(requests).toHaveLength(1);
    expect(await screen.findByText("Couldn't save. Try again.", {}, { timeout: 2_000 })).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[0].get("idempotency-key")).toMatch(/^[\da-f-]{36}$/u);
    expect(requests[1].get("idempotency-key")).toBe(requests[0].get("idempotency-key"));
  });
});

const listLink = (claim: string) => screen.findByRole("link", { name: new RegExp("^" + claim) });
