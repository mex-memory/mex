import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { diagramFixture } from "../dev/diagram-fixtures";
import { AppRoutes } from "./App";
vi.mock("../components/StatechartCanvas", () => ({ StatechartCanvas: () => <div aria-label="State diagram">Diagram canvas</div> }));
function show(route: string, error = false) {
  const api = createFixtureApi(); if (error) api.getDiagram = async () => { throw new Error("Expired"); };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><HubApiProvider api={api}><MemoryRouter initialEntries={[route]}><AppRoutes /></MemoryRouter></HubApiProvider></QueryClientProvider>);
}
describe("Diagrams reader", () => {
  it("separates temporary previews from saved snapshots", async () => { show("/diagrams"); expect(await screen.findByRole("heading", { name: /Temporary previews/ })).toBeVisible(); expect(screen.getByRole("heading", { name: /Saved snapshots/ })).toBeVisible(); expect(await screen.findByRole("link", { name: /A bounded job/ })).toHaveAttribute("href", `/diagrams/preview/${diagramFixture.id}`); });
  it("preserves incomplete statuses, numbered paths and exact save review", async () => {
    const user = userEvent.setup(); show(`/diagrams/preview/${diagramFixture.id}`);
    await screen.findByRole("heading", { name: "A bounded job" }); expect(screen.getByText("incomplete", { exact: true })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Recorded path", { exact: true }), "path1");
    const paths = screen.getByLabelText("Recorded path", { exact: true }).parentElement!.parentElement!;
    expect(within(paths).getAllByRole("listitem").map(x => x.textContent)).toEqual(["Ready", "Working — Start work", "Complete — Finish work"]);
    await user.click(within(screen.getByRole("region", { name: "Accessible behavior lists" })).getByRole("button", { name: "Start work" }));
    expect(within(screen.getByRole("complementary", { name: "Diagram details" })).getByText("A request is ready")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Review Save" })); const dialog = await screen.findByRole("dialog"); expect(within(dialog).getByText(/Saving does not stage/)).toBeVisible(); expect(within(dialog).getByText(/record.md/)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Save snapshot" })); expect(await screen.findByText("Saved snapshot · working tree")).toBeVisible();
  });
  it("shows unavailable or expired preview recovery", async () => { show(`/diagrams/preview/${diagramFixture.id}`, true); expect(await screen.findByText(/Temporary previews may have expired/)).toBeVisible(); });
});
