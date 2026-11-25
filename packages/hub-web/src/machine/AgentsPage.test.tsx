import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MachineAgentRepairPreviewSchema, MachineAgentSchema } from "@mex/hub-contracts/machine";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { getFixture } from "./fixtures";
import { MachineHub } from "./MachineHub";

async function openAgents(path = "/agents?fixture=home", heading = "Agents") {
  window.history.replaceState(null, "", path);
  const user = userEvent.setup();
  render(<BrowserRouter><MachineHub /></BrowserRouter>);
  await screen.findByRole("heading", { level: 1, name: heading });
  return user;
}

const card = (name: string) => within(screen.getByRole("article", { name }));
const nav = () => within(screen.getByRole("navigation", { name: "Primary" }));

describe("Agents fixtures", () => {
  it("shows the four installed integrations' states with status icons", async () => {
    const { agents, repairPreviews } = getFixture("agents-broken").agents;
    expect(MachineAgentSchema.array().parse(agents).map(({ name }) => name)).toEqual(["Claude Code", "Codex", "Copilot CLI", "OpenCode"]);
    expect(MachineAgentRepairPreviewSchema.array().parse(Object.values(repairPreviews))).toHaveLength(3);
    await openAgents("/agents?fixture=agents-broken");

    for (const [name, state] of [
      ["Claude Code", "Needs repair"], ["Codex", "Needs approval"], ["Copilot CLI", "Not set up"], ["OpenCode", "Not found"],
    ]) {
      expect(card(name).getByText(state, { exact: true }).querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
    expect(card("Claude Code").getByText("Missing 2 of 12")).toBeVisible();
    expect(card("Copilot CLI").getByText("Can’t verify for this agent yet")).toBeVisible();
    expect(card("Claude Code").getByRole("button", { name: "48 min ago" })).toHaveAccessibleDescription(/\d/);
    expect(card("OpenCode").queryByRole("button", { name: "Repair" })).not.toBeInTheDocument();
    expect(card("OpenCode").queryByText(/Missing/)).not.toBeInTheDocument();
    expect(nav().getByRole("link", { name: "Agents" })).toHaveAccessibleDescription("Some agents need attention");
  });

  it("reviews the missing entries, repairs them, and updates the card and detail", async () => {
    const user = await openAgents("/agents?fixture=agents-broken");
    const claude = card("Claude Code");
    await user.click(claude.getByRole("button", { name: "Repair" }));
    const confirm = within(await screen.findByRole("alertdialog", { name: "Repair Claude Code" }));
    expect(confirm.getByText("MEX only changes its own hook entries. Cost: free.")).toBeVisible();
    const diff = confirm.getByRole("region", { name: "Diff for ~/.claude/settings.json" });
    expect(diff).toHaveTextContent("PreToolUse");
    expect(diff).toHaveTextContent("PostToolUse");
    expect(claude.getByText("Needs repair")).toBeInTheDocument();

    await user.click(confirm.getByRole("button", { name: "Confirm" }));
    expect(confirm.getByText("Repairing…")).toBeVisible();
    expect(confirm.getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(await screen.findByText("Claude Code is working again")).toBeVisible();
    expect(claude.getByText("Working", { exact: true }).querySelector("svg")).not.toBeNull();
    expect(claude.queryByRole("button", { name: "Repair" })).not.toBeInTheDocument();

    const details = claude.getByRole("link", { name: "Details for Claude Code" });
    await user.click(details);
    expect(window.location.search).toBe("?fixture=agents-broken");
    const hooks = within(screen.getByRole("region", { name: "Hooks" }));
    expect(hooks.getByText("12 of 12 installed")).toBeVisible();
    expect(hooks.getAllByText("Installed", { exact: true })).toHaveLength(12);
    expect(within(screen.getByRole("region", { name: "Recent errors" })).getByText("Hook timed out")).toBeVisible();
  });

  it("sends a shell-dependent repair to the actual installer command", async () => {
    const user = await openAgents("/agents?fixture=agents-terminal");
    const codex = card("Codex");
    await user.click(codex.getByRole("button", { name: "Repair" }));
    const terminal = within(await screen.findByRole("dialog", { name: "Repair Codex from your terminal" }));
    expect(terminal.getByText(/can’t read the Codex configuration/)).toBeVisible();
    expect(terminal.getByText("mex install")).toBeVisible();
    expect(terminal.getByRole("button", { name: "Copy command" })).toBeVisible();
    expect(terminal.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
    await user.click(terminal.getByRole("button", { name: "Close" }));
    expect(codex.getByText("Needs repair")).toBeVisible();
  });

  it("shows the Codex approval instructions without a Hub action", async () => {
    const user = await openAgents();
    const codex = card("Codex");
    expect(codex.getByText("Installed")).toBeVisible();
    expect(codex.getByText("Needs approval", { exact: true })).toBeVisible();
    expect(codex.getByText(/Needs your approval in Codex/)).toHaveTextContent("/hooks");
    expect(codex.queryByRole("button", { name: "Repair" })).not.toBeInTheDocument();
    await user.click(codex.getByRole("link", { name: "Details for Codex" }));
    expect(screen.getByRole("heading", { name: "Needs your approval in Codex" })).toBeVisible();
    expect(screen.getByText("Review hooks")).toBeVisible();
    expect(screen.queryByRole("button", { name: /approve|trust|repair/i })).not.toBeInTheDocument();
  });

  it("groups written files and copies the chosen path", async () => {
    const user = await openAgents("/agents/claude-code?fixture=home", "Claude Code");
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    const files = within(screen.getByRole("region", { name: "Files MEX wrote" }));
    expect(files.getByRole("heading", { name: "On this machine" })).toBeVisible();
    expect(files.getByRole("heading", { name: "In Storefront" })).toBeVisible();
    expect(files.getByText("Hook config")).toBeVisible();
    expect(files.getByText("Git exclude entry")).toBeVisible();
    expect(files.getByText("Hidden from git")).toBeVisible();
    const path = "/work/storefront/.claude/rules/mex-local.md";
    await user.click(files.getByRole("button", { name: "Copy path " + path }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(path));
    expect(files.getByText("Copied", { exact: true })).toBeInTheDocument();
  });
});
