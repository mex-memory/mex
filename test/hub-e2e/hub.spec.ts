import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runningJobId = "job_01K36WVM6H7JK8M9NPQRSTVVWX";
const readyRelayId = "relay_01000000000000000000000001";
const claimedRelayId = "relay_01000000000000000000000002";
const sentWaitingRelayId = "relay_01000000000000000000000003";
const sentTakenRelayId = "relay_01000000000000000000000004";
const closedRelayId = "relay_01000000000000000000000005";
const legacyRelayId = "relay_01000000000000000000000006";
const legacyRelayV2Id = "relay_01000000000000000000000007";
const relayDraftId = "relay-draft-01";
const adaMemberId = "member_01K36WVM6H7JK8M9NPQRSTVVWX";
const graceMemberId = "member_01K36R3X4A5BC6DE7FGHJKMNPQ";
const inactiveMemberId = "member_01K35Z2A3B4C5D6E7FGHJKMNPQ";

// The redesigned Hub goldens have been rendered and reviewed on macOS only.
// Keep Linux functional, keyboard, overflow, and axe coverage active until the
// pinned Ubuntu 24.04 baselines can be captured and reviewed as a complete set.
const hasReviewedHubVisualBaselines = process.platform === "darwin";

// Existing Hub flows run as a returning browser; the first-run tour otherwise
// overlays the dashboard and intercepts every click.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    window.localStorage.setItem("mex.hub.onboarding.v1", JSON.stringify({ completed: true }));
  });
});

function watchBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectAccessible(page: Page): Promise<void> {
  const report = await new AxeBuilder({ page }).analyze();
  expect(report.violations).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  const geometry = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentClientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(geometry).toEqual({
    viewportWidth: width,
    documentClientWidth: width,
    documentScrollWidth: width,
    bodyScrollWidth: width,
  });
}

async function expectLoadedActivity(page: Page, count: number): Promise<void> {
  const liveRegion = page.locator('[aria-live="polite"]');
  await expect(liveRegion.getByText(`${count} ${count === 1 ? "event" : "events"} shown`, { exact: true })).toBeVisible();
}

