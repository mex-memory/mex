import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { diagramFixture } from "../dev/diagram-fixtures";
import { StatechartCanvas } from "./StatechartCanvas";

describe("Statechart canvas", () => {
  it("lets keyboard users select states and transitions by their artifact identities", async () => {
    const onSelect = vi.fn(), user = userEvent.setup();
    render(<StatechartCanvas artifact={diagramFixture.artifact} highlighted={[]} onSelect={onSelect} />);
    const canvas = screen.getByRole("region", { name: "State diagram" });
    const ready = within(canvas).getByRole("button", { name: "Ready · initial state" });
    ready.focus(); await user.keyboard("{Enter}"); expect(onSelect).toHaveBeenLastCalledWith("ready");
    const event = within(canvas).getByRole("button", { name: "Start work · Ready → Working" });
    event.focus(); await user.keyboard("{Enter}"); expect(onSelect).toHaveBeenLastCalledWith("start");
  });
  it("keeps node positions fixed while adding recorded path numbering and selection", () => {
    const artifact = diagramFixture.artifact, onSelect = vi.fn();
    const { rerender } = render(<StatechartCanvas artifact={artifact} highlighted={[]} onSelect={onSelect} />);
    const before = screen.getByRole("button", { name: "Working" }).getAttribute("transform");
    rerender(<StatechartCanvas artifact={artifact} highlighted={["ready", "running", "done"]} selected="running" steps={artifact.traces[0]!.steps} onSelect={onSelect} />);
    const working = screen.getByRole("button", { name: "2. Working" });
    expect(working).toHaveAttribute("aria-pressed", "true");
    expect(working).toHaveAttribute("transform", before);
    expect(screen.getByRole("button", { name: "Start work · Ready → Working" })).toHaveTextContent(/2\. Start work/);
    expect(working.closest("[aria-label='State diagram']")!.querySelector("style")).toBeNull();
  });
  it("does not paint expected goal witnesses as rule violations", () => {
    const artifact = structuredClone(diagramFixture.artifact);
    artifact.traces[0]!.kind = "goal"; artifact.check.results[0]!.outcome = "goal-reached";
    render(<StatechartCanvas artifact={artifact} highlighted={[]} onSelect={() => {}} />);
    expect(screen.queryByText("Rule violation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete" })).not.toHaveAttribute("data-violation");
  });
});
