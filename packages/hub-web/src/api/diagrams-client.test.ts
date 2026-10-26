import { afterEach, expect, it, vi } from "vitest";
import { diagramFixture, diagramFixturePlan } from "../dev/diagram-fixtures";
import { HttpHubApi } from "./client";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());
it("uses authenticated revision-bound saves and rejects path-like identifiers before requesting", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(json({ csrfToken: "a".repeat(43), expiresAt: "2099-01-01T00:00:00.000Z" })).mockResolvedValueOnce(json(diagramFixturePlan)).mockResolvedValueOnce(json({ ...diagramFixture, kind: "saved", expiresAt: null }));
  vi.stubGlobal("fetch", fetcher); const api = new HttpHubApi(); await api.getSession();
  await api.previewDiagramSave(diagramFixture.id, diagramFixture.revision); await api.saveDiagram(diagramFixturePlan.token);
  for (const [, request] of fetcher.mock.calls.slice(1)) { const headers = new Headers(request.headers); expect(headers.get("X-MEX-CSRF")).toBe("a".repeat(43)); expect(headers.get("Content-Type")).toBe("application/json"); expect(request.credentials).toBe("same-origin"); }
  await expect(api.getDiagram("preview", "../etc/passwd")).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(3);
});
