import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("Context graph preserves knowledge positions while revealing direct code", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/knowledge?fixture=populated");
  const graph = page.getByLabel("Context graph", { exact: true });
  const knowledge = graph.getByRole("button", { name: "Project Hub read boundaries · architecture", exact: true });
  const other = graph.getByRole("button", { name: "One snapshot per graph request · decision", exact: true });
  await expect(knowledge).toBeVisible();
  const positions = await graph.locator('button[title]:not([aria-label*="code"])').evaluateAll((buttons) => buttons.map((button) => ({ label: button.getAttribute("aria-label"), style: button.getAttribute("style") })));
  await knowledge.click();
  const symbol = graph.getByRole("button", { name: "createHubServer · code · fresh", exact: true });
  await expect(symbol).toBeVisible();
  await symbol.click();
  const details = page.getByRole("complementary", { name: "Context details" });
  await expect(details.getByRole("link", { name: "Open in Code" })).toHaveAttribute("href", "/code/symbols/sym.createHubServer");
  await expect(knowledge).toHaveAttribute("aria-pressed", "true");
  expect(await graph.locator('button[title]:not([aria-label*="code"])').evaluateAll((buttons) => buttons.map((button) => ({ label: button.getAttribute("aria-label"), style: button.getAttribute("style") })))).toEqual(positions);
  await other.click();
  await expect(symbol).toHaveCount(0);
  await expect(details.getByText("No explicit code grounding recorded.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details.getByRole("heading", { name: "Follow a connection" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load more Knowledge" })).toBeVisible();
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(knowledge).toBeVisible();
  expect(errors).toEqual([]);
});

for (const width of [1024, 1440]) test(`Context graph remains usable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/knowledge?fixture=populated");
  const graph = page.getByLabel("Context graph", { exact: true });
  await expect(graph.getByRole("button", { name: "Project Hub read boundaries · architecture", exact: true })).toBeVisible();
  await page.getByLabel("Find in graph", { exact: true }).fill("snapshot");
  await expect(page.getByRole("status").filter({ hasText: "1 matching" })).toBeVisible();
  await graph.getByRole("button", { name: "Zoom in", exact: true }).click();
  await graph.getByRole("button", { name: "Fit graph", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
