import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

const webRoot = fileURLToPath(new URL("../../packages/hub-web/", import.meta.url));
const storefront = "/repos/storefront/knowledge";
const designKit = "/repos/design-kit/knowledge";
let cacheDir: string;
let dev: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "mex-knowledge-tools-vite-"));
  dev = await createServer({ root: webRoot, cacheDir, server: { host: "127.0.0.1", port: 0, watch: null } });
  await dev.listen();
  origin = `http://127.0.0.1:${(dev.httpServer!.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  try { await dev?.close(); }
  finally { if (cacheDir) rmSync(cacheDir, { recursive: true, force: true }); }
});

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

function apiRequests(page: Page) {
  const requests: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/")) requests.push(pathname);
  });
  return requests;
}

async function scan(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

test("opens Rules with the keyboard and passes axe with stale, refreshed and empty rules", async ({ page }) => {
  const requests = apiRequests(page);
  await page.goto(`${origin}${storefront}?fixture=rules-stale`);
  const link = page.getByRole("link", { name: "Rule files", exact: true });
  await expect(link).toBeVisible();
  await scan(page);
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Rule files" })).toBeFocused();
  await expect(page.getByText("Rule files changed since the last refresh.")).toBeVisible();
  await scan(page);

  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Checkout" })).toBeFocused();
  await page.keyboard.press("Tab");
  const refresh = page.getByRole("button", { name: "Refresh" });
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Rule files refreshed.")).toBeVisible();
  await expect(refresh).toBeFocused();

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  await expect(page.getByRole("list", { name: "Rule files" }).locator("code").first()).toHaveCSS("color", "oklch(0.95 0 0)");
  await scan(page);

  await page.goto(`${origin}${designKit}?fixture=home&view=rules`);
  await expect(page.getByText("No rule files found.")).toBeVisible();
  await scan(page);
  expect(requests).toEqual([]);
});

test("keeps brief focus in the dialog and passes axe on desktop and mobile", async ({ page }) => {
  const requests = apiRequests(page);
  await page.goto(`${origin}${storefront}?fixture=home`);
  const trigger = page.getByRole("button", { name: "Preview brief" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Preview brief" });
  const agent = dialog.getByRole("combobox", { name: "Agent" });
  const path = dialog.getByRole("textbox", { name: "Path (optional)" });
  const preview = dialog.getByRole("button", { name: "Preview", exact: true });
  const result = dialog.getByRole("heading", { name: "What the agent gets" });
  await expect(agent).toBeFocused();
  await expect(result).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(path).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(preview).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(result).toBeFocused();
  await expect(dialog).toHaveCSS("opacity", "1");
  await scan(page);
  await page.keyboard.press("Tab");
  const coverage = dialog.getByText("Rule file coverage (6)");
  await expect(coverage).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("list", { name: "Rule files" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("combobox", { name: "Checkout" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.setViewportSize({ width: 360, height: 780 });
  await trigger.click();
  await agent.selectOption("codex");
  await path.fill("apps/web");
  await preview.click();
  await expect(dialog.getByRole("heading", { name: "Included items (2)" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await scan(page);

  await page.goto(`${origin}${storefront}?fixture=brief-failed`);
  await trigger.click();
  await preview.click();
  await expect(dialog.getByRole("alert")).toContainText("MEX's native check evaluator");
  await expect(dialog).toHaveCSS("opacity", "1");
  await scan(page);

  await page.goto(`${origin}/knowledge?fixture=home`);
  await trigger.click();
  await expect(preview).toHaveAccessibleDescription("Choose a repo to preview a brief.");
  await expect(dialog).toHaveCSS("opacity", "1");
  await scan(page);

  await page.goto(`${origin}${designKit}?fixture=home`);
  await trigger.click();
  await preview.click();
  await expect(dialog.getByText("No entries in this brief.")).toBeVisible();
  await scan(page);
  expect(requests).toEqual([]);
});
