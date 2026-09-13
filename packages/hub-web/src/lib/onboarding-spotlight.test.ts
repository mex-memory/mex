import { afterEach, describe, expect, it, vi } from "vitest";
import { boxesForTargets, placeCallout, unionBoxes } from "./onboarding-spotlight";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function renderTarget(id: string, box: Pick<DOMRect, "top" | "left" | "width" | "height">) {
  const node = document.createElement("div");
  node.dataset.onboarding = id;
  document.body.append(node);
  vi.spyOn(node, "getBoundingClientRect").mockReturnValue({
    x: box.left,
    y: box.top,
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON() { return this; },
  });
  return node;
}

describe("onboarding spotlight geometry", () => {
  it("unions visible onboarding targets and ignores empty ones", () => {
    renderTarget("search", { top: 20, left: 10, width: 80, height: 24 });
    renderTarget("group-system", { top: 80, left: 10, width: 100, height: 40 });
    renderTarget("empty", { top: 0, left: 0, width: 0, height: 0 });
    const boxes = boxesForTargets(document, ["search", "group-system", "empty", "missing"]);
    expect(boxes).toHaveLength(2);
    expect(unionBoxes(boxes)).toEqual({ top: 13, left: 3, width: 114, height: 114 });
  });

  it("places the callout to the right of the highlight and keeps it on screen", () => {
    expect(placeCallout(
      { top: 40, left: 16, width: 232, height: 120 },
      { width: 380, height: 280 },
      { width: 1280, height: 800 },
    )).toEqual({ top: 40, left: 264 });
    expect(placeCallout(
      { top: 700, left: 900, width: 200, height: 80 },
      { width: 380, height: 280 },
      { width: 1280, height: 800 },
    )).toEqual({ top: 504, left: 884 });
  });
});
