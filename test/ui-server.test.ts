import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { startUiServer, type UiServer } from "../src/ui/server.js";

/** A GET with full control over request headers, which fetch does not allow. */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers, setHost: false },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let root: string;
let server: UiServer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-ui-server-"));
  // Port 0 lets the OS pick a free port so parallel test files never collide.
  server = await startUiServer({ root, port: 0 });
});

afterEach(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("UI server — API", () => {
  it("binds loopback and serves health", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${server.url}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ ok: true, root });
  });

  it("never caches API responses", async () => {
    const response = await fetch(`${server.url}/api/snapshot`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "empty" });
  });

  it("rejects a POST body that is not valid JSON", async () => {
    const response = await fetch(`${server.url}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ nope",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_JSON" } });
  });

  it("rejects a request with an unrecognized Host header", async () => {
    // fetch treats Host as a forbidden header and would silently send the real
    // one, so this has to go through node:http to exercise the guard at all.
    const response = await rawRequest(server.port, "/api/health", { Host: "evil.example.com" });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "FORBIDDEN_HOST" } });
  });

  it("rejects a request with no Host header", async () => {
    const response = await rawRequest(server.port, "/api/health", { Host: "" });
    expect(response.status).toBe(403);
  });

  it("accepts localhost as well as the bound address", async () => {
    const response = await fetch(`http://localhost:${server.port}/api/health`);
    expect(response.status).toBe(200);
  });

  it("405s a non-GET request to a non-API path", async () => {
    const response = await fetch(`${server.url}/`, { method: "DELETE" });
    expect(response.status).toBe(405);
  });

  it("404s an unknown API route", async () => {
    const response = await fetch(`${server.url}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("UI server — job progress stream", () => {
  it("streams job state over SSE and closes when the job finishes", async () => {
    const accepted = await fetch(`${server.url}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "code-repo", tools: [], buildGraph: false }),
    });
    expect(accepted.status).toBe(202);
    const { job } = (await accepted.json()) as { job: { id: string } };

    const stream = await fetch(`${server.url}/api/jobs/${job.id}/stream`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    // The server ends the response at the terminal state, so reading to EOF
    // gives us the whole progress transcript.
    const transcript = await stream.text();
    const frames = transcript
      .split("\n\n")
      .filter((frame) => frame.startsWith("event: job"))
      .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6)));

    expect(frames.length).toBeGreaterThan(0);
    const last = frames.at(-1) as { status: string; steps: Array<{ id: string; status: string }> };
    expect(last.status).toBe("succeeded");
    expect(last.steps.find((step) => step.id === "scaffold")?.status).toBe("succeeded");
  }, 60_000);

  it("404s a stream for an unknown job", async () => {
    const response = await fetch(`${server.url}/api/jobs/does-not-exist/stream`);
    expect(response.status).toBe(404);
  });
});

describe("UI server — static assets", () => {
  it("explains how to build the frontend when assets are missing", async () => {
    // This repo builds the frontend into packages/mex-ui/dist, so which branch
    // runs depends on whether `npm run build:ui` has happened. Both are valid:
    // either real HTML from the SPA, or the actionable 503 page.
    const response = await fetch(`${server.url}/`);
    const html = await response.text();
    if (server.assetDir === null) {
      expect(response.status).toBe(503);
      expect(html).toContain("npm run build:ui");
    } else {
      expect(response.status).toBe(200);
      expect(html).toContain("<div id=\"root\">");
    }
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("falls client-side view paths through to the SPA", async () => {
    if (server.assetDir === null) return;
    for (const path of ["/health", "/graph", "/activity", "/settings", "/setup", "/setup/wizard"]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<div id=\"root\">");
    }
  });
});

describe("UI server — port selection", () => {
  it("moves to the next free port when the default is taken", async () => {
    const first = await startUiServer({ root, port: 0 });
    try {
      const second = await startUiServer({ root, port: first.port });
      try {
        expect(second.port).toBe(first.port + 1);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it("fails instead of moving when a port was named explicitly", async () => {
    const first = await startUiServer({ root, port: 0 });
    try {
      await expect(
        startUiServer({ root, port: first.port, strictPort: true }),
      ).rejects.toThrow(/already in use/);
    } finally {
      await first.close();
    }
  });
});

describe("UI server — path traversal", () => {
  it("does not serve files outside the asset directory", async () => {
    mkdirSync(join(root, "secret"), { recursive: true });
    writeFileSync(join(root, "secret", "token.txt"), "s3cret");

    // Encoded traversal, so it survives fetch's URL normalization.
    const response = await fetch(`${server.url}/..%2f..%2fsecret%2ftoken.txt`);
    const body = await response.text();
    expect(body).not.toContain("s3cret");
  });
});
