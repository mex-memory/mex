import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineHub } from "./MachineHub";

const personal = "Validate checkout inputs at the API boundary";
const team = "Keep the checkout total in integer cents";
const hint = "Try the compact menu story when checking keyboard focus";

function renderFixture(path = "/knowledge?fixture=home") {
  window.history.replaceState(null, "", path);
  render(<BrowserRouter><MachineHub /></BrowserRouter>);
  return userEvent.setup();
}

const params = () => new URLSearchParams(window.location.search);
const list = () => within(screen.getByRole("list", { name: "Items" }));
const row = (claim: string) => list().getByRole("link", { name: new RegExp(`^${claim}`) });
const detail = (claim: string) => within(screen.getByRole("region", { name: claim }));

afterEach(() => vi.unstubAllGlobals());

async function openItem(user: ReturnType<typeof userEvent.setup>, claim: string) {
  await screen.findByRole("list", { name: "Items" });
  await user.click(row(claim));
  return await screen.findByRole("heading", { level: 2, name: claim });
}

describe("Knowledge fixtures", () => {
  it("reads every filter from the URL and applies keyboard menu selections to it", async () => {
    // Base UI dispatches a pointer click when a menu item is chosen with Enter.
    if (!window.PointerEvent) vi.stubGlobal("PointerEvent", window.MouseEvent);
    const user = renderFixture("/knowledge?fixture=home&kind=rule&audience=team&status=code-changed&repo=design-kit&q=focus");
    await screen.findByRole("list", { name: "Items" });
    expect(list().getAllByRole("link")).toHaveLength(1);
    expect(row("Keep the keyboard focus ring on menu items")).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search knowledge" })).toHaveValue("focus");
    expect(screen.getByRole("button", { name: "Who sees it: Your team" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Status: Code changed" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Repo: Design kit" })).toBeVisible();

    const kind = screen.getByRole("button", { name: "Kind: Rule" });
    kind.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitemradio", { name: "Rule" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Home}{Enter}");
    expect(params().has("kind")).toBe(false);
    expect(params().get("audience")).toBe("team");
    expect(params().get("q")).toBe("focus");
    await waitFor(() => expect(screen.getByRole("button", { name: "Kind" })).toHaveFocus());
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
    expect(screen.queryByRole("button", { name: "Repo" })).toBeNull();
  });

  it("toggles status filtering from the bar and legend and clears it", async () => {
    const user = renderFixture();
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
    const user = renderFixture();
    const search = await screen.findByRole("searchbox", { name: "Search knowledge" });
    await user.type(search, "declined-card");
    expect(params().has("q")).toBe(false);
    await waitFor(() => expect(params().get("q")).toBe("declined-card"));
    expect(list().getAllByRole("link")).toHaveLength(1);
    expect(row("Reproduce a checkout failure with the payment sandbox")).toBeVisible();
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
    const user = renderFixture("/repos/storefront/knowledge?fixture=home");
    const heading = await openItem(user, personal);
    const panel = detail(personal);
    expect(heading).toHaveFocus();
    expect(decodeURIComponent(window.location.pathname)).toBe("/repos/storefront/knowledge/storefront:personal:mx_checkout");
    expect(panel.getByText("Applies to").parentElement).toHaveTextContent("Applies to apps/api");
    expect(panel.getByText(/The guest flow was sending malformed address data/).tagName).toBe("BLOCKQUOTE");
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
    const user = renderFixture("/knowledge?fixture=conflict");
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
