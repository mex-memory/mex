import { releaseWorkbenchPaths } from "./routes.mjs";
import { assertInboxFixturePage, assertRelayFixturePage } from "./hub.mjs";

const PAGE_READY_TIMEOUT_MS = 30_000;

/**
 * Measure each workbench in a new browser context so route-to-route caches do
 * not make later pages look artificially small. The request audit is part of
 * the benchmark contract: a release benchmark must fail if a production Hub
 * workbench contacts anything other than the exact loopback Hub origin.
 */
export async function measureWorkbenchHeap({
  server,
  auth,
  samples,
  knowledgeEntityId,
  specEntityId,
  codeSymbolId,
  inboxDraftId,
  inboxDraftTitle,
  inboxProposalId,
  inboxProposalTitle,
  relayDraftId,
  relayDraftSummary,
  relayId,
  relaySummary,
}) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  const workbenchPaths = releaseWorkbenchPaths({
    knowledgeEntityId,
    specEntityId,
    codeSymbolId,
  });
  const measurements = Object.fromEntries(
    Object.keys(workbenchPaths).map((route) => [route, []]),
  );
  const observedRequests = new Set();
  try {
    for (let sample = 0; sample < samples; sample += 1) {
      for (const [route, path] of Object.entries(workbenchPaths)) {
        const context = await browser.newContext({
          reducedMotion: "reduce",
          serviceWorkers: "block",
          viewport: { width: 1440, height: 1000 },
        });
        const outbound = new Set();
        context.on("request", (request) => {
          const url = new URL(request.url());
          observedRequests.add(`${request.method()} ${url.pathname}`);
          if (url.origin !== server.origin) outbound.add(request.url());
        });
        await addApiCookie(context, server.origin, auth.cookie);
        const page = await context.newPage();
        try {
          const response = await page.goto(`${server.origin}${path}`, {
            waitUntil: "networkidle",
            timeout: PAGE_READY_TIMEOUT_MS,
          });
          if (!response?.ok()) {
            throw new Error(`${route} returned HTTP ${String(response?.status() ?? "none")}.`);
          }
          await assertReleaseRouteReady(page, route, {
            inboxDraftId,
            inboxDraftTitle,
            inboxProposalId,
            inboxProposalTitle,
            relayDraftId,
            relayDraftSummary,
            relayId,
            relaySummary,
          });
          // Give React one task turn to commit route content after network idle.
          await page.waitForTimeout(50);
          if (outbound.size > 0) {
            throw new Error(
              `${route} made outbound requests: ${[...outbound].sort().slice(0, 10).join(", ")}`,
            );
          }
          const cdp = await context.newCDPSession(page);
          await cdp.send("HeapProfiler.collectGarbage");
          const heap = await cdp.send("Runtime.getHeapUsage");
          if (!Number.isFinite(heap.usedSize) || heap.usedSize < 0) {
            throw new Error(`${route} returned an invalid browser heap measurement.`);
          }
          measurements[route].push(heap.usedSize);
          await cdp.detach();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  return {
    measurements,
    outboundRequestCount: 0,
    observedLoopbackRequests: [...observedRequests].sort().slice(0, 100),
  };
}

export async function assertReleaseRouteReady(page, route, teamFixture) {
  if (route === "home") {
    await page.locator('[data-overview-workbench="ready"]')
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
  }
  if (route === "knowledge") {
    const graph = page.getByLabel("Context graph", { exact: true });
    await graph.waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await graph.getByRole("button", { name: /^Release benchmark knowledge 0000 · /u })
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
  }
  if (route === "workstreams") {
    await page.getByRole("heading", { name: "Release benchmark Workstream", exact: true })
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
  }
  if (route === "specs" || route === "specsDetail") {
    await page.getByRole("heading", { name: "Release benchmark knowledge 0000", exact: true })
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await page.getByText("Release benchmark knowledge 0001", { exact: true })
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
  }
  if (route === "inbox") {
    const draft = page.locator(`[data-inbox-draft-id="${teamFixture.inboxDraftId}"]`);
    const proposal = page.locator(`[data-inbox-proposal-id="${teamFixture.inboxProposalId}"]`);
    await page.locator('[data-inbox-workbench="ready"]')
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await proposal.waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await proposal.getByText(teamFixture.inboxProposalTitle, { exact: true })
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await page.getByRole("tab", { name: "Drafts on this device", exact: true }).click();
    await draft.waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await draft.getByText(teamFixture.inboxDraftTitle, { exact: true })
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    // Restore the primary review surface before measuring the route heap. This
    // still proves the secondary checkout-local fixture through the real UI.
    await page.getByRole("tab", { name: /^For review\b/u }).click();
    await proposal.waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    const [draftResponse, proposalResponse] = await page.evaluate(async () => Promise.all([
      "/api/v1/inbox/drafts?limit=25",
      "/api/v1/inbox/proposals?state=pending,stale&limit=25",
    ].map(async (path) => {
      const response = await fetch(path, {
        headers: { accept: "application/json, application/problem+json" },
      });
      return { status: response.status, body: await response.json() };
    })));
    if (draftResponse.status !== 200 || proposalResponse.status !== 200) {
      throw new Error("The Inbox route fixture APIs did not both return HTTP 200.");
    }
    const draftPage = draftResponse.body;
    const proposalPage = proposalResponse.body;
    assertInboxFixturePage(draftPage, {
      kind: "draft",
      id: teamFixture.inboxDraftId,
      title: teamFixture.inboxDraftTitle,
    });
    assertInboxFixturePage(proposalPage, {
      kind: "proposal",
      id: teamFixture.inboxProposalId,
      title: teamFixture.inboxProposalTitle,
    });
  }
  if (route === "relays") {
    const draft = page.locator(`[data-relay-draft-id="${teamFixture.relayDraftId}"]`);
    const relay = page.locator(`[data-relay-id="${teamFixture.relayId}"]`);
    await page.locator('[data-relay-workbench="ready"]')
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await relay.waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await relay.getByText(teamFixture.relaySummary, { exact: true })
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await page.getByRole("tab", { name: "Drafts on this device", exact: true }).click();
    await draft.waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await draft.getByText(teamFixture.relayDraftSummary, { exact: true })
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    // Measure the default personal queue after proving the secondary local
    // draft view is populated and independently readable.
    await page.getByRole("tab", { name: "For you", exact: true }).click();
    await relay.waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    const [draftResponse, relayResponse] = await page.evaluate(async () => Promise.all([
      "/api/v1/relays/drafts?limit=25",
      "/api/v1/relays?perspective=mine&state=published,acknowledged&limit=25",
    ].map(async (path) => {
      const response = await fetch(path, {
        headers: { accept: "application/json, application/problem+json" },
      });
      return { status: response.status, body: await response.json() };
    })));
    if (draftResponse.status !== 200 || relayResponse.status !== 200) {
      throw new Error("The Relay route fixture APIs did not both return HTTP 200.");
    }
    assertRelayFixturePage(draftResponse.body, {
      kind: "draft",
      id: teamFixture.relayDraftId,
      summary: teamFixture.relayDraftSummary,
    });
    assertRelayFixturePage(relayResponse.body, {
      kind: "relay",
      id: teamFixture.relayId,
      summary: teamFixture.relaySummary,
    });
  }
  if (route === "activity") {
    await page.locator('[data-activity-workbench="ready"]')
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await page.locator('[role="article"][data-source]').first()
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
  }
  if (route === "settings") {
    await page.getByRole("heading", { name: "Agent logging", exact: true })
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    const choices = page.getByRole("group", { name: "When to write notes", exact: true });
    await choices.waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
    await choices.locator('input[name="logging-mode"]:checked')
      .waitFor({ state: "visible", timeout: PAGE_READY_TIMEOUT_MS });
  }
}

async function addApiCookie(context, origin, serializedCookie) {
  const separator = serializedCookie.indexOf("=");
  if (separator <= 0) throw new Error("The Hub session cookie is malformed.");
  const url = new URL(origin);
  await context.addCookies([{
    name: serializedCookie.slice(0, separator),
    value: serializedCookie.slice(separator + 1),
    domain: url.hostname,
    path: "/api/v1",
    httpOnly: true,
    secure: false,
    sameSite: "Strict",
  }]);
}
