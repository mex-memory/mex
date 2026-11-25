import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MachineSettingsSchema, MachineUninstallPreviewSchema } from "@mex/hub-contracts/machine";
import { BrowserRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFixture } from "./fixtures";
import { MachineHub } from "./MachineHub";

async function openSettings(path = "/settings?fixture=home") {
  // jsdom 25 lacks the PointerEvent Base UI uses to forward a switch click.
  if (!window.PointerEvent) vi.stubGlobal("PointerEvent", MouseEvent);
  window.history.replaceState(null, "", path);
  const user = userEvent.setup();
  render(<BrowserRouter><MachineHub /></BrowserRouter>);
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  return user;
}

afterEach(() => vi.unstubAllGlobals());

const section = (name: string) => within(screen.getByRole("region", { name }));
const toggle = (name: string) => screen.getByRole("switch", { name });
const saved = () => {
  const mark = screen.getByText("Saved", { exact: true });
  expect(mark).toBeVisible();
  expect(mark.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
  return mark;
};

describe("Settings fixtures", () => {
  it("updates everywhere and persists the preference through navigation", async () => {
    const user = await openSettings();
    const everywhere = toggle("MEX everywhere");
    expect(everywhere).toBeChecked();
    await user.click(everywhere);
    expect(everywhere).not.toBeChecked();
    expect(section("MEX on or off").getByText("Shared rule files may still be loaded by your agent.")).toBeVisible();
    saved();

    const primary = within(screen.getByRole("navigation", { name: "Primary" }));
    await user.click(primary.getByRole("link", { name: "Agents" }));
    await screen.findByRole("heading", { level: 1, name: "Agents" });
    await user.click(primary.getByRole("link", { name: "Settings" }));
    expect(await screen.findByRole("switch", { name: "MEX everywhere" })).not.toBeChecked();
  });

  it("writes permanent and temporary states for one checkout at a time", async () => {
    const user = await openSettings();
    const power = section("MEX on or off");
    const target = power.getByRole("combobox", { name: "MEX for /work/storefront" });
    const other = power.getByRole("combobox", { name: "MEX for /work/design-kit" });
    const missing = power.getByRole("combobox", { name: "MEX for /work/docs-site" });
    expect(missing).toBeDisabled();
    expect(missing).toHaveAccessibleDescription(/This checkout is missing from disk/);
    expect(within(target).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "On", "Off", "Off for 1 hour", "Off for 1 day", "Off until…",
    ]);

    await user.selectOptions(target, "off");
    expect(target).toHaveValue("off");
    expect(other).toHaveValue("on");
    saved();

    for (const [option, hours] of [["hour", 1], ["day", 24]] as const) {
      const before = Date.now();
      await user.selectOptions(target, option);
      expect(target).toHaveValue("offUntil");
      saved();
      const description = document.getElementById(target.getAttribute("aria-describedby")!);
      const until = Date.parse(description!.querySelector("time")!.dateTime);
      expect(until).toBeGreaterThanOrEqual(before + hours * 3_600_000);
      expect(until).toBeLessThanOrEqual(Date.now() + hours * 3_600_000);
    }
    await user.selectOptions(target, "on");
    expect(target).toHaveValue("on");
    saved();
  });

  it("uses a local date and time for a custom checkout deadline", async () => {
    const user = await openSettings();
    const select = screen.getByRole("combobox", { name: "MEX for /work/design-kit" });
    await user.selectOptions(select, "custom");
    const dialog = within(await screen.findByRole("dialog", { name: "Turn MEX off until…" }));
    const date = dialog.getByLabelText("Date and time (local)");
    const future = new Date(Date.now() + 3 * 86_400_000);
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    fireEvent.change(date, { target: { value: local } });
    await user.click(dialog.getByRole("button", { name: "Set time" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(select).toHaveValue("offUntil");
    expect(select).toHaveAccessibleDescription(/Off until/);
    saved();
  });

  it("writes global capture, repo capture, sharing and telemetry independently", async () => {
    const user = await openSettings();
    const globalCapture = toggle("Capture everywhere");
    const designCapture = toggle("Capture for Design kit");
    expect(designCapture).not.toBeChecked();
    await user.click(designCapture);
    expect(designCapture).toBeChecked();
    saved();
    await user.click(globalCapture);
    expect(globalCapture).not.toBeChecked();
    expect(designCapture).toBeChecked();
    expect(section("MEX on or off").getByText("Delivery has its own off switches.")).toBeVisible();
    saved();

    const sharing = within(screen.getByRole("radiogroup", { name: "Sharing for Storefront" }));
    expect(sharing.getByRole("radio", { name: "Automatic" })).toBeChecked();
    await user.click(sharing.getByRole("radio", { name: "Manual" }));
    expect(sharing.getByRole("radio", { name: "Manual" })).toBeChecked();
    expect(section("Sharing").getAllByText(/Learned notes stay personal until/)).toHaveLength(3);
    saved();

    const telemetry = toggle("Telemetry");
    await user.click(telemetry);
    expect(telemetry).not.toBeChecked();
    saved();
  });

  it("requires confirmation for all browser sessions", async () => {
    const user = await openSettings();
    const trigger = section("This browser").getByRole("button", { name: "Sign out everywhere" });
    await user.click(trigger);
    const confirmation = within(await screen.findByRole("alertdialog", { name: "Sign out everywhere?" }));
    expect(confirmation.getByText(/Every browser signed in to this Hub is signed out and unused links stop working/)).toHaveTextContent("mex hub");
    await user.click(confirmation.getByRole("button", { name: "Cancel" }));
    expect(trigger).toBeVisible();
    await user.click(trigger);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Sign out everywhere" }));
    expect(await screen.findByText(/Signed out everywhere\./)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Open the Hub from the terminal" })).toBeVisible();
    expect(screen.getByText("Saved")).toBeVisible();
  });

  it("signs out the current browser immediately", async () => {
    const user = await openSettings();
    await user.click(section("This browser").getByRole("button", { name: "Sign out of this browser" }));
    expect(await screen.findByText(/Signed out of this browser\./)).toBeVisible();
    expect(screen.getByText("Saved")).toBeVisible();
  });

  it("explains why telemetry is forced off and expands both outbound tables", async () => {
    const user = await openSettings("/settings?fixture=settings-forced-off");
    const telemetry = toggle("Telemetry");
    expect(telemetry).toHaveAttribute("aria-disabled", "true");
    expect(telemetry).not.toBeChecked();
    expect(telemetry).toHaveAccessibleDescription("Off because DO_NOT_TRACK is set");
    const privacy = section("Privacy");
    expect(privacy.getByText("The Hub itself sends nothing.")).toBeVisible();
    const reports = within(privacy.getByRole("table", { name: "Recent telemetry reports" }));
    const calls = within(privacy.getByRole("table", { name: "Recent model calls" }));
    expect(reports.getByText(/project_id/)).toBeVisible();
    expect(calls.getByText("2,940")).toBeVisible();
    expect(reports.getAllByRole("row")).toHaveLength(4);
    await user.click(privacy.getByRole("button", { name: "Show more" }));
    expect(reports.getAllByRole("row")).toHaveLength(6);
    expect(calls.getAllByRole("row")).toHaveLength(5);
    expect(telemetry).not.toBeChecked();
  });

  it("shows the storage footprint, retention, and the other read-only settings", async () => {
    const { settings } = getFixture("home").settings;
    expect(MachineSettingsSchema.parse(settings).storage.totalBytes).toBe(1_200_000_000);
    await openSettings();
    const storage = section("Storage");
    for (const size of ["1.2 GB", "92 MB", "244 MB", "805 MB", "57 MB", "2 MB", "462 MB", "238 MB", "105 MB"]) {
      expect(storage.getByText(size, { exact: true })).toBeVisible();
    }
    expect(storage.getByText("Delivery history is kept for 30 days. Capture keeps 90 days or 200 MB.")).toBeVisible();
    expect(storage.queryByRole("button", { name: /compact/i })).not.toBeInTheDocument();
    expect(section("AI use").getByRole("img", { name: /1\.2%.*Cap 3%/ })).toBeVisible();
    expect(section("AI use").getByText("mex learn --no-weekly")).toBeVisible();
    expect(section("Hints from your agent").getByText("6 months")).toBeVisible();
    expect(section("About").getByRole("button", { name: "Copy path /Users/sam/.mex" })).toBeVisible();
  });

  it("lists each uninstall change, its three values and every retained path", async () => {
    const data = MachineUninstallPreviewSchema.parse(getFixture("home").settings.uninstall);
    const user = await openSettings();
    await user.click(section("Uninstall").getByRole("button", { name: "Preview uninstall" }));
    const preview = within(await screen.findByRole("dialog", { name: "Uninstall preview" }));
    expect(preview.getAllByText("Before MEX", { exact: true })).toHaveLength(12);
    expect(preview.getAllByText("MEX’s value", { exact: true })).toHaveLength(12);
    expect(preview.getAllByText("Uninstall restores", { exact: true })).toHaveLength(12);
    for (const change of data.changes) {
      const group = within(preview.getByRole("region", { name: change.group }));
      const matched = group.getAllByRole("listitem").find((item) => item.textContent?.includes(change.path) && item.textContent.includes(change.entry));
      expect(matched).toBeDefined();
      expect(matched).toHaveTextContent(change.before ?? "Not present");
      expect(matched).toHaveTextContent(change.mexValue.replaceAll("\n", " "));
      expect(matched).toHaveTextContent(change.restores ?? "Not present");
    }

    const retained = within(preview.getByRole("complementary"));
    expect(retained.getByRole("heading", { name: "Not removed by uninstall" })).toBeVisible();
    for (const { path } of data.notRemoved) expect(retained.getByText(path, { exact: true })).toBeVisible();
    expect(retained.getByText(/Your data stays in/)).toHaveTextContent("~/.mex (1.2 GB)");
    expect(preview.getByText("mex uninstall", { exact: true })).toBeVisible();
    expect(preview.queryByRole("button", { name: /^Uninstall$/ })).not.toBeInTheDocument();
  });

  it("links to each section and focuses the chosen heading", async () => {
    const user = await openSettings();
    const rail = within(screen.getByRole("navigation", { name: "Settings sections" }));
    expect(rail.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(
      ["browser", "power", "sharing", "ai-use", "privacy", "hints", "storage", "uninstall", "about"].map((id) => "/settings?fixture=home#" + id),
    );
    const privacy = rail.getByRole("link", { name: "Privacy" });
    await user.click(privacy);
    expect(window.location.hash).toBe("#privacy");
    expect(privacy).toHaveAttribute("aria-current", "location");
    expect(section("Privacy").getByRole("heading", { name: "Privacy" })).toHaveFocus();
  });
});
