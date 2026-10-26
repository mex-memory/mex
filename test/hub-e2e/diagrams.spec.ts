import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
for (const width of [1024, 1440]) test(`state diagram rendering and exploration at ${width}px`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width, height: 900 }); await page.goto(`/diagrams/preview/${"1".repeat(32)}?fixture=populated`);
  const diagram = page.getByRole("region", { name: "State diagram", exact: true });
  await expect(diagram.locator("svg")).toBeVisible(); await expect(diagram.getByText("Ready", { exact: true })).toBeVisible();
  await diagram.getByText("Ready", { exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Diagram details" }).getByRole("heading", { name: "Ready", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click(); await expect(page.getByText(/120%/)).toBeVisible();
  await diagram.focus(); await page.keyboard.press("ArrowRight"); await page.getByRole("button", { name: "Fit diagram" }).click();
  await page.getByLabel("Recorded path", { exact: true }).selectOption("path1");
  await expect(page.getByRole("listitem").filter({ hasText: "Working — Start work" })).toBeVisible();
  await expect(diagram.getByText("2. Working", { exact: true })).toBeVisible();
  const lists = page.getByRole("region", { name: "Accessible behavior lists" }); await lists.getByRole("button", { name: "Start work", exact: true }).click();
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
  const diagram = page.getByRole("region", { name: "State diagram", exact: true }); await expect(diagram.locator("svg")).toBeVisible();
  await expect(diagram.getByText("Connection available", { exact: true })).toBeVisible(); await expect(diagram.getByText("Sending the retained files", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Accessible behavior lists" }).getByRole("button", { name: "Session", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/statechart/nested-viewer.png", fullPage: true }); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
