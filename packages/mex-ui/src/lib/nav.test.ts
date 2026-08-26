import { describe, it, expect } from "vitest";
import { NAV_ITEMS, ROUTES, activeNav, isSetupWizard } from "./nav";

describe("NAV_ITEMS", () => {
  it("lists companion views in the order the sidebar renders them", () => {
    expect(NAV_ITEMS.map((item) => item.id)).toEqual([
      "dashboard",
      "setup",
      "health",
      "graph",
      "activity",
      "settings",
    ]);
  });
});

describe("activeNav", () => {
  it("treats the home path as Dashboard", () => {
    expect(activeNav(ROUTES.home)).toBe("dashboard");
  });

  it("keeps the wizard on the Setup item", () => {
    expect(activeNav(ROUTES.setup)).toBe("setup");
    expect(activeNav(ROUTES.setupWizard)).toBe("setup");
  });

  it("matches each dedicated view exactly", () => {
    expect(activeNav(ROUTES.health)).toBe("health");
    expect(activeNav(ROUTES.graph)).toBe("graph");
    expect(activeNav(ROUTES.activity)).toBe("activity");
    expect(activeNav(ROUTES.settings)).toBe("settings");
  });

  it("falls unknown paths back to Dashboard so a bad URL still has a home", () => {
    expect(activeNav("/not-a-view")).toBe("dashboard");
  });
});

describe("isSetupWizard", () => {
  it("is true only for the wizard path", () => {
    expect(isSetupWizard(ROUTES.setupWizard)).toBe(true);
    expect(isSetupWizard(ROUTES.setup)).toBe(false);
  });
});
