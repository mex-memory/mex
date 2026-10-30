import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
for (const width of [1024, 1440]) test(`state diagram rendering and exploration at ${width}px`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width, height: 900 }); await page.goto(`/diagrams/preview/${"1".repeat(32)}?fixture=populated`);
  const diagram = page.getByRole("region", { name: "State diagram", exact: true });
  await expect(diagram.locator("svg").first()).toBeVisible(); await expect(diagram.getByRole("button", { name: "Ready · initial state", exact: true })).toBeVisible();
  await diagram.getByRole("button", { name: "Ready · initial state", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Diagram details" }).getByRole("heading", { name: "Ready", exact: true })).toBeVisible();
  const zoom = diagram.locator('[aria-live="polite"]');
  const before = Number((await zoom.innerText()).replace("%", ""));
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  expect(Number((await zoom.innerText()).replace("%", ""))).toBeGreaterThan(before);
  await diagram.focus(); await page.keyboard.press("ArrowRight"); await page.getByRole("button", { name: "Fit diagram" }).click();
  await page.getByLabel("Recorded path", { exact: true }).selectOption("path1");
  await expect(page.getByRole("listitem").filter({ hasText: "Working — Start work" })).toBeVisible();
  await expect(diagram.getByText("2. Working", { exact: true })).toBeVisible();
  await diagram.getByRole("button", { name: "Start work · Ready → Working", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Diagram details" }).getByText("A request is ready")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(errors).toEqual([]);
});
test("diagrams Save reviews retained content before creating a new snapshot", async ({ page }) => {
  await page.goto(`/diagrams/preview/${"1".repeat(32)}?fixture=populated`); await page.getByRole("button", { name: "Review Save" }).click();
  const dialog = page.getByRole("dialog"); await expect(dialog.getByText(/does not stage, commit or share/)).toBeVisible();
  await dialog.getByText(/record.md/).click(); await expect(dialog.locator("pre")).toContainText('"outcome": "incomplete"');
  await dialog.getByRole("button", { name: "Save snapshot" }).click(); await expect(page.getByText("Saved snapshot · working tree")).toBeVisible();
});
test("nested states and independent regions render readable long labels", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 }); await page.goto(`/diagrams/preview/${"2".repeat(32)}?fixture=populated`);
  const diagram = page.getByRole("region", { name: "State diagram", exact: true }); await expect(diagram.locator("svg").first()).toBeVisible();
  await expect(diagram.getByRole("button", { name: "Connection available · initial state", exact: true })).toBeVisible(); await expect(diagram.getByRole("button", { name: "Sending the retained files", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Accessible behavior lists" }).getByRole("button", { name: "Session", exact: true })).toBeVisible();
  await expect(diagram.getByLabel("Independent region connection", { exact: true })).toBeVisible();
  await expect(diagram.getByLabel("Independent region transferRegion", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/statechart/nested-viewer.png", fullPage: true }); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("recovery cycles use unfilled arrows and selectable events", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`/diagrams/preview/${"4".repeat(32)}?fixture=populated`);
  const diagram = page.getByRole("region", { name: "State diagram", exact: true });
  await diagram.scrollIntoViewIfNeeded();
  await expect(diagram.getByRole("button", { name: "Active setup and population · initial state" })).toBeVisible();
  const edges = diagram.locator("svg").first().locator(":scope > path");
  await expect(edges).toHaveCount(18);
  expect(await edges.evaluateAll(paths => paths.every(path => getComputedStyle(path).fill === "none" && parseFloat(getComputedStyle(path).strokeWidth) <= 1.5))).toBe(true);
  await diagram.getByRole("button", { name: "Setup prepared on disk", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Diagram details" }).getByRole("heading", { name: "Setup prepared on disk" })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: "test-results/statechart/recovery-graph.png", fullPage: false });
});
