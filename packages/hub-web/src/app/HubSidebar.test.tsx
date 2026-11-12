import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { CapabilitiesResponse, HomeResponse, HubActor } from "../api/types";
import { createFixtureApi } from "../dev/fixture-api";
import { HubSidebar } from "./HubSidebar";

async function fixtureData(): Promise<{
  capabilities: CapabilitiesResponse;
  home: HomeResponse;
}> {
  const api = createFixtureApi();
  return {
    capabilities: await api.getCapabilities(),
    home: await api.getHome(),
  };
}

function renderSidebar({
  capabilities,
  home,
  route = "/",
}: {
  capabilities?: CapabilitiesResponse;
  home?: HomeResponse;
  route?: string;
}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <HubSidebar capabilities={capabilities} home={home} />
    </MemoryRouter>,
  );
}

function homeWithCounts(home: HomeResponse, count: number): HomeResponse {
  return {
    ...home,
    jobs: { availability: "available", activeCount: count },
    attention: {
      inbox: { availability: "available", teamReviewCount: count },
      relays: { availability: "available", readyToTakeCount: count, inYourHandsCount: 0 },
    },
  };
}

describe("HubSidebar dynamic state", () => {
  it.each([0, 1, 42, 100])("renders honest count badges for %i", async (count) => {
    const { capabilities, home } = await fixtureData();
    renderSidebar({ capabilities, home: homeWithCounts(home, count) });

    expect(screen.queryByRole("link", { name: /^Inbox/u })).not.toBeInTheDocument();
    const relays = screen.getByRole("link", { name: /^Relays/u });
    const system = screen.getByRole("button", { name: /^System/u });
    const cases = [
      [relays, `${count} open Relays for you.`],
      [system, `${count} active system operations.`],
    ] as const;

    for (const [container, label] of cases) {
      if (count === 0) {
        expect(within(container).queryByLabelText(label)).not.toBeInTheDocument();
      } else {
        const badge = within(container).getByLabelText(label);
        expect(badge).toHaveTextContent(count > 99 ? "99+" : String(count));
      }
    }
  });

  it("omits counts while Home is absent or its count scope is unavailable", async () => {
    const { capabilities, home } = await fixtureData();
    const first = renderSidebar({ capabilities });

    expect(screen.queryByRole("link", { name: /^Inbox/u })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Relays" })).toBeVisible();
    expect(screen.getByRole("button", { name: "System" })).toBeVisible();
    expect(screen.getByText("Set team identity")).toBeVisible();

    first.unmount();
    renderSidebar({
      capabilities,
      home: {
        ...home,
        attention: {
          inbox: { availability: "unavailable", reason: "Count unavailable." },
          relays: { availability: "unavailable", reason: "Count unavailable." },
        },
      },
    });

    expect(screen.queryByRole("link", { name: /^Inbox/u })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Relays" })).toBeVisible();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it("lets capability unavailability win over counts and exposes its reason as a tooltip", async () => {
    const user = userEvent.setup();
    const { capabilities, home } = await fixtureData();
    const reason = "Relay reads are disconnected.";
    renderSidebar({
      capabilities: {
        ...capabilities,
        relays: {
          ...capabilities.relays,
          read: { availability: "unavailable", reason },
        },
        jobs: { availability: "unavailable", reason: "Job reads are disconnected." },
      },
      home: homeWithCounts(home, 9),
    });

    const relays = screen.getByRole("link", { name: "Relays Unavailable" });
    expect(relays).toHaveAttribute("href", "/relays");
    expect(relays).toHaveAccessibleDescription(reason);
    expect(within(relays).getByText("Unavailable")).toBeVisible();
    expect(within(relays).queryByLabelText("9 open Relays for you.")).not.toBeInTheDocument();
    relays.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Relays Unavailable" })).toHaveAttribute("href", "/relays");
    const system = screen.getByRole("button", { name: "System" });
    expect(within(system).queryByLabelText("9 active system operations.")).not.toBeInTheDocument();
    await user.click(system);
    expect(screen.getByRole("link", { name: "Jobs Unavailable" })).toHaveAttribute("href", "/jobs");

  });

  it.each([
    [{ kind: "member", memberId: "member_ada", displayName: "Ada Lovelace" }, "Ada Lovelace"],
    [{ kind: "git", name: "Grace Hopper", email: "grace@example.com" }, "Using Git: Grace Hopper"],
    [{ kind: "git", name: null, email: "git@example.com" }, "Using Git: git@example.com"],
    [{ kind: "unknown" }, "Set team identity"],
  ] as const)("projects the Home actor as %s", async (actor, expected) => {
    const { capabilities, home } = await fixtureData();
    renderSidebar({ capabilities, home: { ...home, actor: actor as HubActor } });
    expect(screen.getByText(expected)).toBeVisible();
  });

  it("states local and shared ownership precisely", async () => {
    const user = userEvent.setup();
    const { capabilities, home } = await fixtureData();
    renderSidebar({ capabilities, home });

    expect(screen.queryByText("Local")).not.toBeInTheDocument();
    const locality = screen.getByRole("note", { name: "Runs locally. Shared records use Git." });
    expect(locality).toHaveAccessibleDescription(
      "MEX runs on this device. Canonical team records are shared when committed and pushed; drafts and indexes remain local to this checkout.",
    );
    expect(screen.getByText("Shared records use Git")).toBeVisible();
    locality.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Canonical team records are shared");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