test.describe("populated development fixture", () => {
  for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    test(`changes checkout logging settings accessibly at ${viewport.width}px`, async ({ page }, testInfo) => {
      const errors = watchBrowserErrors(page);
      await page.setViewportSize(viewport);
      await page.goto("/settings?fixture=populated");
      await expect(page.getByRole("heading", { name: "Agent logging", exact: true })).toBeVisible();
      const significant = page.getByRole("radio", { name: "Significant events", exact: true });
      await expect(significant).toBeChecked();
      await expect(page.getByRole("button", { name: "Save preference" })).toBeDisabled();
      await expectAccessible(page);
      await expectNoHorizontalOverflow(page, viewport.width);
      await page.screenshot({ path: testInfo.outputPath("settings-default.png"), fullPage: true });
      await significant.focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("radio", { name: "Task checkpoints", exact: true })).toBeChecked();
      const save = page.getByRole("button", { name: "Save preference" });
      await save.focus();
      await page.keyboard.press("Enter");
      const notice = page.getByText("Logging preference saved for this checkout.");
      await expect(notice).toBeFocused();
      await expect(save).toBeDisabled();
      await page.getByRole("radio", { name: "Only when asked", exact: true }).check();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("radio", { name: "Task checkpoints", exact: true })).toBeChecked();
      await expectAccessible(page);
      await expectNoHorizontalOverflow(page, viewport.width);
      await page.screenshot({ path: testInfo.outputPath("settings-saved.png"), fullPage: true });
      await page.getByRole("link", { name: /Read project notes in Activity/ }).click();
      await expect(page).toHaveURL(/\/activity\?source=legacy$/);
      await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test("renders the deterministic Home workbench", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?fixture=populated&overviewFixture=established");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

    const focus = page.getByRole("region", { name: "Attention", exact: true });
    const memory = page.getByRole("region", { name: "Context", exact: true });
    await expect(memory.getByRole("button", { name: "Open Context" })).toHaveAttribute("href", "/knowledge");
    await expect(focus.getByRole("button", { name: "View Relays" })).toHaveAttribute("href", "/relays");
    await expect(focus.getByRole("heading", { name: "Take the handoff waiting for you" })).toBeVisible();
    await expect(focus.getByRole("button", { name: "Open handoff" })).toHaveAttribute(
      "href",
      `/relays?view=mine&state=open&relay=${readyRelayId}`,
    );
    await expect(focus.getByRole("button", { name: "Open Inbox" })).toHaveCount(0);
    await expect(focus.getByText("Take the handoff waiting for you", { exact: true })).toBeVisible();
    await expect(focus.getByText("Continue the handoff you took", { exact: true })).toBeVisible();
    await expect(focus.getByText("Review local context health", { exact: true })).toBeVisible();

    const activity = page.getByRole("region", { name: "Latest team memory" });
    await expect(activity.getByText("Proposed a Spec change", { exact: true })).toBeVisible();
    await expect(activity.getByText("Took a handoff", { exact: true })).toBeVisible();
    await expect(activity.getByText("Actor not recorded", { exact: true })).toBeVisible();
    await expect(activity.getByRole("button", { name: "View Activity" })).toHaveAttribute("href", "/activity");

    const readiness = page.getByRole("region", { name: "Context readiness" });
    await expect(readiness.getByText("Needs attention", { exact: true })).toBeVisible();
    await expect(readiness.getByRole("img", { name: /Repository now .* indexed snapshot .* Code graph stale/ })).toBeVisible();
    await expect(readiness.getByText("The repository moved beyond this index", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Active operation" })).toBeVisible();
    await expectAccessible(page);
    expect(errors).toEqual([]);
    if (hasReviewedHubVisualBaselines) {
      await expect(page).toHaveScreenshot("hub-home.png", { fullPage: true });
    }
  });

  test("keeps Overview focus priorities and exact destinations honest", async ({ page }) => {
    await page.goto("/?fixture=populated&overviewFixture=pending-review");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    await expect(page.getByRole("region", { name: "Attention", exact: true }).getByRole("button", { name: "Open Inbox" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Context", exact: true }).getByRole("button", { name: "Open Context" })).toHaveAttribute("href", "/knowledge");

    await page.goto("/?fixture=populated&overviewFixture=relay-ready");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    await expect(page.getByRole("region", { name: "Attention", exact: true }).getByRole("button", { name: "Open handoff" })).toHaveAttribute(
      "href",
      `/relays?view=mine&state=open&relay=${readyRelayId}`,
    );

    await page.goto("/?fixture=populated&overviewFixture=relay-in-hand");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    await expect(page.getByRole("region", { name: "Attention", exact: true }).getByRole("button", { name: "Continue handoff" })).toHaveAttribute(
      "href",
      `/relays?view=mine&state=open&relay=${claimedRelayId}`,
    );

    await page.goto("/?fixture=populated&overviewFixture=identity-unresolved");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    const identityFocus = page.getByRole("region", { name: "Attention", exact: true });
    await expect(identityFocus.getByRole("heading", { name: "Resolve who you’re working as" })).toBeVisible();
    await expect(identityFocus.getByRole("button", { name: "Review identity" })).toHaveAttribute("href", "/members");
    await expect(identityFocus.getByText("Relay focus unavailable", { exact: true })).toBeVisible();

    await page.goto("/?fixture=populated&overviewFixture=failure");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    const failureFocus = page.getByRole("region", { name: "Attention", exact: true });
    await expect(page.getByRole("region", { name: "Context", exact: true }).getByRole("button", { name: "Open Context" })).toHaveAttribute("href", "/knowledge");
    await expect(failureFocus.getByRole("heading", { name: "Review the failed Graph refresh" })).toBeVisible();
    await expect(failureFocus.getByRole("button", { name: "View operation" })).toHaveAttribute(
      "href",
      "/jobs?job=job_01K39R3X4A5BC6DE7FGHJKMNPQ",
    );
    await expect(page.getByRole("region", { name: "Operation needs attention" })).toBeVisible();
  });

  test("distinguishes caught-up, first-index, stale, and degraded context", async ({ page }) => {
    await page.goto("/?fixture=populated&overviewFixture=caught-up");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    const caughtUp = page.getByRole("region", { name: "Attention", exact: true });
    await expect(page.getByRole("region", { name: "Context", exact: true }).getByRole("button", { name: "Open Context" })).toHaveAttribute("href", "/knowledge");
    await expect(caughtUp.getByText("You’re caught up", { exact: true })).toBeVisible();
    await expect(caughtUp.getByRole("button", { name: "Browse shared knowledge" })).toHaveAttribute("href", "/knowledge");
    await expect(page.getByRole("region", { name: "Active operation" })).toHaveCount(0);

    await page.goto("/?fixture=populated&overviewFixture=indexes-missing");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Attention", exact: true }).getByRole("heading", { name: "Prepare local project context" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Context readiness" }).getByText("Preparing", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Latest team memory" }).getByText("No team memory yet", { exact: true })).toBeVisible();

    await page.goto("/?fixture=populated&overviewFixture=indexes-stale");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    await expect(page.getByText("The repository moved beyond this index", { exact: true })).toBeVisible();
    await expect(page.getByText("7", { exact: true })).toBeVisible();

    await page.goto("/?fixture=populated&overviewFixture=indexes-degraded");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    const degraded = page.getByRole("region", { name: "Context readiness" });
    await expect(degraded.getByText("178 complete · 4 partial · 1 failed", { exact: true })).toBeVisible();
    await expect(degraded.getByRole("img", { name: "178 parsed successfully, 4 partial, 1 failed", exact: true })).toBeVisible();
  });

  test("renders determinate and indeterminate operations without inventing progress", async ({ page }) => {
    await page.goto("/?fixture=populated&overviewFixture=job-determinate");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    const determinate = page.getByRole("region", { name: "Active operation" });
    const determinateProgress = determinate.getByRole("progressbar");
    await expect(determinateProgress).toHaveAttribute("aria-valuenow", "68");
    await expect(determinateProgress).toHaveAccessibleName("Graph refresh · Parse");
    await expect(determinate.getByText("124 / 183 files parsed", { exact: true })).toBeVisible();
    await expect(determinate.getByRole("button", { name: "View operation" })).toHaveAttribute(
      "href",
      `/jobs?job=${runningJobId}`,
    );

    await page.goto("/?fixture=populated&overviewFixture=job-indeterminate");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    const indeterminate = page.getByRole("region", { name: "Active operation" });
    const indeterminateProgress = indeterminate.getByRole("progressbar");
    await expect(indeterminateProgress).toHaveAccessibleName("Wiki refresh · Discover");
    await expect(indeterminateProgress).not.toHaveAttribute("aria-valuenow");
    await expect(indeterminate.getByText("37 completed", { exact: true })).toBeVisible();
  });

  test("keeps partial Overview panels independently useful and retryable", async ({ page }) => {
    await page.goto("/?fixture=populated&overviewFixture=partial");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    const focus = page.getByRole("region", { name: "Attention", exact: true });
    await expect(focus.getByRole("heading", { name: "Review local context health" })).toBeVisible();
    await expect(focus.getByRole("button", { name: "Open Health" })).toHaveAttribute("href", "/health");
    await expect(focus.getByText("Relay focus unavailable", { exact: true })).toBeVisible();
    await expect(focus.getByRole("button", { name: "Try loading Relay focus again" })).toBeVisible();

    const activity = page.getByRole("region", { name: "Latest team memory" });
    await expect(activity.getByText("Latest team memory unavailable", { exact: true })).toBeVisible();
    await expect(activity.getByRole("button", { name: "Try loading Latest team memory again" })).toBeVisible();

    const context = page.getByRole("region", { name: "Context readiness" });
    await expect(context.getByText("Code graph context unavailable", { exact: true })).toBeVisible();
    await expect(context.getByRole("definition").filter({ hasText: /^Fresh$/ })).toBeVisible();
    await expect(context.getByRole("button", { name: "Try loading Code graph context again" })).toBeVisible();
    await expectAccessible(page);
  });

  test("refreshes explicitly without polling, mutation requests, or outbound traffic", async ({ page }) => {
    const observed: Array<{ method: string; url: string }> = [];
    page.on("request", (request) => observed.push({ method: request.method(), url: request.url() }));
    await page.goto("/?fixture=populated&overviewFixture=established");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    observed.length = 0;

    await page.waitForTimeout(5_500);
    expect(observed.filter(({ url }) => new URL(url).pathname === "/api/v1/overview")).toHaveLength(0);
    expect(observed.filter(({ method }) => !["GET", "HEAD", "OPTIONS"].includes(method))).toEqual([]);
    expect(observed.filter(({ url }) => new URL(url).hostname !== "127.0.0.1")).toEqual([]);

    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Overview refreshed." })).toBeVisible();
    expect(observed.filter(({ method }) => !["GET", "HEAD", "OPTIONS"].includes(method))).toEqual([]);
    expect(observed.filter(({ url }) => new URL(url).hostname !== "127.0.0.1")).toEqual([]);
  });

  for (const width of [1440, 1024] as const) {
    test(`keeps the Overview atlas accessible and overflow-free at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 768 });
      await page.goto("/?fixture=populated&overviewFixture=established");
      await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
      const focus = await page.getByRole("region", { name: "Attention", exact: true }).boundingBox();
      const activity = await page.getByRole("region", { name: "Latest team memory" }).boundingBox();
      expect(focus).not.toBeNull();
      expect(activity).not.toBeNull();
      if (width === 1440) {
        expect(focus!.x).toBeLessThan(activity!.x);
        expect(Math.abs(focus!.y - activity!.y)).toBeLessThanOrEqual(1);
      } else {
        expect(focus!.y).toBeLessThan(activity!.y);
      }
      await expectNoHorizontalOverflow(page, width);
      await expectAccessible(page);
    });
  }

  test("suppresses Overview operation and queue motion when reduced motion is requested", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?fixture=populated&overviewFixture=job-indeterminate");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    const operationIcon = page.getByRole("region", { name: "Active operation" }).locator("svg.lucide-loader-circle");
    const progressIndicator = page.getByRole("region", { name: "Active operation" }).locator('[data-slot="progress-indicator"]');
    const queueLink = page.getByRole("region", { name: "Latest team memory" }).getByRole("button", { name: "View Activity" });
    const motion = await Promise.all([
      operationIcon.evaluate((element) => getComputedStyle(element).animationName),
      progressIndicator.evaluate((element) => getComputedStyle(element).animationName),
      queueLink.evaluate((element) => getComputedStyle(element).transitionDuration),
    ]);
    expect(motion[0]).toBe("none");
    expect(motion[1]).toBe("none");
    expect(Number.parseFloat(motion[2])).toBeLessThanOrEqual(0.00001);
  });

  test("keeps real Wiki, symbol, and source search groups separate", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto("/search?fixture=populated&q=hub");
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Project Hub read boundaries/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Code symbols" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Source matches" })).toBeVisible();
    await expect(page.getByRole("link", { name: /createHubServer/ }).first()).toBeVisible();
    await expect(page.getByText(/export async function createHubServer/)).toBeVisible();
    await expect(page.getByText("This source failed independently.")).toHaveCount(0);
    await expectAccessible(page);
    expect(errors).toEqual([]);
    if (hasReviewedHubVisualBaselines) {
      await expect(page.locator('aside[aria-label="Project Hub navigation"]')
        .getByText("Ada Lovelace", { exact: true })).toBeVisible();
      await expect(page).toHaveScreenshot("hub-search.png", { fullPage: true });
    }
  });

  test("browses, filters, paginates, and restores URL-backed Knowledge state", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/knowledge?fixture=populated&view=list");

    await expect(page.getByRole("heading", { name: "Context", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
    const summary = page.getByText("All Knowledge records", { exact: true }).locator("..");
    await expect(summary).toBeFocused();
    await expect(page.getByText("2 loaded", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Load more Knowledge" }).click();
    await expect(page.getByText("3 loaded", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Review immutable activity/ })).toBeVisible();

    await page.getByLabel("Kind").fill("decision");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/kind=decision/);
    const filteredSummary = page.getByText("Filtered Knowledge records", { exact: true }).locator("..");
    await expect(filteredSummary).toBeVisible();
    await expect(filteredSummary).toBeFocused();
    await expect(page.getByRole("link", { name: /One snapshot per graph request/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Project Hub read boundaries/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Clear search and filters" }).click();
    await expect(page).not.toHaveURL(/kind=/);
    await expect(page).toHaveURL(/view=list/);
    await expect(page.getByText("All Knowledge records", { exact: true }).locator("..")).toBeFocused();
    const searchbox = page.getByRole("searchbox", { name: "Search titles, summaries, and bodies" });
    await expect(searchbox).toHaveValue("");
    await searchbox.fill("snapshot");
    const apply = page.getByRole("button", { name: "Apply" });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page).toHaveURL(/q=snapshot/);
    await expect(page.getByText("Knowledge results for “snapshot”", { exact: true }).locator("..")).toBeFocused();
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("renders the read-only Knowledge record with keyboard links and exact grounding", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const external: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/knowledge/mx_01K36WVM6H7JK8M9NPQRSTVVWX?fixture=populated");

    await expect(page.getByRole("heading", { level: 1, name: "Project Hub read boundaries" })).toBeVisible();
    await expect(page.getByText("architecture · Knowledge record", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Record body" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Code grounding" })).toBeVisible();
    await expect(page.getByRole("link", { name: /sym\.createHubServer/ })).toHaveAttribute(
      "href",
      "/code/symbols/sym.createHubServer",
    );
    await expect(page.getByRole("heading", { name: "Evidence" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Provenance" })).toBeVisible();
    await expect(page.getByRole("article", { name: "Knowledge body as plain text" })).toBeVisible();
    await expect(page.getByRole("tabpanel", { name: "Relations" }).getByText("One snapshot per graph request", { exact: true })).toBeVisible();

    await expectAccessible(page);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    if (hasReviewedHubVisualBaselines) {
      await expect(page).toHaveScreenshot("hub-knowledge.png", { fullPage: true });
    }

    const relations = page.getByRole("tab", { name: "Relations" });
    await relations.focus();
    await page.keyboard.press("ArrowRight");
    const backlinks = page.getByRole("tab", { name: "Backlinks" });
    await expect(backlinks).toBeFocused();
    await expect(backlinks).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Backlinks" }).getByText("Review immutable activity", { exact: true })).toBeVisible();
  });

  for (const width of [1440, 1024] as const) {
    test(`keeps the Knowledge workspace accessible and correctly arranged at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/knowledge/mx_01K36WVM6H7JK8M9NPQRSTVVWX?fixture=populated");
      await expect(page.getByRole("heading", { level: 1, name: "Project Hub read boundaries" })).toBeVisible();

      const identity = await page.getByRole("heading", { name: "Record identity" }).boundingBox();
      const body = await page.getByRole("heading", { name: "Record body" }).boundingBox();
      const evidence = await page.getByRole("heading", { name: "Code grounding" }).boundingBox();
      expect(identity).not.toBeNull();
      expect(body).not.toBeNull();
      expect(evidence).not.toBeNull();
      if (width === 1440) {
        expect(identity!.x).toBeLessThan(body!.x);
        expect(body!.x).toBeLessThan(evidence!.x);
      } else {
        expect(identity!.y).toBeLessThan(body!.y);
        expect(body!.y).toBeLessThan(evidence!.y);
      }
      const transitionDuration = await page.getByRole("link", { name: /sym\.createHubServer/ })
        .evaluate((element) => getComputedStyle(element).transitionDuration);
      expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.00001);
      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: width,
        documentClientWidth: width,
        documentScrollWidth: width,
        bodyScrollWidth: width,
      });
      await expectAccessible(page);
    });
  }

  test("renders the deterministic Code landing and exact symbol workspace", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const external: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/code?fixture=populated");

    await expect(page.getByRole("heading", { name: "Code" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Search symbols and source" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search code symbols and source" }).fill("hub");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Code symbols" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Source matches" })).toBeVisible();
    await page.getByRole("link", { name: /createHubServer/ }).first().click();

    await expect(page.getByRole("heading", { level: 1, name: "createHubServer" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    const specimen = page.getByRole("region", { name: "src/hub/server.ts, lines 74 through 84" });
    await expect(specimen).toBeVisible();
    await expect.poll(() => specimen.locator("code").allTextContents()).toEqual([
      "export async function createHubServer(options: HubServerOptions) {",
      "  const app = createHubApp(options);",
      "  const server = await listenOnLoopback(app, options.port);",
      "  return { server, address: server.address() };",
      "}",
    ]);
    await expect(page.getByText("sha256:888888888888", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Related Knowledge" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Project Hub read boundaries/ })).toBeVisible();
    await expectAccessible(page);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    if (hasReviewedHubVisualBaselines) {
      await expect(page).toHaveScreenshot("hub-code.png", { fullPage: true });
    }
  });

  test("uses keyboard tabs for callers, callees, and dependent impact", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/code/symbols/sym.createHubServer?fixture=populated");
    const overview = page.getByRole("tab", { name: "Overview" });
    await expect(overview).toHaveAttribute("aria-selected", "true");
    await overview.focus();

    await page.keyboard.press("ArrowRight");
    const callers = page.getByRole("tab", { name: "Callers" });
    await expect(callers).toBeFocused();
    await expect(callers).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\?view=callers$/);
    await expect(page.getByRole("tabpanel", { name: "Callers" }).getByText("sym.GraphPort.searchNodes", { exact: true })).toBeVisible();

    await page.keyboard.press("ArrowRight");
    const callees = page.getByRole("tab", { name: "Callees" });
    await expect(callees).toBeFocused();
    await expect(callees).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\?view=callees$/);
    await expect(page.getByRole("tabpanel", { name: "Callees" }).getByText("sym.GraphPort.searchNodes", { exact: true })).toBeVisible();

    await page.keyboard.press("End");
    const impact = page.getByRole("tab", { name: "Impact" });
    await expect(impact).toBeFocused();
    await expect(impact).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\?view=impact&depth=2$/);
    const impactPanel = page.getByRole("tabpanel", { name: "Impact" });
    await expect(impactPanel.getByRole("heading", { name: "Dependent blast radius" })).toBeVisible();
    await expect(impactPanel.getByText("1 affected dependents", { exact: true })).toBeVisible();
    await expect(impactPanel.getByText(/downstream/i)).toHaveCount(0);
    await expectAccessible(page);

    await page.keyboard.press("Home");
    await expect(overview).toBeFocused();
    await expect(overview).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/code\/symbols\/sym\.createHubServer$/);
    expect(errors).toEqual([]);
  });

  for (const width of [1440, 1024] as const) {
    test(`keeps the Code observatory accessible and overflow-free at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/code/symbols/sym.createHubServer?fixture=populated");
      await expect(page.getByRole("heading", { level: 1, name: "createHubServer" })).toBeVisible();

      const identity = await page.getByRole("heading", { level: 2, name: "createHubServer" }).locator("xpath=ancestor::section[1]").boundingBox();
      const source = await page.getByRole("heading", { name: "Source specimen" }).locator("xpath=ancestor::section[1]").boundingBox();
      const traversal = await page.getByRole("tabpanel", { name: "Overview" }).boundingBox();
      expect(identity).not.toBeNull();
      expect(source).not.toBeNull();
      expect(traversal).not.toBeNull();
      if (width === 1440) {
        expect(identity!.x).toBeLessThan(source!.x);
        expect(source!.x).toBeLessThan(traversal!.x);
        expect(Math.abs(identity!.y - source!.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(source!.y - traversal!.y)).toBeLessThanOrEqual(1);
      } else {
        expect(identity!.y).toBeLessThan(source!.y);
        expect(source!.y).toBeLessThan(traversal!.y);
      }
      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: width,
        documentClientWidth: width,
        documentScrollWidth: width,
        bodyScrollWidth: width,
      });
      await expectAccessible(page);
    });
  }

  test("suppresses Code traversal motion when reduced motion is requested", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/code/symbols/sym.createHubServer?fixture=populated&view=callers");
    const relation = page.getByRole("tabpanel", { name: "Callers" }).getByRole("link").first();
    await expect(relation).toBeVisible();
    const motion = await relation.evaluate((element) => {
      const style = getComputedStyle(element);
      return { transitionDuration: style.transitionDuration, animationDuration: style.animationDuration };
    });
    expect(Number.parseFloat(motion.transitionDuration)).toBeLessThanOrEqual(0.00001);
    expect(Number.parseFloat(motion.animationDuration)).toBeLessThanOrEqual(0.00001);
  });

  test("renders structured Graph Health without inventing repair availability", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto("/health?fixture=populated");
    await expect(page.getByRole("heading", { name: "Health", exact: true })).toBeVisible();
    await expect(page.getByText("Indexed snapshot", { exact: true })).toBeVisible();
    await expect(page.getByText("Current repository", { exact: true })).toBeVisible();
    await expect(page.getByText("179/183", { exact: true })).toBeVisible();
    await expect(page.getByText("Branch changed", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "View active job" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Refresh graph/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Rebuild graph/ })).toBeDisabled();
    await expect(page.getByText("The previous trustworthy index was preserved.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Wiki refresh" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Wiki rebuild" })).toBeDisabled();
    await expect(page.getByLabel("Services").getByText("New operations wait for the active job.", { exact: true })).toBeVisible();
    await expectAccessible(page);
    expect(errors).toEqual([]);
    if (hasReviewedHubVisualBaselines) {
      await expect(page).toHaveScreenshot("hub-health.png", { fullPage: true });
    }
  });

  test("renders persisted Jobs and an honest detail workspace", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto(`/jobs?fixture=populated&job=${runningJobId}`);
    await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Job detail" })).toBeVisible();
    const detail = page.getByRole("complementary", { name: "Job detail" });
    await expect(detail.getByRole("progressbar", { name: "68% of files parsed" })).toHaveAttribute("aria-valuenow", "68");
    await expect(detail.getByText("124 / 183 files parsed", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Graph operation phases").getByText("Parse", { exact: true })).toHaveAttribute("aria-current", "step");
    await expect(page.getByRole("button", { name: /^Refresh graph/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Rebuild graph/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Rebuild Wiki" })).toBeDisabled();
    await expectAccessible(page);
    expect(errors).toEqual([]);
    if (hasReviewedHubVisualBaselines) {
      await expect(page).toHaveScreenshot("hub-jobs.png", { fullPage: true });
    }
  });

  test("keeps local identity choice human-first and separate from Git and Activity", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/members?fixture=populated&memberFixture=configured");

    await expect(page.locator('[data-members-workbench="ready"]')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`member=${adaMemberId}`));
    const identity = page.getByRole("region", { name: "Your identity" });
    await expect(identity.getByRole("heading", { level: 3, name: "You’re working as Ada Lovelace." })).toBeVisible();
    await expect(identity.getByText("This controls how MEX attributes actions in this checkout. It is not authentication.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);

    const useGit = identity.getByRole("button", { name: "Use Git identity instead" });
    await useGit.click();
    const remove = page.getByRole("alertdialog", { name: "Remove your saved identity choice?" });
    await expect(remove.getByText("MEX will resolve your identity again from Git. This changes only this checkout and writes neither Git files nor Activity.", { exact: true })).toBeVisible();
    await remove.getByRole("button", { name: "Remove saved choice" }).click();

    const removedNotice = page.getByRole("alert").filter({ hasText: "Saved identity removed" });
    await expect(removedNotice).toBeFocused();
    await expect(removedNotice.getByText("MEX now recognizes you as Ada Lovelace from your Git identity. Nothing was written to Git.", { exact: true })).toBeVisible();
    await expect(identity.getByRole("heading", { level: 3, name: "MEX recognizes you as Ada Lovelace." })).toBeVisible();

    const choose = identity.getByRole("button", { name: "Choose an existing member" });
    await choose.click();
    const chooser = page.getByRole("dialog", { name: "Choose your identity" });
    const picker = chooser.getByRole("combobox", { name: "Team member" });
    await expect(picker).toBeFocused();
    await picker.fill("Grace");
    await page.getByRole("option", { name: /Grace Hopper/ }).click();
    const reviewOverride = chooser.getByRole("button", { name: "Review local override" });
    await reviewOverride.click();
    const override = page.getByRole("alertdialog", { name: "Work as Grace Hopper in this checkout?" });
    await expect(override.getByText("This is a local identity override for this checkout. It is not sign-in, writes no Git files, and creates no Activity.", { exact: true })).toBeVisible();
    await override.getByRole("button", { name: "Keep current identity" }).click();
    await expect(reviewOverride).toBeFocused();
    await reviewOverride.click();
    await page.getByRole("alertdialog", { name: "Work as Grace Hopper in this checkout?" })
      .getByRole("button", { name: "Use as me" }).click();

    const chosenNotice = page.getByRole("alert").filter({ hasText: "You’re now working as Grace Hopper" });
    await expect(chosenNotice).toBeFocused();
    await expect(chosenNotice.getByText("You’re now working as Grace Hopper in this checkout. Nothing was written to Git or Activity.", { exact: true })).toBeVisible();
    await expect(identity.getByRole("heading", { level: 3, name: "You’re working as Grace Hopper." })).toBeVisible();
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("uses structured shared-Member review with concise semantic confirmation", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/members?fixture=populated&memberFixture=configured");
    await expect(page.locator('[data-members-workbench="ready"]')).toBeVisible();

    const addMember = page.getByRole("button", { name: "Add member" });
    await addMember.click();
    const addDialog = page.getByRole("dialog", { name: "Add team member" });
    const displayName = addDialog.getByRole("textbox", { name: "Display name" });
    await expect(displayName).toBeFocused();
    await expect(addDialog.getByText("Shared through Git, not an invitation", { exact: true })).toBeVisible();
    await expect(addDialog.getByText("Names and emails are committed to the repository and may become public history in a public repository. This does not invite anyone or grant repository access.", { exact: true })).toBeVisible();
    await expect(addDialog.getByRole("button", { name: "Review member" })).toBeDisabled();
    await displayName.fill("Katherine Johnson");
    await expect(addDialog.getByRole("button", { name: "Add another identity" })).toBeVisible();
    await addDialog.getByRole("textbox", { name: "Git email" }).fill("kj@example.test");
    await addDialog.getByRole("textbox", { name: /Git name/ }).fill("Katherine");
    await expect(addDialog.getByRole("textbox", { name: /Git aliases/ })).toHaveCount(0);
    await addDialog.getByRole("button", { name: "Review member" }).click();

    const addConfirmation = page.getByRole("alertdialog", { name: "Add this member?" });
    await expect(addConfirmation.getByText("This writes a shared Member record and one Activity entry in your working tree. Commit and push are still required to share it with teammates.", { exact: true })).toBeVisible();
    const addTechnical = addConfirmation.getByRole("button", { name: "Technical details" });
    await expect(addTechnical).toHaveAttribute("aria-expanded", "false");
    await addConfirmation.getByRole("button", { name: "Keep editing" }).click();
    await expect(addDialog.getByRole("button", { name: "Review member" })).toBeFocused();
    await addDialog.getByRole("button", { name: "Review member" }).click();
    await page.getByRole("alertdialog", { name: "Add this member?" }).getByRole("button", { name: "Add member" }).click();

    const addedNotice = page.getByRole("alert").filter({ hasText: "Member added" });
    await expect(addedNotice).toBeFocused();
    await expect(addedNotice.getByText("Member added in your working tree. Commit and push to share this identity with teammates.", { exact: true })).toBeVisible();
    const detail = page.getByRole("region", { name: "Selected Member detail" });
    await expect(detail.getByRole("heading", { level: 3, name: "Katherine Johnson" })).toBeVisible();

    await detail.getByRole("button", { name: "Edit member" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit Katherine Johnson" });
    const editedName = editDialog.getByRole("textbox", { name: "Display name" });
    await expect(editDialog.getByRole("button", { name: "Review member" })).toBeDisabled();
    await expect(editDialog.getByText("Change the display name or a Git identity before reviewing.", { exact: true })).toBeVisible();
    await editedName.fill("Katherine G. Johnson");
    await editDialog.getByRole("button", { name: "Review member" }).click();
    const editConfirmation = page.getByRole("alertdialog", { name: "Save changes to Katherine Johnson?" });
    await expect(editConfirmation.getByText("This writes a shared Member record and one Activity entry in your working tree. Commit and push are still required to share it with teammates.", { exact: true })).toBeVisible();
    await editConfirmation.getByRole("button", { name: "Save member" }).click();

    const updatedNotice = page.getByRole("alert").filter({ hasText: "Member updated" });
    await expect(updatedNotice).toBeFocused();
    await expect(updatedNotice.getByText("Member updated in your working tree. Commit and push to share the change.", { exact: true })).toBeVisible();
    await expect(detail.getByRole("heading", { level: 3, name: "Katherine G. Johnson" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("renders every bounded identity fixture honestly", async ({ page }) => {
    const cases = [
      ["configured", "You’re working as Ada Lovelace.", "Use Git identity instead"],
      ["git-alias", "MEX recognizes you as Ada Lovelace.", "Choose an existing member"],
      ["git-fallback", "Your Git identity isn’t linked to a MEX member.", "Add myself"],
      ["unknown", "MEX could not find a usable Git identity.", "Add myself"],
      ["stale", "Your saved identity choice must be removed first.", "Remove saved choice"],
      ["inactive", "Your saved identity choice must be removed first.", "Remove saved choice"],
      ["ambiguous", "Your Git identity matches more than one MEX member.", "Choose an existing member"],
      ["partial", "You’re working as Ada Lovelace.", "Use Git identity instead"],
    ] as const;

    for (const [variant, headline, action] of cases) {
      await page.goto(`/members?fixture=populated&memberFixture=${variant}`);
      const identity = page.getByRole("region", { name: "Your identity" });
      await expect(page.locator('[data-members-workbench="ready"]')).toBeVisible();
      await expect(identity.getByRole("heading", { level: 3, name: headline })).toBeVisible();
      await expect(identity.getByRole("button", { name: action })).toBeVisible();
      await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);

      if (variant === "unknown") {
        await expect(identity.getByText("MEX could not inspect a usable Git identity.", { exact: true })).toBeVisible();
      } else if (variant === "stale") {
        await expect(identity.getByText("Your saved Member no longer exists.", { exact: true })).toBeVisible();
      } else if (variant === "inactive") {
        await expect(identity.getByText("Your saved Member is inactive.", { exact: true })).toBeVisible();
      } else if (variant === "ambiguous") {
        await expect(identity.getByText("Your Git identity matches multiple active Members, so MEX did not guess.", { exact: true })).toBeVisible();
      } else if (variant === "git-fallback") {
        await expect(identity.getByText("contributor@example.test", { exact: true })).toBeVisible();
      } else if (variant === "partial") {
        await expect(page.getByRole("button", { name: "Add member" })).toBeDisabled();
        await expect(page.getByText("Canonical Member writes are not connected in this Hub process.", { exact: true }).first()).toBeVisible();
      }
    }
  });

  test("keeps Member status and selection URL-backed and refreshable", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/members?fixture=populated&memberFixture=configured&status=inactive&member=${inactiveMemberId}`);
    const inactiveTab = page.getByRole("tab", { name: "Inactive", exact: true });
    await expect(inactiveTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("region", { name: "Selected Member detail" })
      .getByRole("heading", { level: 3, name: "Lin Chen" })).toBeVisible();

    await inactiveTab.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Active", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/status=active/);
    await expect(page).toHaveURL(new RegExp(`member=${adaMemberId}`));
    await expect(page.getByRole("region", { name: "Selected Member detail" })
      .getByRole("heading", { level: 3, name: "Ada Lovelace" })).toBeVisible();
    await page.getByRole("button", { name: /Grace Hopper/ }).click();
    await expect(page).toHaveURL(new RegExp(`member=${graceMemberId}`));
    await expect(page.getByRole("region", { name: "Selected Member detail" })
      .getByRole("heading", { level: 3, name: "Grace Hopper" })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`member=${adaMemberId}`));
    await page.goBack();
    await expect(inactiveTab).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(new RegExp(`member=${inactiveMemberId}`));

    const beforeRefresh = page.url();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByText("Members and identity refreshed.", { exact: true })).toBeVisible();
    expect(page.url()).toBe(beforeRefresh);
    await expect(page.getByRole("region", { name: "Selected Member detail" })
      .getByRole("heading", { level: 3, name: "Lin Chen" })).toBeVisible();

    await page.goto("/members?fixture=populated&status=active&member=not-a-member-id");
    await expect(page.getByText("That Member link isn’t valid", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Return to team list" }).click();
    await expect(page).not.toHaveURL(/member=/);

    await page.goto(`/members?fixture=populated&status=active&member=${inactiveMemberId}`);
    await expect(page.getByText("Lin Chen is in inactive Members", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View inactive Members" }).click();
    await expect(inactiveTab).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/status=inactive/);
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ] as const) {
    test(`keeps Members accessible and overflow-free at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize(viewport);
      await page.goto(`/members?fixture=populated&memberFixture=configured&status=active&member=${adaMemberId}`);
      await expect(page.locator('[data-members-workbench="ready"]')).toBeVisible();

      const directory = await page.getByRole("region", { name: "Active Members" }).boundingBox();
      const detail = await page.getByRole("region", { name: "Selected Member detail" }).boundingBox();
      expect(directory).not.toBeNull();
      expect(detail).not.toBeNull();
      expect(directory!.x).toBeLessThan(detail!.x);
      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: viewport.width,
        documentClientWidth: viewport.width,
        documentScrollWidth: viewport.width,
        bodyScrollWidth: viewport.width,
      });
      await expectAccessible(page);
    });
  }

  for (const width of [768, 390] as const) {
    test(`keeps Members behind the desktop guard at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/members?fixture=populated");
      await expect(page.getByRole("heading", { name: "A wider workbench is required" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: width,
        documentClientWidth: width,
        documentScrollWidth: width,
        bodyScrollWidth: width,
      });
      await expectAccessible(page);
    });
  }

  test("renders the deterministic Members identity workbench", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/members?fixture=populated&memberFixture=configured&status=active&member=${adaMemberId}`);
    await expect(page.locator('[data-members-workbench="ready"]')).toBeVisible();
    await expect(page.getByRole("region", { name: "Selected Member detail" })
      .getByRole("heading", { level: 3, name: "Ada Lovelace" })).toBeVisible();
    await page.mouse.move(1, 1);
    if (hasReviewedHubVisualBaselines) {
      await expect(page).toHaveScreenshot("hub-members.png", { fullPage: true });
    }
  });

  test("loads Members and its mutation dialogs lazily without polling or external requests", async ({ page }) => {
    const requests: string[] = [];
    const external: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      requests.push(`${request.method()} ${url.pathname}`);
      if (url.hostname !== "127.0.0.1") external.push(request.url());
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?fixture=populated");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    expect(requests.some((request) => request.includes("/src/pages/MembersPage"))).toBe(false);
    expect(requests.some((request) => request.includes("/src/pages/MembersMutationDialogs"))).toBe(false);

    await page.getByRole("link", { name: "Team", exact: true }).click();
    await expect(page.locator('[data-members-workbench="ready"]')).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(requests.filter((request) => request.includes("/src/pages/MembersPage"))).toHaveLength(1);
    expect(requests.some((request) => request.includes("/src/pages/MembersMutationDialogs"))).toBe(false);
    const settledRequestCount = requests.length;
    await page.waitForTimeout(300);
    expect(requests).toHaveLength(settledRequestCount);

    await page.getByRole("button", { name: "Add member" }).click();
    await expect(page.getByRole("dialog", { name: "Add team member" })).toBeVisible();
    expect(requests.filter((request) => request.includes("/src/pages/MembersMutationDialogs"))).toHaveLength(1);
    expect(external).toEqual([]);
  });

  test("renders the real Activity workbench with bounded, expandable history", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/activity?fixture=populated");

    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await expect(page.locator('[data-activity-workbench="ready"]')).toBeVisible();
    await expect(page.getByText(/Shared MEX changes are recorded automatically and cannot be edited here/)).toBeVisible();
    await expectLoadedActivity(page, 4);
    await expect(page.getByText("Some activity needs attention")).toBeVisible();
    const proposal = page.getByRole("article", { name: "Proposed a Spec change" });
    await expect(proposal).toBeVisible();
    await expect(proposal.getByText("Ada Lovelace", { exact: true })).toBeVisible();
    await expect(proposal.getByRole("link", { name: /Keep approval consequences explicit/ })).toHaveAttribute(
      "href",
      "/inbox?view=review&proposal=proposal_01000000000000000000001721",
    );
    await expect(page.getByRole("article", { name: "Took a handoff" })).toBeVisible();
    await expect(page.getByRole("article", { name: "Updated a teammate" })).toBeVisible();
    await expect(page.getByText("event_01K36WVM6H7JK8M9NPQRSTVVWX", { exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Record Activity" })).toHaveCount(0);

    const firstDisclosure = proposal.getByRole("button", { name: /^View context for Proposed a Spec change:/ });
    await firstDisclosure.focus();
    await page.keyboard.press("Enter");
    await expect(proposal.getByRole("button", { name: /^Hide context for Proposed a Spec change:/ })).toBeFocused();
    await expect(proposal.getByRole("heading", { name: "Repository when recorded" })).toBeVisible();
    await expect(proposal.getByText("Local changes existed. MEX recorded that fact, not their paths, diff, or contents.")).toBeVisible();
    await expect(proposal.getByText("event_01K36WVM6H7JK8M9NPQRSTVVWX", { exact: true })).toBeHidden();

    await expectAccessible(page);
    expect(errors).toEqual([]);
    if (hasReviewedHubVisualBaselines) {
      await expect(page).toHaveScreenshot("hub-activity.png", { fullPage: true });
    }
  });

  test("keeps Activity read-only and refreshes only after explicit intent", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.goto("/activity?fixture=populated");
    await expectLoadedActivity(page, 4);

    await expect(page.getByRole("button", { name: "Record Activity" })).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("Activity refreshed.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Proposed a Spec change" })).toBeVisible();
    await expectLoadedActivity(page, 4);
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("renders empty, Project-note-only, and partial Activity fixtures honestly", async ({ page }) => {
    await page.goto("/activity?fixture=populated&activityFixture=empty");
    await expect(page.getByRole("heading", { name: "No team activity yet" })).toBeVisible();
    await expect(page.getByText(/Shared MEX changes will appear here automatically/)).toBeVisible();
    await expect(page.locator('[role="article"][data-source]')).toHaveCount(0);

    await page.goto("/activity?fixture=populated&activityFixture=legacy");
    await expect(page.locator('[role="article"][data-source="legacy"]')).toHaveCount(2);
    await expect(page.locator('[role="article"][data-source="activity"]')).toHaveCount(0);
    await expect(page.getByText("Keep activity immutable and preserve Project notes as a read-only projection.")).toBeVisible();

    await page.goto("/activity?fixture=populated&activityFixture=partial");
    await expect(page.getByText("This activity view is incomplete", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Proposed a Spec change" })).toBeVisible();
    await expectAccessible(page);
  });

  test("keeps Activity filters in history and paginates without mixing disclosures", async ({ page }) => {
    await page.goto("/activity?fixture=populated");
    await expectLoadedActivity(page, 4);

    await page.getByRole("button", { name: /^View context for Proposed a Spec change:/ }).click();
    await page.getByRole("button", { name: "Load older activity" }).click();
    await expectLoadedActivity(page, 7);
    await expect(page.getByRole("heading", { name: "Recorded “relay.closed”" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recorded “repository.initialized”" })).toBeVisible();
    await expect(page.getByText("You’ve reached the oldest available activity.", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Project notes", exact: true }).click();
    await expect(page).toHaveURL(/fixture=populated/);
    await expect(page).toHaveURL(/source=legacy/);
    await expect(page.locator('[role="article"][data-source="legacy"]')).toHaveCount(2);
    await expect(page.locator('[role="article"][data-source="activity"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Hide context/ })).toHaveCount(0);

    await page.getByLabel("From").fill("2026-08-23");
    await expect(page).toHaveURL(/since=2026-08-23/);
    await expect(page.locator('[role="article"][data-source="legacy"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Clear date" }).click();
    await expect(page).not.toHaveURL(/since=/);

    await page.goBack();
    await expect(page.getByLabel("From")).toHaveValue("2026-08-23");
    await page.goBack();
    await expect(page.getByRole("tab", { name: "Project notes", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.goBack();
    await expect(page.getByRole("tab", { name: "All activity", exact: true })).toHaveAttribute("aria-selected", "true");
  });

  for (const width of [390, 768, 1024, 1440] as const) {
    test(`keeps Activity accessible and overflow-free at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/activity?fixture=populated");
      if (width < 1024) {
        await expect(page.getByRole("heading", { name: "A wider workbench is required" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
      } else {
        await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
        const disclosure = page.getByRole("button", { name: /^View context for Proposed a Spec change:/ });
        const transitionDuration = await disclosure.evaluate(
          (element) => getComputedStyle(element).transitionDuration,
        );
        expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.00001);
      }
      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: width,
        documentClientWidth: width,
        documentScrollWidth: width,
        bodyScrollWidth: width,
      });
      await expectAccessible(page);
    });
  }

  for (const route of ["workstreams", "specs"] as const) {
    for (const width of [390, 768, 1440] as const) {
      test(`keeps ${route} accessible and overflow-free at ${width}px`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/${route}?fixture=populated`);

        if (width < 1024) {
          await expect(page.getByRole("heading", { name: "A wider workbench is required" })).toBeVisible();
          await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
        } else {
          const heading = route === "workstreams" ? "Workstreams" : "Specs";
          await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
          if (route === "workstreams") {
            await expect(page.getByRole("region", { name: "Selected Workstream detail" })).toBeVisible();
          } else {
            await expect(page.getByRole("region", { name: "Selected Spec detail" })).toBeVisible();
            await expect(page.getByText("No inferred coverage.")).toBeVisible();
          }
        }

        const geometry = await page.evaluate(() => ({
          viewportWidth: window.innerWidth,
          documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
        }));
        expect(geometry).toEqual({
          viewportWidth: width,
          documentClientWidth: width,
          documentScrollWidth: width,
          bodyScrollWidth: width,
        });
        await expectAccessible(page);
      });
    }
  }

  test("saves a knowledge contribution as a local Inbox draft", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/inbox?fixture=populated&view=drafts");
    await page.getByRole("button", { name: "Create manually", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Create local knowledge draft" });
    await expect(editor).toBeVisible();
    await editor.getByLabel("Knowledge kind", { exact: true }).selectOption("decision");
    await editor.getByLabel("Title", { exact: true }).fill("Keep shared context in Git");
    await editor.getByLabel("Knowledge body", { exact: true }).fill("Accepted project knowledge lives in tracked Markdown.");
    await editor.getByLabel("Rationale", { exact: true }).fill("Capture the decision from our working session.");
    await expectAccessible(page);
    await editor.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Selected Inbox draft detail" })
      .getByRole("heading", { level: 2, name: "Keep shared context in Git", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/view=drafts.*draft=/);
    expect(errors).toEqual([]);
  });

  test("renders Inbox as a review-first semantic desk with honest action policy", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/inbox?fixture=populated");

    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await expect(page.getByText(
      "Review proposed changes before they become shared project memory.",
      { exact: true },
    )).toBeVisible();
    await expect(page.getByRole("tab", { name: "For review 3" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Drafts on this device" })).toHaveAttribute("aria-selected", "false");
    await expect(page.getByRole("heading", { name: "Needs your review" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Waiting for teammate" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Needs refresh" })).toBeVisible();

    const teammate = page.locator('[data-inbox-proposal-id="proposal_01000000000000000000001720"]');
    await expect(teammate).toContainText("Clarify release evidence review");
    await expect(teammate).toContainText("Published by Grace Hopper");
    await expect(teammate).toHaveAttribute("aria-current", "true");
    const detail = page.getByRole("region", { name: "Selected Inbox review detail" });
    await expect(detail.getByRole("heading", { level: 2, name: "Clarify release evidence review" })).toBeVisible();
    await expect(detail.getByText("Knowledge change", { exact: true })).toBeVisible();
    await expect(detail.getByText("Published by Grace Hopper", { exact: true })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "What will change" })).toBeVisible();
    await expect(detail.getByRole("region", { name: "Summary comparison" }).getByText("Current")).toBeVisible();
    await expect(detail.getByRole("region", { name: "Summary comparison" }).getByText("Proposed")).toBeVisible();
    await expect(detail.getByRole("heading", { name: "Why this change" })).toBeVisible();
    const technical = detail.getByRole("button", { name: "Technical details" });
    await expect(technical).toHaveAttribute("aria-expanded", "false");
    await expect(detail.getByText("proposal_01000000000000000000001720", { exact: true })).toHaveCount(0);
    await technical.click();
    await expect(detail.getByText("proposal_01000000000000000000001720", { exact: true })).toBeVisible();
    await technical.click();
    await expect(detail.getByRole("button", { name: "Approve change" })).toBeVisible();
    const teammateMore = detail.getByRole("button", { name: "More proposal actions" });
    await teammateMore.click();
    await expect(page.getByRole("menuitem", { name: "Decline proposal…" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Mark as needs refresh…" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Withdraw proposal…" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(teammateMore).toBeFocused();

    const own = page.locator('[data-inbox-proposal-id="proposal_01000000000000000000001721"]');
    await own.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/view=review.*proposal=proposal_01000000000000000000001721/);
    await expect(detail.getByRole("heading", { level: 2, name: "Keep approval consequences explicit" })).toBeVisible();
    await expect(detail.getByText("Waiting for teammate review", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Approve change" })).toHaveCount(0);
    const ownMore = detail.getByRole("button", { name: "More proposal actions" });
    await ownMore.click();
    await expect(page.getByRole("menuitem", { name: "Approve without teammate review…" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Withdraw proposal…" })).toBeVisible();
    await page.keyboard.press("Escape");

    const stale = page.locator('[data-inbox-proposal-id="proposal_01000000000000000000001722"]');
    await stale.click();
    await expect(detail.getByRole("heading", { level: 2, name: "Refresh the stale review boundary" })).toBeVisible();
    await expect(detail.getByText(
      "The referenced knowledge content changed after this proposal was published.",
      { exact: true },
    )).toBeVisible();
    await expect(detail.getByRole("button", { name: "Approve change" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "More proposal actions" })).toHaveCount(0);
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("renders the empty Inbox fixture as an honest caught-up state", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/inbox?fixture=populated&inboxFixture=empty");

    await expect(page.getByRole("tab", { name: /For review/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("You’re all caught up", { exact: true })).toBeVisible();
    await expect(page.getByText("No knowledge changes currently need review.", { exact: true })).toBeVisible();
    await expect(page.locator("[data-inbox-proposal-id]")).toHaveCount(0);
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("keeps unknown Inbox identity neutral without blocking review", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/inbox?fixture=populated&inboxFixture=unknown");

    await expect(page.getByRole("heading", { name: "Needs review" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Needs your review" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Waiting for teammate" })).toHaveCount(0);
    const detail = page.getByRole("region", { name: "Selected Inbox review detail" });
    await expect(detail.getByText("Team identity is not set", { exact: true })).toBeVisible();
    await expect(detail.getByRole("link", { name: "set your identity in Team" })).toHaveAttribute("href", "/members");
    await expect(detail.getByRole("button", { name: "Approve change" })).toBeEnabled();
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("isolates partial Inbox capabilities without hiding readable work", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/inbox?fixture=populated&inboxFixture=partial");

    const reviewDetail = page.getByRole("region", { name: "Selected Inbox review detail" });
    await expect(reviewDetail.getByRole("heading", { level: 2, name: "Clarify release evidence review" })).toBeVisible();
    await expect(reviewDetail.getByRole("button", { name: "Approve change" })).toBeDisabled();
    await expect(reviewDetail.getByText(
      "Approval is unavailable: Inbox Spec approval requires exact Wiki planning and apply.",
      { exact: true },
    )).toBeVisible();

    await page.getByRole("tab", { name: "Drafts on this device" }).click();
    const draftDetail = page.getByRole("region", { name: "Selected Inbox draft detail" });
    await expect(draftDetail.getByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" })).toBeVisible();
    await expect(draftDetail.getByRole("button", { name: "Publish for review" })).toBeDisabled();
    await expect(draftDetail.getByText(
      "Publication is unavailable: Inbox proposal writes are not connected in this Hub process.",
      { exact: true },
    )).toBeVisible();
    await expect(draftDetail.getByRole("button", { name: "Edit wording" })).toBeEnabled();
    await expect(draftDetail.getByRole("button", { name: "More draft actions" })).toBeEnabled();
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("keeps Inbox URL selection and explicit Refresh stable", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      "/inbox?fixture=populated&view=review&proposal=proposal_01000000000000000000001721",
    );

    const own = page.locator('[data-inbox-proposal-id="proposal_01000000000000000000001721"]');
    await expect(own).toHaveAttribute("aria-current", "true");
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await refresh.click();
    await expect(page.getByRole("status").filter({ hasText: "Inbox refreshed." })).toBeVisible();
    await expect(own).toHaveAttribute("aria-current", "true");
    await expect(page).toHaveURL(/view=review.*proposal=proposal_01000000000000000000001721/);

    await page.getByRole("tab", { name: "Drafts on this device" }).click();
    await expect(page).toHaveURL(/view=drafts.*draft=inbox_00000000000000000000000000000001/);
    await expect(page.locator('[data-inbox-draft-id="inbox_00000000000000000000000000000001"]'))
      .toHaveAttribute("aria-current", "true");
  });

  test("keeps draft editing, overflow, publication, and discard keyboard complete", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/inbox?fixture=populated&view=drafts");

    await expect(page.getByRole("tab", { name: "Drafts on this device" })).toHaveAttribute("aria-selected", "true");
    const draft = page.locator('[data-inbox-draft-id="inbox_00000000000000000000000000000001"]');
    await expect(draft).toContainText("Keep Inbox review focused on meaningful changes");
    await expect(draft).toHaveAttribute("aria-current", "true");
    const detail = page.getByRole("region", { name: "Selected Inbox draft detail" });
    await expect(detail.getByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" })).toBeVisible();

    const edit = detail.getByRole("button", { name: "Edit wording" });
    await edit.click();
    const editor = page.getByRole("dialog", { name: "Edit local Spec draft" });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("textbox", { name: "Title" })).toBeFocused();
    const advanced = editor.getByRole("button", { name: "Advanced" });
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await expect(editor.getByRole("textbox", { name: /Topic endpoint attestations/ })).toHaveCount(0);
    await advanced.click();
    await expect(advanced).toHaveAttribute("aria-expanded", "true");
    await expect(editor.getByRole("textbox", { name: /Topic endpoint attestations/ })).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await expect(edit).toBeFocused();

    const more = detail.getByRole("button", { name: "More draft actions" });
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Discard draft…" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "Discard draft…" })).toBeHidden();
    await expect(more).toBeFocused();

    const publish = detail.getByRole("button", { name: "Publish for review" });
    await publish.click();
    const publishDialog = page.getByRole("alertdialog", { name: "Publish this draft for review?" });
    await expect(publishDialog).toBeVisible();
    await expect.poll(() => publishDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(publishDialog.getByText("Git step still required", { exact: true })).toBeVisible();
    await expectAccessible(page);
    await publishDialog.getByRole("button", { name: "Keep private" }).click();
    await expect(publishDialog).toBeHidden();
    await expect(publish).toBeFocused();

    await more.click();
    await page.getByRole("menuitem", { name: "Discard draft…" }).click();
    const discardDialog = page.getByRole("alertdialog", { name: "Discard this draft?" });
    await expect(discardDialog).toBeVisible();
    await expect.poll(() => discardDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expectAccessible(page);
    await discardDialog.getByRole("button", { name: "Keep draft" }).click();
    await expect(discardDialog).toBeHidden();
    await expect(more).toBeFocused();
    expect(errors).toEqual([]);
  });

  for (const viewport of [
    { width: 390, height: 900 },
    { width: 768, height: 900 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ] as const) {
    test(`keeps Inbox accessible and overflow-free at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize(viewport);
      await page.goto("/inbox?fixture=populated");

      if (viewport.width < 1024) {
        await expect(page.getByRole("heading", { name: "A wider workbench is required" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
      } else {
        await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
        const reviewQueue = page.getByRole("region", { name: "Knowledge changes" });
        const reviewDetail = page.getByRole("region", { name: "Selected Inbox review detail" });
        await expect(reviewQueue).toBeVisible();
        await expect(reviewDetail.getByRole("heading", { level: 2, name: "Clarify release evidence review" })).toBeVisible();
        const reviewBoxes = await Promise.all([reviewQueue.boundingBox(), reviewDetail.boundingBox()]);
        expect(reviewBoxes[0]).not.toBeNull();
        expect(reviewBoxes[1]).not.toBeNull();
        expect(reviewBoxes[0]!.x).toBeLessThan(reviewBoxes[1]!.x);
        expect(reviewBoxes[0]!.x + reviewBoxes[0]!.width).toBeLessThanOrEqual(reviewBoxes[1]!.x + 1);

        await page.getByRole("tab", { name: "Drafts on this device" }).click();
        const draftQueue = page.getByRole("region", { name: "On this device" });
        const draftDetail = page.getByRole("region", { name: "Selected Inbox draft detail" });
        await expect(draftQueue).toBeVisible();
        await expect(draftDetail.getByRole("heading", { level: 2, name: "Keep Inbox review focused on meaningful changes" })).toBeVisible();
        const draftBoxes = await Promise.all([draftQueue.boundingBox(), draftDetail.boundingBox()]);
        expect(draftBoxes[0]).not.toBeNull();
        expect(draftBoxes[1]).not.toBeNull();
        expect(draftBoxes[0]!.x).toBeLessThan(draftBoxes[1]!.x);
        expect(draftBoxes[0]!.x + draftBoxes[0]!.width).toBeLessThanOrEqual(draftBoxes[1]!.x + 1);
      }

      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: viewport.width,
        documentClientWidth: viewport.width,
        documentScrollWidth: viewport.width,
        bodyScrollWidth: viewport.width,
      });
      await expectAccessible(page);
    });
  }

  test("renders the deterministic Inbox review visual", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/inbox?fixture=populated");
    await expect(page.getByRole("region", { name: "Selected Inbox review detail" })
      .getByRole("heading", { level: 2, name: "Clarify release evidence review" })).toBeVisible();
    if (hasReviewedHubVisualBaselines) {
      await expect(page).toHaveScreenshot("hub-inbox.png", { fullPage: true });
    }
  });

  test("renders Relays as a human-first handoff inbox with role-aware queues and detail", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/relays?fixture=populated");

    await expect(page.getByRole("heading", { level: 1, name: "Relays" })).toBeVisible();
    await expect(page.getByText(
      "Continue work with the progress, decisions, and next steps your teammate left.",
      { exact: true },
    )).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New local draft" })).toHaveCount(0);
    await expect(page.getByText(/\d+ loaded/)).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "For you" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Drafts on this device" })).toHaveAttribute("aria-selected", "false");
    const state = page.getByRole("group", { name: "Relay state" });
    await expect(state.getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "true");
    await expect(state.getByRole("button", { name: "Closed" })).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
      fixture: "populated",
      view: "mine",
      state: "open",
    });
    expect(new URL(page.url()).searchParams.has("relay")).toBe(false);
    expect(requests).not.toContain("/api/v1/relays/drafts");
    expect(requests.some((request) => request.includes("/src/pages/RelayDraftComposer"))).toBe(false);
    expect(requests.some((request) => request.includes("/src/pages/RelayDetailSections"))).toBe(false);

    const queue = page.getByRole("region", { name: "Handoffs" });
    await expect(queue.getByRole("heading", { name: "Ready to take" })).toBeVisible();
    await expect(queue.getByRole("heading", { name: "In your hands" })).toBeVisible();
    const ready = queue.locator(`[data-relay-id="${readyRelayId}"]`);
    await expect(ready).toContainText("Release evidence is ready for the final cross-platform gate.");
    await expect(ready).toContainText("From Grace Hopper");
    await expect(ready).toContainText("Ready to take");
    await expect(ready).toContainText("codex/hub-ux");
    await expect(ready).toContainText("1a2b3c4d");
    await expect(ready).not.toContainText("Workstream");
    await expect(ready).not.toHaveAttribute("aria-current", "true");

    const detail = page.getByRole("region", { name: "Selected handoff detail" });
    await expect(detail.getByText("Choose a handoff", { exact: true })).toBeVisible();
    await ready.click();
    await expect(ready).toHaveAttribute("aria-current", "true");
    await expect.poll(() => requests.filter((request) => request.includes("/src/pages/RelayDetailSections")).length)
      .toBe(1);
    await expect(page).toHaveURL(new RegExp(`view=mine.*state=open.*relay=${readyRelayId}`));
    await expect(detail.getByRole("heading", {
      level: 2,
      name: "Release evidence is ready for the final cross-platform gate.",
    })).toBeVisible();
    await expect(detail.getByText("Team handoff", { exact: true })).toBeVisible();
    const publicationRepository = detail.getByRole("heading", { name: "Repository when published" }).locator("xpath=ancestor::section[1]");
    await expect(publicationRepository.getByText("codex/hub-ux", { exact: true })).toBeVisible();
    await expect(publicationRepository.getByText("1a2b3c4d", { exact: true })).toBeVisible();
    await expect(publicationRepository.getByText("Clean", { exact: true })).toBeVisible();
    await expect(detail.getByText("Recorded Workstream", { exact: true })).toHaveCount(0);
    for (const heading of [
      "What to do next",
      "Where things stand",
      "Blockers",
      "Questions to resolve",
      "Already completed",
      "Lifecycle",
    ]) {
      await expect(detail.getByRole("heading", { name: heading })).toBeVisible();
    }
    const related = detail.getByRole("button", { name: "Related context" });
    const technical = detail.getByRole("button", { name: "Technical details" });
    await expect(related).toHaveAttribute("aria-expanded", "false");
    await expect(technical).toHaveAttribute("aria-expanded", "false");
    await expect(detail.getByText(readyRelayId, { exact: true })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Take handoff" })).toBeVisible();
    await related.click();
    await expect(detail.getByRole("heading", { name: "Files involved" })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "Changed files" })).toHaveCount(0);
    await expect(detail.getByRole("link", { name: "Human-team memory release" }).first())
      .toHaveAttribute("href", "/knowledge/mx_01000000000000000000000001");
    await expect(detail.getByRole("link", { name: "Open referenced code symbol" }).first())
      .toHaveAttribute("href", "/code/symbols/sym.createHubServer");
    const external = detail.getByRole("link", { name: "Node.js release matrix" });
    await expect(external).toHaveAttribute("target", "_blank");
    await expect(external).toHaveAttribute("rel", /noopener/);

    const claimed = queue.locator(`[data-relay-id="${claimedRelayId}"]`);
    await claimed.focus();
    await page.keyboard.press("Enter");
    await expect(claimed).toHaveAttribute("aria-current", "true");
    await expect(detail.getByRole("heading", {
      level: 2,
      name: "Finish the keyboard and screen-reader pass for the Hub review surfaces.",
    })).toBeVisible();
    await expect(detail.getByText("In your hands", { exact: true }).first()).toBeVisible();
    await expect(detail.getByRole("heading", { name: "Repository when published" })).toBeVisible();
    await expect(detail.getByText("feature/relay-accessibility", { exact: true })).toBeVisible();
    await expect(detail.getByText("23456789", { exact: true })).toBeVisible();
    await expect(detail.getByText("Local changes present", { exact: true })).toBeVisible();
    await expect(detail.getByText(
      "MEX recorded that local changes existed when this handoff was published. Their contents were not captured by the Relay.",
      { exact: true },
    )).toBeVisible();
    await expect(detail.getByRole("button", { name: "Close handoff" })).toBeVisible();

    await page.getByRole("tab", { name: "Sent" }).click();
    await expect(page.getByRole("tab", { name: "Sent" })).toHaveAttribute("aria-selected", "true");
    await expect(state.getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "true");
    const waiting = page.locator(`[data-relay-id="${sentWaitingRelayId}"]`);
    const taken = page.locator(`[data-relay-id="${sentTakenRelayId}"]`);
    await expect(waiting).toContainText("Waiting for pickup");
    await expect(taken).toContainText("Taken by Grace Hopper");
    await waiting.click();
    await expect(detail.getByRole("heading", {
      level: 2,
      name: "Run the final Relay contract regression suite against the merged branch.",
    })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Take handoff" })).toHaveCount(0);
    await expect(detail.getByText("This handoff is addressed to Grace Hopper.", { exact: true })).toBeVisible();
    await expect(detail.getByText("Only the named recipients can take this handoff, while their Member records are active.", { exact: true })).toBeVisible();
    await expect(detail.getByText(/MEX must resolve an eligible, active team identity before taking it/i)).toBeVisible();
    await expect(detail.getByText("Detached HEAD", { exact: true })).toBeVisible();
    await expect(detail.getByText("3456789a", { exact: true })).toBeVisible();

    await taken.click();
    await expect(detail.getByRole("heading", {
      level: 2,
      name: "Grace is carrying the final performance evidence into release review.",
    })).toBeVisible();
    await expect(detail.getByText("feature/unborn-relay", { exact: true })).toBeVisible();
    await expect(detail.getByText("No committed HEAD recorded", { exact: true })).toBeVisible();
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("keeps Relay perspective, lifecycle, deep links, and explicit Refresh recoverable", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/relays?fixture=populated&view=all&state=closed&relay=${closedRelayId}`);

    await expect(page.getByRole("tab", { name: "Team" })).toHaveAttribute("aria-selected", "true");
    const state = page.getByRole("group", { name: "Relay state" });
    await expect(state.getByRole("button", { name: "Closed" })).toHaveAttribute("aria-pressed", "true");
    const detail = page.getByRole("region", { name: "Selected handoff detail" });
    await expect(detail.getByRole("heading", {
      level: 2,
      name: "The Sidebar verification handoff no longer needs team attention.",
    })).toBeVisible();
    await expect(detail.getByText("Immutable closed handoff.", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Take handoff" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Close handoff" })).toHaveCount(0);

    await state.getByRole("button", { name: "Open" }).click();
    await expect(page.getByRole("tab", { name: "Team" })).toHaveAttribute("aria-selected", "true");
    await expect(state.getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
      view: "all",
      state: "open",
    });
    expect(new URL(page.url()).searchParams.has("relay")).toBe(false);
    await page.locator(`[data-relay-id="${readyRelayId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`view=all.*state=open.*relay=${readyRelayId}`));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Relays refreshed." })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`view=all.*state=open.*relay=${readyRelayId}`));

    await page.goto("/relays?fixture=populated&view=all&state=open&relay=not-a-relay");
    await expect(page.getByText("This handoff link is invalid", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Return to queue" })).toBeVisible();

    await page.goto(`/relays?fixture=populated&view=all&state=closed&relay=${readyRelayId}`);
    await expect(page.getByText("This handoff is not available in this view", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Return to handoffs" })).toBeVisible();

    const missingRelayId = "relay_07000000000000000000000007";
    await page.goto(`/relays?fixture=populated&view=all&state=open&relay=${missingRelayId}`);
    await expect(page.getByText("This view could not be loaded", { exact: true })).toBeVisible();
    await expect(page.getByText(
      "The Hub kept the last trustworthy state. Try the request again.",
      { exact: true },
    )).toBeVisible();
    await expect(page.getByRole("button", { name: "Return to queue" })).toBeVisible();
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("keeps Relay identity and capability failures local while Team and drafts stay readable", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/relays?fixture=populated&relayFixture=missing");

    await expect(page.getByRole("tab", { name: "For you" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Check your team identity", { exact: true })).toBeVisible();
    await expect(page.getByText("The referenced member no longer exists.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Members" }).first()).toHaveAttribute("href", "/members");
    await expect(page.locator("[data-relay-id]")).not.toHaveCount(0);
    await page.getByRole("tab", { name: "Team" }).click();
    await expect(page.locator("[data-relay-id]")).not.toHaveCount(0);
    await page.getByRole("tab", { name: "Drafts on this device" }).click();
    await expect(page.locator(`[data-relay-draft-id="${relayDraftId}"]`)).toBeVisible();
    await expectAccessible(page);

    await page.goto("/relays?fixture=populated&relayFixture=partial");
    await page.locator(`[data-relay-id="${readyRelayId}"]`).click();
    const reviewDetail = page.getByRole("region", { name: "Selected handoff detail" });
    await expect(reviewDetail.getByRole("button", { name: "Take handoff" })).toBeDisabled();
    await expect(reviewDetail.getByText(
      "Relay lifecycle writes are not connected in this Hub process.",
      { exact: true },
    )).toBeVisible();
    await page.getByRole("tab", { name: "Drafts on this device" }).click();
    await page.locator(`[data-relay-draft-id="${relayDraftId}"]`).click();
    const draftDetail = page.getByRole("region", { name: "Selected handoff draft detail" });
    await expect(draftDetail.getByRole("button", { name: "Publish handoff" })).toBeDisabled();
    await expect(draftDetail.getByText(
      "Relay publication is not connected in this Hub process.",
      { exact: true },
    )).toBeVisible();
    await expect(draftDetail.getByRole("button", { name: "Edit wording" })).toBeEnabled();
    await expect(draftDetail.getByRole("button", { name: "More draft actions" })).toBeEnabled();
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  test("renders honest empty, closed, and legacy Relay fixture states", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/relays?fixture=populated&relayFixture=empty");
    await expect(page.getByText("No handoffs need your attention", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Drafts on this device" }).click();
    await expect(page.getByText("No handoff drafts on this device", { exact: true })).toBeVisible();
    await expect(page.getByText(
      "Your coding agent can prepare a structured Relay when you pause or hand work to a teammate.",
      { exact: true },
    )).toBeVisible();
    const emptyDrafts = page.locator('[data-slot="empty"]').filter({ hasText: "No handoff drafts on this device" });
    await expect(emptyDrafts.getByRole("button", { name: "Create manually" })).toBeVisible();
    await expectAccessible(page);

    await page.goto(`/relays?fixture=populated&relayFixture=closed&view=all&state=closed&relay=${closedRelayId}`);
    await expect(page.getByRole("heading", {
      level: 2,
      name: "The Sidebar verification handoff no longer needs team attention.",
    })).toBeVisible();
    await expect(page.getByText("Immutable closed handoff.", { exact: true })).toBeVisible();
    await expectAccessible(page);

    await page.goto("/relays?fixture=populated&relayFixture=legacy");
    await expect(page.getByText("Relay compatibility warning", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(
      "One or more legacy schema-v1 Relays have no canonical publication timestamp.",
      { exact: true },
    ).first()).toBeVisible();

    await page.locator(`[data-relay-id="${legacyRelayV2Id}"]`).click();
    let legacyDetail = page.getByRole("region", { name: "Selected handoff detail" });
    await expect(legacyDetail.getByRole("heading", {
      level: 2,
      name: "Review a timestamped legacy handoff with recorded Workstream context.",
    })).toBeVisible();
    await expect(legacyDetail.getByText("Team handoff", { exact: true })).toBeVisible();
    await expect(legacyDetail.getByRole("heading", { name: "Repository when published" })).toHaveCount(0);
    await expect(legacyDetail.getByText("Human-team memory", { exact: true })).toHaveCount(0);
    const v2Related = legacyDetail.getByRole("button", { name: "Related context" });
    await expect(v2Related).toHaveAttribute("aria-expanded", "false");
    await v2Related.click();
    await expect(legacyDetail.getByRole("heading", { name: "Legacy Workstream" })).toBeVisible();
    await expect(legacyDetail.getByText("Human-team memory", { exact: true })).toBeVisible();
    const v2Technical = legacyDetail.getByRole("button", { name: "Technical details" });
    await v2Technical.click();
    await expect(legacyDetail.getByText(/older Relay format.*did not record repository state at publication/i)).toBeVisible();

    await page.goto(`/relays?fixture=populated&relayFixture=legacy&view=mine&state=open&relay=${legacyRelayId}`);
    legacyDetail = page.getByRole("region", { name: "Selected handoff detail" });
    await expect(legacyDetail.getByRole("heading", {
      level: 2,
      name: "Review a legacy handoff whose original publication time was not recorded.",
    })).toBeVisible();
    await expect(legacyDetail.getByText(/Legacy publication time unavailable/)).toBeVisible();
    await expect(legacyDetail.getByRole("heading", { name: "Repository when published" })).toHaveCount(0);
    const v1Related = legacyDetail.getByRole("button", { name: "Related context" });
    await expect(v1Related).toHaveAttribute("aria-expanded", "false");
    await v1Related.click();
    await expect(legacyDetail.getByRole("heading", { name: "Legacy Workstream" })).toBeVisible();
    await expect(legacyDetail.getByText("Historical release", { exact: true })).toBeVisible();
    await expect(legacyDetail.getByRole("button", { name: "Take handoff" })).toBeVisible();
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    test(`saves and publishes an open-to-team Relay at ${viewport.width}px`, async ({ page }, testInfo) => {
      const errors = watchBrowserErrors(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize(viewport);
      await page.goto("/relays?fixture=populated&view=drafts");
      const create = page.getByRole("button", { name: "Create manually" });
      await create.focus();
      await page.keyboard.press("Enter");
      const composer = page.getByRole("dialog", { name: "Create handoff draft" });
      await expect(composer.getByRole("combobox", { name: "Who can take this handoff?" })).toHaveValue("team");
      await expect(composer.getByRole("combobox", { name: "Eligible recipients" })).toHaveCount(0);
      await expect(composer.getByText(/including teammates who join later/)).toBeVisible();
      await composer.getByRole("textbox", { name: "Summary" }).fill("Context for whoever picks up this work later");
      await expectNoHorizontalOverflow(page, viewport.width);
      await expectAccessible(page);
      await page.screenshot({ path: testInfo.outputPath("relay-team-draft.png"), fullPage: true });
      await composer.getByRole("button", { name: "Save draft" }).click();
      await expect(composer).toBeHidden();
      await expect(page).toHaveURL(/view=drafts.*draft=relay-draft-02/);
      const local = page.getByRole("region", { name: "Selected handoff draft detail" });
      await expect(local.getByRole("heading", { name: "Context for whoever picks up this work later" })).toBeVisible();
      await expect(local.getByText(/Saved only in this checkout/)).toBeVisible();
      await expect(local.getByText("Open to team", { exact: true })).toBeVisible();
      const publish = local.getByRole("button", { name: "Publish handoff" });
      await publish.click();
      const review = page.getByRole("alertdialog", { name: "Publish this handoff?" });
      await expect(review.getByText(/Any active Member, including teammates who join later/)).toBeVisible();
      await expect(review.getByText(/MEX does not verify delivery/)).toBeVisible();
      await expect.poll(() => review.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await expectNoHorizontalOverflow(page, viewport.width);
      await expectAccessible(page);
      await page.screenshot({ path: testInfo.outputPath("relay-team-publication-review.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await expect(review).toBeHidden();
      await expect(publish).toBeFocused();
      await publish.click();
      const confirm = review.getByRole("button", { name: "Publish handoff" });
      await expect(confirm).toBeEnabled();
      await confirm.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/view=sent.*relay=relay_02000000000000000000000001/);
      const published = page.getByRole("region", { name: "Selected handoff detail" });
      await expect(published.getByText("Published working-tree artifact.")).toBeVisible();
      await expect(published.getByText(/MEX has not verified commit, push, or receipt/)).toBeVisible();
      await expect(published.getByText(/including teammates who join later/)).toBeVisible();
      await expect(published.getByRole("button", { name: "Take handoff" })).toBeEnabled();
      await expectNoHorizontalOverflow(page, viewport.width);
      await expectAccessible(page);
      expect(errors).toEqual([]);
    });

    test(`reactivates an inactive Member with reviewed Git sharing at ${viewport.width}px`, async ({ page }, testInfo) => {
      const errors = watchBrowserErrors(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize(viewport);
      await page.goto(`/members?fixture=populated&status=inactive&member=${inactiveMemberId}`);
      const detail = page.getByRole("region", { name: "Selected Member detail" });
      await expect(detail.getByRole("heading", { name: "Lin Chen", exact: true })).toBeVisible();
      const reactivate = detail.getByRole("button", { name: "Reactivate Member" });
      await reactivate.focus();
      await page.keyboard.press("Enter");
      const review = page.getByRole("alertdialog", { name: "Reactivate Lin Chen?" });
      await expect(review.getByText(/Their identity and recorded history stay the same/)).toBeVisible();
      await expect(review.getByText(/Commit and push to share it through Git/)).toBeVisible();
      await expectNoHorizontalOverflow(page, viewport.width);
      await expectAccessible(page);
      await page.screenshot({ path: testInfo.outputPath("member-reactivation-review.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await expect(review).toBeHidden();
      await expect(reactivate).toBeFocused();
      await reactivate.click();
      const confirm = review.getByRole("button", { name: "Reactivate Member" });
      await expect(confirm).toBeEnabled();
      await confirm.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`status=active.*member=${inactiveMemberId}`));
      await expect(page.getByText("Member reactivated", { exact: true })).toBeVisible();
      await expect(detail.getByText("Active team member", { exact: true })).toBeVisible();
      await expect(detail.getByRole("button", { name: "Reactivate Member" })).toHaveCount(0);
      await expectNoHorizontalOverflow(page, viewport.width);
      await expectAccessible(page);
      expect(errors).toEqual([]);
    });
  }

  test("keeps Relay draft review, searchable recipients, disclosures, overflow, and focus complete", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/relays?fixture=populated&view=drafts&draft=${relayDraftId}`);

    await expect(page.getByRole("tab", { name: "Drafts on this device" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("group", { name: "Relay state" })).toHaveCount(0);
    const draft = page.locator(`[data-relay-draft-id="${relayDraftId}"]`);
    await expect(draft).toHaveAttribute("aria-current", "true");
    await expect(draft).not.toContainText("Workstream");
    const detail = page.getByRole("region", { name: "Selected handoff draft detail" });
    await expect(detail.getByRole("heading", {
      level: 2,
      name: "Carry the release evidence through the final cross-platform gate.",
    })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Publish handoff" })).toBeVisible();
    const edit = detail.getByRole("button", { name: "Edit wording" });
    const more = detail.getByRole("button", { name: "More draft actions" });
    await expect(edit).toBeVisible();
    await expect(more).toBeVisible();
    await expect(detail.getByRole("button", { name: "Related context" })).toHaveAttribute("aria-expanded", "false");
    await expect(detail.getByRole("button", { name: "Technical details" })).toHaveAttribute("aria-expanded", "false");
    await expect(detail.getByText(relayDraftId, { exact: true })).toHaveCount(0);

    await edit.click();
    const composer = page.getByRole("dialog", { name: "Edit handoff draft" });
    await expect(composer).toBeVisible();
    await expect.poll(() => composer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const recipients = composer.getByRole("combobox", { name: "Eligible recipients" });
    await expect(recipients).toBeVisible();
    await expect(composer.getByRole("combobox", { name: "Workstream" })).toHaveCount(0);
    await expect(composer.getByText("Grace Hopper", { exact: true })).toBeVisible();
    await recipients.click();
    await recipients.fill("Ada");
    await expect(page.getByRole("option", { name: "Ada Lovelace" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(composer.getByText("Ada Lovelace", { exact: true })).toBeVisible();
    await expect(composer.getByText("Grace Hopper", { exact: true })).toBeVisible();
    const additional = composer.getByRole("button", { name: "Additional context" });
    const advanced = composer.getByRole("button", { name: "Advanced" });
    await expect(additional).toHaveAttribute("aria-expanded", "false");
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await additional.click();
    await expect(composer.getByRole("button", { name: "Add completed" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "Add decision" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "Add code reference" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "Add evidence" })).toBeVisible();
    await expect(composer.getByText("Files involved", { exact: true })).toBeVisible();
    await expect(composer.getByText("Changed files", { exact: true })).toHaveCount(0);
    await advanced.click();
    await expect(composer.getByText(relayDraftId, { exact: true })).toBeVisible();
    await expect(composer.getByRole("textbox", { name: "Workstream ID" })).toHaveCount(0);
    await expect(composer.getByRole("textbox", { name: "Workstream title" })).toHaveCount(0);
    expect(requests).not.toContain("/api/v1/workstreams");
    await expectAccessible(page);
    await composer.getByRole("button", { name: "Cancel" }).click();
    await expect(composer).toBeHidden();
    await expect(edit).toBeFocused();

    await more.focus();
    await page.keyboard.press("Enter");
    const deleteItem = page.getByRole("menuitem", { name: "Delete draft" });
    await expect(deleteItem).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(deleteItem).toBeHidden();
    await expect(more).toBeFocused();
    await more.click();
    await page.getByRole("menuitem", { name: "Delete draft" }).click();
    const deletion = page.getByRole("alertdialog", { name: "Delete this handoff draft?" });
    await expect(deletion).toBeVisible();
    await expect.poll(() => deletion.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(deletion.getByRole("button", { name: "Technical details" })).toHaveAttribute("aria-expanded", "false");
    await expectAccessible(page);
    await deletion.getByRole("button", { name: "Keep reviewing" }).click();
    await expect(deletion).toBeHidden();
    await expect(more).toBeFocused();
    expect(errors).toEqual([]);
  });

  test("keeps Take, Close, and Publish confirmations concise and reports Git working-tree truth", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/relays?fixture=populated&view=mine&state=open&relay=${readyRelayId}`);

    const detail = page.getByRole("region", { name: "Selected handoff detail" });
    const take = detail.getByRole("button", { name: "Take handoff" });
    await take.click();
    const takeDialog = page.getByRole("alertdialog", { name: "Take this handoff?" });
    await expect(takeDialog).toBeVisible();
    await expect(takeDialog.getByText(/sole claimant/i)).toBeVisible();
    await expect(takeDialog.getByText(/no unclaim or reassignment/i)).toBeVisible();
    await expect(takeDialog.getByText(/pull the latest repository state/i)).toBeVisible();
    const takeTechnical = takeDialog.getByRole("button", { name: "Technical details" });
    await expect(takeTechnical).toHaveAttribute("aria-expanded", "false");
    await expect(takeDialog.getByText("relay.acknowledge", { exact: true })).toHaveCount(0);
    await expect.poll(() => takeDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(takeDialog).toBeHidden();
    await expect(take).toBeFocused();

    await take.click();
    await takeDialog.getByRole("button", { name: "Take handoff" }).click();
    const claimedNotice = page.getByText(
      "Handoff claimed in your working tree. Commit and push so the team can see that you took it.",
      { exact: true },
    );
    await expect(claimedNotice).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`view=mine.*state=open.*relay=${readyRelayId}`));

    await page.goto(`/relays?fixture=populated&view=sent&state=open&relay=${sentTakenRelayId}`);
    const close = page.getByRole("region", { name: "Selected handoff detail" })
      .getByRole("button", { name: "Close handoff" });
    await close.click();
    const closeDialog = page.getByRole("alertdialog", { name: "Close this handoff?" });
    await expect(closeDialog.getByText(/closing is irreversible/i)).toBeVisible();
    await expect(closeDialog.getByText(/saved handoff remains readable in project history/i)).toBeVisible();
    await expect(closeDialog.getByRole("button", { name: "Technical details" })).toHaveAttribute("aria-expanded", "false");
    await closeDialog.getByRole("button", { name: "Close handoff" }).click();
    await expect(page.getByText(
      "Handoff closed in your working tree. Commit and push to share the final state.",
      { exact: true },
    )).toBeVisible();
    await expect(page.getByRole("button", { name: "View closed" })).toBeVisible();
    await expect(page.locator(`[data-relay-id="${sentWaitingRelayId}"]`)).toHaveAttribute("aria-current", "true");
    await expect(page).toHaveURL(new RegExp(`view=sent.*state=open.*relay=${sentWaitingRelayId}`));

    await page.goto(`/relays?fixture=populated&view=drafts&draft=${relayDraftId}`);
    const publish = page.getByRole("button", { name: "Publish handoff" });
    await publish.click();
    const publishDialog = page.getByRole("alertdialog", { name: "Publish this handoff?" });
    await expect(publishDialog.getByText(/writes a Relay Markdown artifact in your working tree/i)).toBeVisible();
    await expect(publishDialog.getByText(/records branch, HEAD, clean or dirty state, and observation time/i)).toBeVisible();
    await expect(publishDialog.getByText(/does not create a commit or capture source-file or local-change contents/i)).toBeVisible();
    await expect(publishDialog.getByText(/Commit and push are still required/i)).toBeVisible();
    await expect(publishDialog.getByText(/codex\/hub-ux, HEAD aeaf0ab0, local changes present, observed/i)).toBeVisible();
    await expect(publishDialog.getByRole("button", { name: "Technical details" })).toHaveAttribute("aria-expanded", "false");
    await publishDialog.getByRole("button", { name: "Publish handoff" }).click();
    await expect(page.getByText(
      "Handoff created in your working tree. Commit and push it so teammates can receive it.",
      { exact: true },
    )).toBeVisible();
    await expect(page.getByRole("tab", { name: "Sent" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("group", { name: "Relay state" }).getByRole("button", { name: "Open" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/view=sent.*state=open.*relay=relay_02000000000000000000000001/);
    await expectAccessible(page);
    expect(errors).toEqual([]);
  });

  for (const viewport of [
    { width: 390, height: 900 },
    { width: 768, height: 900 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ] as const) {
    test(`keeps Relays guarded or overflow-free and accessible at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize(viewport);
      await page.goto("/relays?fixture=populated");

      if (viewport.width < 1024) {
        await expect(page.getByRole("heading", { name: "A wider workbench is required" })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
      } else {
        await expect(page.getByRole("heading", { level: 1, name: "Relays" })).toBeVisible();
        const queue = page.getByRole("region", { name: "Handoffs" });
        const detail = page.getByRole("region", { name: "Selected handoff detail" });
        await expect(queue.locator(`[data-relay-id="${readyRelayId}"]`)).toBeVisible();
        await queue.locator(`[data-relay-id="${readyRelayId}"]`).click();
        await expect(detail.getByRole("heading", {
          level: 2,
          name: "Release evidence is ready for the final cross-platform gate.",
        })).toBeVisible();
        const boxes = await Promise.all([queue.boundingBox(), detail.boundingBox()]);
        expect(boxes[0]).not.toBeNull();
        expect(boxes[1]).not.toBeNull();
        expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
        expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x + 1);
      }

      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: viewport.width,
        documentClientWidth: viewport.width,
        documentScrollWidth: viewport.width,
        bodyScrollWidth: viewport.width,
      });
      await expectAccessible(page);
    });
  }

  test("renders the deterministic Relays handoff visual", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/relays?fixture=populated&view=mine&state=open&relay=${readyRelayId}`);
    const detail = page.getByRole("region", { name: "Selected handoff detail" });
    await expect(detail.getByRole("heading", {
      level: 2,
      name: "Release evidence is ready for the final cross-platform gate.",
    })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "What to do next" })).toBeVisible();
    await expect(detail.getByText("Opening handoff details", { exact: true })).toHaveCount(0);
    if (hasReviewedHubVisualBaselines) {
      await expect(page).toHaveScreenshot("hub-relays.png", { fullPage: true });
    }
  });

  test("loads the Relay route and draft composer lazily without polling or external requests", async ({ page }) => {
    const requests: string[] = [];
    const external: string[] = [];
    const apiWrites: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      requests.push(`${request.method()} ${url.pathname}${url.search}`);
      if (url.hostname !== "127.0.0.1") external.push(request.url());
      if (url.pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        apiWrites.push(`${request.method()} ${url.pathname}`);
      }
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?fixture=populated");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    expect(requests.some((request) => request.includes("/src/pages/RelayPage.tsx"))).toBe(false);

    await page.getByRole("link", { name: /^Relays(?: |$)/ }).click();
    await expect(page.locator('[data-relay-workbench="ready"]')).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(requests.filter((request) => request.includes("/src/pages/RelayPage"))).toHaveLength(1);
    expect(requests.some((request) => request.includes("/src/pages/RelayDraftComposer"))).toBe(false);
    expect(requests.some((request) => request.includes("/src/pages/RelayDetailSections"))).toBe(false);
    await page.getByRole("tab", { name: "Drafts on this device" }).click();
    await expect(page.locator(`[data-relay-draft-id="${relayDraftId}"]`)).toBeVisible();
    expect(new URL(page.url()).searchParams.has("draft")).toBe(false);
    await expect(page.getByRole("region", { name: "Selected handoff draft detail" })
      .getByText("Choose a handoff draft", { exact: true })).toBeVisible();
    expect(requests.some((request) => request.includes("/src/pages/RelayDraftComposer"))).toBe(false);
    expect(requests.some((request) => request.includes("/src/pages/RelayDetailSections"))).toBe(false);
    await page.locator(`[data-relay-draft-id="${relayDraftId}"]`).click();
    await expect.poll(() => requests.filter((request) => request.includes("/src/pages/RelayDetailSections")).length)
      .toBe(1);
    await page.getByRole("button", { name: "Edit wording" }).click();
    const composer = page.getByRole("dialog", { name: "Edit handoff draft" });
    await expect(composer).toBeVisible();
    await expect.poll(() => requests.filter((request) => request.includes("/src/pages/RelayDraftComposer")).length)
      .toBe(1);
    await expect(composer.getByRole("combobox", { name: "Workstream" })).toHaveCount(0);
    await expect(composer.getByRole("textbox", { name: "Workstream ID" })).toHaveCount(0);
    expect(requests.filter((request) => /GET \/api\/v1\/workstreams(?:\?|$)/.test(request))).toEqual([]);
    const relayReadCount = requests.filter((request) => /GET \/api\/v1\/relays(?:\/drafts)?(?:\?|$)/.test(request)).length;
    await page.waitForTimeout(5_500);
    expect(requests.filter((request) => /GET \/api\/v1\/relays(?:\/drafts)?(?:\?|$)/.test(request))).toHaveLength(relayReadCount);
    expect(apiWrites).toEqual([]);
    expect(external).toEqual([]);
  });

  test("renders the exact sidebar IA and keeps disclosures independent and reload-local", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?fixture=populated");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();

    const sidebar = page.locator('aside[aria-label="Project Hub navigation"]');
    const primary = page.getByRole("navigation", { name: "Primary" });
    const utilities = page.getByRole("navigation", { name: "Project utilities" });
    const projectMemory = primary.getByRole("region", { name: "Project", exact: true });
    const teamwork = primary.getByRole("region", { name: "Teamwork" });
    const system = utilities.getByRole("region", { name: /^System/ });
    const projectMemoryDisclosure = projectMemory.getByRole("button", { name: "Project", exact: true });
    const teamworkDisclosure = teamwork.getByRole("button", { name: "Teamwork" });
    const systemDisclosure = system.getByRole("button", { name: /^System/ });

    await expect(sidebar.getByRole("link", { name: "Search project", exact: true }))
      .toHaveAttribute("aria-keyshortcuts", "/");
    await expect(projectMemoryDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(teamworkDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(systemDisclosure).toHaveAttribute("aria-expanded", "false");

    await systemDisclosure.click();
    const primaryItems = await primary.getByRole("link").evaluateAll((links) => links.map((link) => ({
      href: link.getAttribute("href"),
      label: [...link.children].find((child) => (
        child.tagName === "SPAN" && !child.hasAttribute("data-slot")
      ))?.textContent,
    })));
    expect(primaryItems).toEqual([
      { href: "/", label: "Overview" },
      { href: "/knowledge", label: "Context" },
      { href: "/code", label: "Code" },
      { href: "/inbox", label: "Inbox" },
      { href: "/relays", label: "Relays" },
      { href: "/activity", label: "Activity" },
      { href: "/members", label: "Team" },
    ]);
    const utilityItems = await utilities.getByRole("link").evaluateAll((links) => links.map((link) => ({
      href: link.getAttribute("href"),
      label: [...link.children].find((child) => (
        child.tagName === "SPAN" && !child.hasAttribute("data-slot")
      ))?.textContent,
    })));
    expect(utilityItems).toEqual([
      { href: "/health", label: "Health" },
      { href: "/settings", label: "Settings" },
      { href: "/jobs", label: "Jobs" },
    ]);

    await projectMemoryDisclosure.click();
    await expect(projectMemoryDisclosure).toHaveAttribute("aria-expanded", "false");
    await expect(teamworkDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(systemDisclosure).toHaveAttribute("aria-expanded", "true");

    await page.reload();
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    await expect(projectMemoryDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(teamworkDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(systemDisclosure).toHaveAttribute("aria-expanded", "false");
  });

  test("opens deep-linked groups, preserves nested aria-current, and marks a collapsed active group", async ({ page }) => {
    await page.goto("/knowledge/mx_01K36WVM6H7JK8M9NPQRSTVVWX?fixture=populated");
    const projectMemory = page.getByRole("region", { name: "Project", exact: true });
    const projectMemoryDisclosure = projectMemory.getByRole("button", { name: "Project", exact: true });
    await expect(projectMemoryDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(projectMemory.getByRole("link", { name: "Context", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await projectMemoryDisclosure.click();
    await expect(projectMemoryDisclosure).toHaveAttribute("aria-expanded", "false");
    await expect(projectMemoryDisclosure).toHaveAttribute("data-active", "true");

    await page.goto("/code/symbols/sym.createHubServer?fixture=populated");
    await expect(page.getByRole("region", { name: "Project", exact: true })
      .getByRole("link", { name: "Code", exact: true })).toHaveAttribute("aria-current", "page");

    await page.goto("/jobs?fixture=populated");
    const system = page.getByRole("region", { name: /^System/ });
    await expect(system.getByRole("button", { name: /^System/ })).toHaveAttribute("aria-expanded", "true");
    await expect(system.getByRole("link", { name: "Jobs", exact: true })).toHaveAttribute("aria-current", "page");

    await page.goto("/catch-up?fixture=populated");
    await expect(page.getByText(
      "A personalized summary of project changes and team activity is planned but is not available in this release.",
      { exact: true },
    )).toBeVisible();
  });

  test("routes the slash launcher to Search, preserves the query, and allows Shift", async ({ page }) => {
    await page.goto("/?fixture=populated");
    await page.keyboard.press("/");
    await expect(page).toHaveURL(/\/search$/);
    const searchbox = page.getByRole("searchbox", { name: "Search project memory and code" });
    await expect(searchbox).toBeFocused();
    await searchbox.fill("hub");

    await page.locator("#main-content").focus();
    await page.keyboard.press("/");
    await expect(searchbox).toBeFocused();
    await expect(searchbox).toHaveValue("hub");

    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page.locator("#main-content")).toBeFocused();
    await page.getByRole("link", { name: "Search project", exact: true }).click();
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.locator("#main-content")).toBeFocused();
    await expect(searchbox).not.toBeFocused();

    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("#main-content")).toBeFocused();
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "/",
      shiftKey: true,
    })));
    await expect(page).toHaveURL(/\/search$/);
    await expect(searchbox).toBeFocused();
  });

  test("suppresses the slash shortcut in editables, dialogs, and with command modifiers", async ({ page }) => {
    await page.goto("/?fixture=populated");
    await page.evaluate(() => {
      const textarea = document.createElement("textarea");
      textarea.id = "shortcut-textarea";
      const select = document.createElement("select");
      select.id = "shortcut-select";
      select.append(new Option("Option", "option"));
      const editable = document.createElement("div");
      editable.id = "shortcut-contenteditable";
      editable.contentEditable = "true";
      document.body.append(textarea, select, editable);
    });
    for (const id of ["shortcut-textarea", "shortcut-select", "shortcut-contenteditable"] as const) {
      await page.locator(`#${id}`).focus();
      await page.keyboard.press("/");
      await expect(page).toHaveURL(/\/\?fixture=populated$/);
    }
    await page.locator("#main-content").focus();
    for (const key of ["Control+/", "Meta+/", "Alt+/"] as const) {
      await page.keyboard.press(key);
      await expect(page).toHaveURL(/\/\?fixture=populated$/);
    }

    await page.goto("/members?fixture=populated");
    await page.getByRole("button", { name: "Add member" }).click();
    const dialog = page.getByRole("dialog", { name: "Add team member" });
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const membersUrl = page.url();
    await cancel.focus();
    await page.keyboard.press("/");
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(membersUrl);
  });

  test("exposes neutral queue counts, team identity, and exact locality guidance", async ({ page }) => {
    await page.goto("/?fixture=populated");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    const sidebar = page.locator('aside[aria-label="Project Hub navigation"]');
    await expect(sidebar.getByLabel("3 proposals for team review.")).toHaveText("3");
    await expect(sidebar.getByLabel("2 open Relays for you.")).toHaveText("2");
    await expect(sidebar.getByLabel("1 active system operations.")).toHaveText("1");
    await expect(sidebar.getByRole("link", { name: "Team", exact: true })).toHaveAttribute("href", "/members");
    await expect(sidebar.getByText("Ada Lovelace", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Runs locally", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Shared records use Git", { exact: true })).toBeVisible();
    const locality = sidebar.getByRole("note", { name: "Runs locally. Shared records use Git." });
    const localityExplanation = "MEX runs on this device. Canonical team records are shared when committed and pushed; drafts and indexes remain local to this checkout.";
    await locality.focus();
    await expect(locality).toHaveAccessibleDescription(localityExplanation);
    await expect(page.getByRole("tooltip")).toHaveText(localityExplanation);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toBeHidden();
    await expectAccessible(page);
  });

  test("keeps both fully expanded and fully collapsed sidebar states accessible", async ({ page }) => {
    await page.goto("/?fixture=populated");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    const disclosures = {
      projectMemory: page.getByRole("button", { name: "Project", exact: true }),
      teamwork: page.getByRole("button", { name: "Teamwork" }),
      system: page.getByRole("button", { name: /^System/ }),
    };
    await disclosures.system.click();
    for (const disclosure of Object.values(disclosures)) {
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    }
    await expectAccessible(page);

    for (const disclosure of Object.values(disclosures)) await disclosure.click();
    for (const disclosure of Object.values(disclosures)) {
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    }
    await expectAccessible(page);
  });

  test("captures the populated sidebar with Inbox and Relay counts", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?fixture=populated");
    await page.getByRole("button", { name: /^System/ }).click();
    const sidebar = page.locator('aside[aria-label="Project Hub navigation"]');
    await expect(sidebar.getByRole("link", { name: "Context", exact: true })).toBeVisible();
    await expect(sidebar.getByLabel("1 active system operations.")).toBeVisible();
    if (hasReviewedHubVisualBaselines) {
      await expect(sidebar).toHaveScreenshot("hub-sidebar-populated.png");
    }
  });

  test("supports keyboard routing, focus restoration, every shell, and 404", async ({ page }) => {
    await page.goto("/?fixture=populated");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();

    const routes = [
      [/^Context$/, "Context"],
      [/^Code$/, "Code"],
      [/^Relays(?: |$)/, "Relays"],
      [/^Activity$/, "Activity"],
    ] as const;
    for (const [link, heading] of routes) {
      await page.getByRole("link", { name: link }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.locator("#main-content")).toBeFocused();
    }

    for (const [route, heading, copy] of [
      ["/playbooks", "Playbooks", "Reusable team workflows are planned but are not available in this release."],
      ["/catch-up", "Catch Up", "A personalized summary of project changes and team activity is planned but is not available in this release."],
    ] as const) {
      await page.goto(`${route}?fixture=populated`);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.getByText(copy, { exact: true })).toBeVisible();
    }

    await page.getByRole("link", { name: "Team", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.locator("#main-content")).toBeFocused();
    await page.getByRole("button", { name: /^System/ }).click();
    for (const heading of ["Health", "Settings", "Jobs"] as const) {
      await page.getByRole("link", { name: heading, exact: true }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.locator("#main-content")).toBeFocused();
    }

    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    await expect(page.locator("#main-content")).toBeFocused();
    await page.goto("/outside-the-workbench?fixture=populated");
    await expect(page.getByText("404", { exact: true })).toBeVisible();
  });

  for (const width of [390, 768, 1023] as const) {
    test(`uses the desktop guard at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/?fixture=populated");
      await expect(page.getByRole("heading", { name: "A wider workbench is required" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: width,
        documentClientWidth: width,
        documentScrollWidth: width,
        bodyScrollWidth: width,
      });
      await expectAccessible(page);
    });
  }

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 1024, height: 520 },
  ] as const) {
    test(`fits the complete desktop workbench at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/?fixture=populated");
      await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();

      const sidebarLocator = page.locator('aside[aria-label="Project Hub navigation"]');
      const navViewport = sidebarLocator.locator('[data-sidebar-scroll="true"]');
      const footer = sidebarLocator.locator("footer");
      const sidebar = await sidebarLocator.boundingBox();
      const scroller = await navViewport.boundingBox();
      const footerBeforeScroll = await footer.boundingBox();
      expect(sidebar?.width).toBe(232);
      expect(sidebar?.x).toBe(0);
      expect(sidebar?.height).toBe(viewport.height);
      expect(scroller).not.toBeNull();
      expect(footerBeforeScroll).not.toBeNull();
      expect(scroller!.y + scroller!.height).toBeLessThanOrEqual(footerBeforeScroll!.y + 1);
      expect(footerBeforeScroll!.y + footerBeforeScroll!.height).toBeLessThanOrEqual(viewport.height + 1);
      await expect(sidebarLocator.getByText("Runs locally", { exact: true })).toBeVisible();

      await navViewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(page.getByRole("link", { name: "Activity", exact: true })).toBeVisible();
      await expect(sidebarLocator.getByText("Runs locally", { exact: true })).toBeVisible();
      const footerAfterScroll = await footer.boundingBox();
      expect(footerAfterScroll?.y).toBe(footerBeforeScroll?.y);
      const geometry = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      expect(geometry).toEqual({
        viewportWidth: viewport.width,
        documentClientWidth: viewport.width,
        documentScrollWidth: viewport.width,
        bodyScrollWidth: viewport.width,
      });
    });
  }

  test("suppresses computed transitions and animation under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/jobs?fixture=populated");
    await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();

    const navTransitionDuration = await page.getByRole("link", { name: "Overview", exact: true })
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    const spinner = page.locator("svg.lucide-loader-circle").first();
    await expect(spinner).toBeVisible();
    const spinnerMotion = await spinner.evaluate((element) => {
      const style = getComputedStyle(element);
      return { animationName: style.animationName, animationDuration: style.animationDuration };
    });

    expect(Number.parseFloat(navTransitionDuration)).toBeLessThanOrEqual(0.00001);
    expect(spinnerMotion.animationName).toBe("none");
    expect(Number.parseFloat(spinnerMotion.animationDuration)).toBeLessThanOrEqual(0.00001);
  });

  test("never requests an external asset or API", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (request) => {
      const host = new URL(request.url()).hostname;
      if (host !== "127.0.0.1") external.push(request.url());
    });
    await page.goto("/?fixture=populated");
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    await page.goto("/activity?fixture=populated");
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await page.goto("/members?fixture=populated");
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await page.goto("/knowledge?fixture=populated&view=list");
    await expect(page.getByRole("heading", { name: "Context", exact: true })).toBeVisible();
    await page.getByRole("link", { name: /Project Hub read boundaries/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Project Hub read boundaries" })).toBeVisible();
    await page.goto("/code?fixture=populated&q=hub");
    await expect(page.getByRole("heading", { name: "Code symbols" })).toBeVisible();
    await page.getByRole("link", { name: /createHubServer/ }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "createHubServer" })).toBeVisible();
    expect(external).toEqual([]);
  });
});

test.describe("built production Hub", () => {
  test.describe.configure({ mode: "serial" });
  let processHandle: ChildProcess | undefined;
  let projectRoot: string | undefined;
  let bootstrapUrl: string;

  test.beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), "mex-hub-browser-"));
    mkdirSync(join(projectRoot, ".mex"), { recursive: true });
    writeFileSync(join(projectRoot, ".mex", "ROUTER.md"), "# Browser fixture\n");
    writeFileSync(
      join(projectRoot, ".mex", "config.json"),
      JSON.stringify({
        scaffold_id: "22222222-2222-4222-8222-222222222222",
        scaffold_name: "production-hub-fixture",
      }, null, 2) + "\n",
    );
    writeProductionActivity(projectRoot);
    const git = spawnSync("git", ["init", "--quiet"], { cwd: projectRoot, encoding: "utf8" });
    if (git.status !== 0) throw new Error(git.stderr);
    for (const [command, args] of [
      ["git", ["config", "user.name", "MEX Browser Fixture"]],
      ["git", ["config", "user.email", "hub-browser@example.invalid"]],
      ["git", ["add", "--", ".mex"]],
      ["git", ["commit", "--quiet", "--no-gpg-sign", "--message", "browser fixture"]],
    ] as const) {
      const result = spawnSync(command, args, { cwd: projectRoot, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    processHandle = spawn(process.execPath, [join(root, "dist", "cli.js"), "hub", "--no-open"], {
      cwd: projectRoot,
      env: { ...process.env, MEX_TELEMETRY: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    bootstrapUrl = await readBootstrapUrl(processHandle);
  });

  test.afterAll(async () => {
    if (processHandle?.exitCode === null) {
      processHandle.kill("SIGTERM");
      await waitForExit(processHandle, 8_000);
    }
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  test("bootstraps once, stays exact-origin and idle, and never exposes fixture content", async ({ page }) => {
    const errors = watchBrowserErrors(page);
    const consoleErrorUrls: string[] = [];
    const failedResponses: Array<{
      url: string;
      method: string;
      status: number;
      contentType: string | undefined;
      body: Promise<unknown>;
    }> = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrorUrls.push(message.location().url);
    });
    page.on("response", (candidate) => {
      if (candidate.status() < 400) return;
      failedResponses.push({
        url: candidate.url(),
        method: candidate.request().method(),
        status: candidate.status(),
        contentType: candidate.headers()["content-type"],
        body: candidate.json().catch(() => ({ invalidProblemBody: true })),
      });
    });
    const productionOrigin = new URL(bootstrapUrl).origin;
    const crossOriginRequests: string[] = [];
    const teamAccessDialogRequests: string[] = [];
    const idleApiRequests: string[] = [];
    const relayDraftRequests: string[] = [];
    const relayWorkstreamRequests: string[] = [];
    let observeIdleApi = false;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== productionOrigin) crossOriginRequests.push(request.url());
      if (/\/TeamAccessDialog-[^/]+\.js$/u.test(url.pathname)) teamAccessDialogRequests.push(request.url());
      if (url.origin === productionOrigin && url.pathname === "/api/v1/relays/drafts") {
        relayDraftRequests.push(request.url());
      }
      if (url.origin === productionOrigin && url.pathname.startsWith("/api/v1/workstreams")) {
        relayWorkstreamRequests.push(request.url());
      }
      if (observeIdleApi && url.origin === productionOrigin && url.pathname.startsWith("/api/")) {
        idleApiRequests.push(`${request.method()} ${url.pathname}${url.search}`);
      }
    });
    const response = await page.goto(bootstrapUrl);
    await expect(page.locator('[data-overview-workbench="ready"]')).toBeVisible();
    await expect.poll(() => page.url()).not.toContain("#token=");
    expect(teamAccessDialogRequests).toEqual([]);
    const requestAccess = page.getByRole("button", { name: "Request access", exact: true });
    await requestAccess.click();
    const teamAccessDialog = page.getByRole("dialog", { name: "Request access", exact: true });
    await expect(teamAccessDialog).toBeVisible();
    await expect(teamAccessDialog.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
    expect(teamAccessDialogRequests).toHaveLength(1);
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expectAccessible(page);
      await expectNoHorizontalOverflow(page, width);
    }
    await page.keyboard.press("Escape");
    await expect(teamAccessDialog).toBeHidden();
    await expect(requestAccess).toBeFocused();
    await expect(page.getByRole("link", { name: "Context", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Code", exact: true })).toBeVisible();
    await expect(page.getByText("Three knowledge pages lost grounding")).toHaveCount(0);

    await page.goto(`${new URL(bootstrapUrl).origin}/?fixture=populated`);
    await expect(page.getByText("Three knowledge pages lost grounding")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Context", exact: true })).toBeVisible();

    const [knowledgeUnavailable] = await Promise.all([
      page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/v1/wiki/graph"),
      page.goto(`${new URL(bootstrapUrl).origin}/knowledge?fixture=populated`),
    ]);
    expect(knowledgeUnavailable.status()).toBe(503);
    await expect(page.getByRole("heading", { name: "Context", exact: true })).toBeVisible();
    await expect(page.getByText("Project Hub read boundaries", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Context unavailable", exact: true })).toBeVisible();

    await page.goto(`${new URL(bootstrapUrl).origin}/code?fixture=populated`);
    await expect(page.getByRole("heading", { name: "Code" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Search symbols and source" })).toBeVisible();
    await expect(page.getByText("createHubServer", { exact: true })).toHaveCount(0);

    await page.goto(`${new URL(bootstrapUrl).origin}/activity?fixture=populated`);
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recorded “production.real_read”", exact: true })).toBeVisible();
    await expect(page.getByText("Production legacy decision", { exact: true })).toBeVisible();
    await expect(page.getByText("Proposed a Spec change", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Keep activity immutable and preserve Project notes", { exact: false })).toHaveCount(0);
    await expect(page.getByText("production metadata sentinel", { exact: true })).toHaveCount(0);
    await expect(page.getByText("/private/production/path", { exact: true })).toHaveCount(0);
    await expect(page.getByText(".mex/traces/production-private.md", { exact: true })).toHaveCount(0);
    await page.goto(`${new URL(bootstrapUrl).origin}/members?fixture=populated`);
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.getByText("Ada Lovelace", { exact: true })).toHaveCount(0);
    await expect(page.getByText("member_01K36WVM6H7JK8M9NPQRSTVVWX", { exact: true })).toHaveCount(0);
    const [proposalsResponse] = await Promise.all([
      page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/v1/inbox/proposals"),
      page.goto(`${productionOrigin}/inbox?fixture=populated`),
    ]);
    expect(proposalsResponse.status()).toBe(200);
    expect(await proposalsResponse.json()).toMatchObject({ items: [], nextCursor: null });
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await expect(page.locator('[data-inbox-workbench="ready"]')).toBeVisible();
    const draftsResponsePromise = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/api/v1/inbox/drafts",
    );
    await page.getByRole("tab", { name: "Drafts on this device" }).click();
    const draftsResponse = await draftsResponsePromise;
    expect(draftsResponse.status()).toBe(200);
    expect(await draftsResponse.json()).toMatchObject({ items: [], nextCursor: null });

    const [relayListResponse] = await Promise.all([
      page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/v1/relays"),
      page.goto(`${productionOrigin}/relays?fixture=populated`),
    ]);
    expect(relayListResponse.status()).toBe(200);
    expect(Object.fromEntries(new URL(relayListResponse.url()).searchParams)).toEqual({
      perspective: "all",
      state: "published,acknowledged",
      limit: "25",
    });
    expect(await relayListResponse.json()).toMatchObject({ items: [], nextCursor: null });
    await expect(page.getByRole("heading", { level: 1, name: "Relays" })).toBeVisible();
    await expect(page.locator('[data-relay-workbench="ready"]')).toBeVisible();
    await expect(page.getByRole("tab", { name: "Team" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("group", { name: "Relay state" }).getByRole("button", { name: "Open" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(relayDraftRequests).toEqual([]);

    const relayDraftsResponsePromise = page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/api/v1/relays/drafts",
    );
    await page.getByRole("tab", { name: "Drafts on this device" }).click();
    const relayDraftsResponse = await relayDraftsResponsePromise;
    expect(relayDraftsResponse.status()).toBe(200);
    expect(Object.fromEntries(new URL(relayDraftsResponse.url()).searchParams)).toEqual({ limit: "25" });
    expect(await relayDraftsResponse.json()).toMatchObject({ items: [], nextCursor: null });
    expect(relayDraftRequests).toHaveLength(1);

    const createManually = page.getByRole("button", { name: "Create manually" });
    await expect(createManually).toBeEnabled();
    await createManually.click();
    const relayComposer = page.getByRole("dialog", { name: "Create handoff draft" });
    await expect(relayComposer).toBeVisible();
    await expect(relayComposer.getByRole("combobox", { name: "Who can take this handoff?" })).toHaveValue("team");
    await expect(relayComposer.getByRole("combobox", { name: "Eligible recipients" })).toHaveCount(0);
    await expect(relayComposer.getByRole("combobox", { name: "Workstream" })).toHaveCount(0);
    await expect(relayComposer.getByRole("textbox", { name: "Workstream ID" })).toHaveCount(0);
    expect(relayWorkstreamRequests).toEqual([]);
    await relayComposer.getByRole("button", { name: "Cancel" }).click();
    await expect(relayComposer).toBeHidden();

    await page.waitForLoadState("networkidle");
    if (!projectRoot) throw new Error("The production Hub fixture root is unavailable.");
    const beforeIdle = snapshotReleaseProtectedState(projectRoot);
    expect(beforeIdle.indexFiles).toEqual([]);
    observeIdleApi = true;
    await page.waitForTimeout(5_500);
    observeIdleApi = false;
    expect(idleApiRequests).toEqual([]);
    expect(snapshotReleaseProtectedState(projectRoot)).toEqual(beforeIdle);
    expect(crossOriginRequests).toEqual([]);
    expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
    await expectAccessible(page);
    // Each of the eight full-page navigations discovers that this operational
    // process has no setup wizard. Its legacy Wiki scaffold needs migration. Accept
    // only those exact failures, with their real endpoint and Problem Details.
    const expectedFailures = [
      ...Array.from({ length: 8 }, () => `${productionOrigin}/api/v1/setup`),
      `${productionOrigin}/api/v1/wiki/graph`,
    ].sort();
    expect(failedResponses.map((candidate) => candidate.url).sort()).toEqual(expectedFailures);
    for (const candidate of failedResponses) {
      const setup = new URL(candidate.url).pathname === "/api/v1/setup";
      expect(candidate.method).toBe("GET");
      expect(candidate.status).toBe(503);
      expect(candidate.contentType).toBe("application/problem+json; charset=UTF-8");
      expect(await candidate.body).toEqual({
        type: "about:blank",
        title: setup ? "Capability unavailable" : "Migration required",
        status: 503,
        code: setup ? "CAPABILITY_UNAVAILABLE" : "MIGRATION_REQUIRED",
        detail: setup ? "Setup is not available in this Hub process." : "The local state requires an explicit supported migration.",
        instance: new URL(candidate.url).pathname,
        requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      });
    }
    expect(consoleErrorUrls.sort()).toEqual(expectedFailures);
    expect(errors).toEqual(expectedFailures.map(() =>
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    ));
  });
});

function snapshotReleaseProtectedState(projectRoot: string): {
  canonical: Record<string, string>;
  gitStatus: string;
  indexFiles: string[];
} {
  const canonicalPaths = [
    ".mex/ROUTER.md",
    ".mex/config.json",
    ".mex/events/activity/2026-08/event_01K3Q080000000000000000004.md",
    ".mex/events/decisions.jsonl",
  ];
  const gitStatus = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  if (gitStatus.status !== 0) throw new Error(gitStatus.stderr);
  return {
    canonical: Object.fromEntries(canonicalPaths.map((path) => [
      path,
      readFileSync(join(projectRoot, path), "utf8"),
    ])),
    gitStatus: gitStatus.stdout,
    indexFiles: readdirSync(join(projectRoot, ".mex"))
      .filter((name) => name.startsWith("graph.db") || name.startsWith("wiki.db"))
      .sort(),
  };
}

function writeProductionActivity(projectRoot: string): void {
  const eventId = "event_01K3Q080000000000000000004";
  const month = join(projectRoot, ".mex", "events", "activity", "2026-08");
  mkdirSync(month, { recursive: true });
  writeFileSync(join(month, `${eventId}.md`), [
    "---",
    "schema_version: 1",
    `id: ${JSON.stringify(eventId)}`,
    "timestamp: \"2026-08-23T03:00:00.000Z\"",
    "actor: {\"kind\":\"unknown\"}",
    "action: \"production.real_read\"",
    "subjects: [{\"kind\":\"file\",\"path\":\"src/production.ts\"}]",
    "repo_state: {\"branch\":null,\"dirty\":false,\"head\":null,\"observedAt\":\"2026-08-23T02:59:59.000Z\"}",
    "metadata: {\"internal_note\":\"production metadata sentinel\"}",
    "---",
    "",
  ].join("\n"));
  writeFileSync(join(projectRoot, ".mex", "events", "decisions.jsonl"), `${JSON.stringify({
    timestamp: "2026-08-22T03:00:00.000Z",
    kind: "decision",
    message: "Production legacy decision",
    files: ["src/production.ts"],
    cwd: "/private/production/path",
    trace: ".mex/traces/production-private.md",
  })}\n`);
}

function readBootstrapUrl(processHandle: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for Hub startup.\n${stderr}`));
    }, 30_000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(/https?:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_%~-]+/);
      if (match) {
        cleanup();
        resolveUrl(match[0]);
      }
    };
    const onStderr = (chunk: Buffer) => { stderr += chunk.toString("utf8"); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Hub exited before startup (${code ?? signal}).\n${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      processHandle.stdout?.off("data", onStdout);
      processHandle.stderr?.off("data", onStderr);
      processHandle.off("exit", onExit);
    };
    processHandle.stdout?.on("data", onStdout);
    processHandle.stderr?.on("data", onStderr);
    processHandle.once("exit", onExit);
  });
}

function waitForExit(processHandle: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolveExit, reject) => {
    if (processHandle.exitCode !== null) {
      resolveExit();
      return;
    }
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
      reject(new Error("Timed out waiting for Hub shutdown."));
    }, timeoutMs);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}
