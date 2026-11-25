import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

const webRoot = fileURLToPath(new URL("../../packages/hub-web/", import.meta.url));
const storefront = "/repos/storefront/setup?fixture=setup";

test("Setup has a keyboard consent path and passes axe across its fixture states", async ({ page }) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "mex-setup-vite-"));
  let dev: ViteDevServer | undefined;

  try {
    dev = await createServer({ root: webRoot, cacheDir, server: { host: "127.0.0.1", port: 0, watch: null } });
    await dev.listen();
    const origin = `http://127.0.0.1:${(dev.httpServer!.address() as AddressInfo).port}`;
    const requests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url());
    });
    const scan = async () => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const open = async (path: string) => {
      await page.goto(origin + path);
      await expect(page.getByRole("heading", { level: 1, name: "Setup", exact: true })).toBeVisible();
    };

    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(storefront);
    await scan();
    const start = page.getByRole("button", { name: "Start learn deeper" });
    await start.focus();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("alertdialog", { name: "Start learn deeper?" });
    await expect(confirm.getByRole("button", { name: "Back" })).toBeFocused();
    await expect(confirm.getByText("72,000 tokens")).toBeVisible();
    await expect(confirm).toHaveCSS("opacity", "1");
    await scan();
    await page.keyboard.press("Escape");
    await expect(start).toBeFocused();
    await expect(page.getByRole("link", { name: "View job for Learn deeper" })).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(confirm.getByRole("button", { name: "Back" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(confirm.getByRole("button", { name: "Confirm and start" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Setup steps" })).toBeFocused();
    await expect(page.getByText("Starts after the code map and other setup work.")).toBeVisible();

    await page.emulateMedia({ colorScheme: "dark" });
    await open(storefront);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await scan();
    await page.emulateMedia({ colorScheme: "light" });

    for (const [path, text] of [
      ["/repos/design-kit/setup?fixture=setup", "Done with gaps"],
      ["/repos/docs-site/setup?fixture=setup", "Failed"],
      ["/repos/field-notes/setup?fixture=setup", "No reviews to learn from (no GitHub or GitLab remote) · $0, nothing started"],
      ["/setup?fixture=empty", "Set up your first repo"],
    ]) {
      await open(path);
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await scan();
    }

    await page.setViewportSize({ width: 360, height: 780 });
    await open(storefront);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
    await expect(page.getByRole("heading", { name: "2 quick questions" })).toBeVisible();
    await scan();
    await start.click();
    await expect(confirm.getByRole("button", { name: "Back" })).toBeFocused();
    await expect(confirm).toHaveCSS("opacity", "1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
    await scan();
    expect(requests).toEqual([]);
  } finally {
    try { await dev?.close(); }
    finally { rmSync(cacheDir, { recursive: true, force: true }); }
  }
});
