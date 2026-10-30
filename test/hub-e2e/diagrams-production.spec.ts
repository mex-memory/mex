import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { expect, test } from "@playwright/test";
import { createHubApp } from "../../src/hub/app.js";
import { HubSessionManager } from "../../src/hub/security/session.js";
import { createLocalHubReadServices } from "../../src/hub/services.js";
import { HubAssetManifest } from "../../src/hub/static/assets.js";
import { DiagramRepository } from "../../src/statechart/repository.js";
import { recoveryDiagramFixture, nestedDiagramFixture } from "../../packages/hub-web/src/dev/diagram-fixtures";
import { assertReleaseRouteReady } from "../../scripts/release-benchmark/browser.mjs";

test("built diagram canvas preserves thin edges under the real Hub content security policy", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "mex-diagram-csp-"));
  mkdirSync(join(root, ".mex"));
  const repository = new DiagramRepository(root);
  const recovery = await repository.register(recoveryDiagramFixture().artifact);
  const nested = await repository.register(nestedDiagramFixture().artifact);
  let app: ReturnType<typeof createHubApp>;
  const server = createServer(getRequestListener(request => app.fetch(request)));
  try {
    await new Promise<void>(resolveListening => server.listen(0, "127.0.0.1", resolveListening));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing server address");
    const origin = `http://127.0.0.1:${address.port}`, token = Buffer.alloc(32, 17).toString("base64url");
    app = createHubApp({ security: new HubSessionManager({ bootstrapToken: token, expectedOrigin: origin }), services: createLocalHubReadServices({ projectRoot: root }), assets: new HubAssetManifest(process.env.MEX_HUB_TEST_ASSET_ROOT ?? resolve("dist/hub")) });
    await page.setViewportSize({ width: 1440, height: 1100 });
    const errors: string[] = [], styleViolations: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", event => {
        if (event.violatedDirective.startsWith("style-src")) console.error(`BLOCKED_STYLE:${event.blockedURI}`);
      });
    });
    page.on("console", message => { if (message.text().includes("BLOCKED_STYLE:")) styleViolations.push(message.text()); });
    const response = await page.goto(`${origin}${recovery.route}#token=${token}`);
    expect(response!.headers()["content-security-policy"]).toContain("style-src 'self'");
    await page.getByRole("button", { name: "Skip tour", exact: true }).click();
    await assertReleaseRouteReady(page, "diagramDetail", {});
    const diagram = page.getByRole("region", { name: "State diagram", exact: true });
    await expect(diagram.getByRole("button", { name: "Active setup and population · initial state" })).toBeVisible();
    const edges = diagram.locator("svg").first().locator(":scope > path");
    await expect(edges).toHaveCount(18);
    expect(await edges.evaluateAll(paths => paths.every(path => getComputedStyle(path).fill === "none" && getComputedStyle(path).stroke !== "none"))).toBe(true);
    await diagram.scrollIntoViewIfNeeded();
    await diagram.getByRole("button", { name: "Setup prepared on disk", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Diagram details" }).getByRole("heading", { name: "Setup prepared on disk" })).toBeVisible();
    await page.mouse.move(0, 0);
    await diagram.screenshot({ path: "test-results/statechart/production-recovery-graph.png" });
    await page.goto(`${origin}${nested.route}`);
    await assertReleaseRouteReady(page, "diagramDetail", {});
    await expect(page.getByRole("group", { name: "Independent region connection", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Independent region transferRegion", exact: true })).toBeVisible();
    expect(styleViolations).toEqual([]); expect(errors).toEqual([]);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
});
