import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readContactPreference, rememberContactPreference, submitSetupContact } from "../contact.js";
import { submitContactPayload, WEB3FORMS_SUBMIT_URL } from "@mex/hub-contracts/setup";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mex-contact-test-")); vi.stubEnv("MEX_HOME", root); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
const accepted = () => new Response('{"success":true}');

describe("optional setup contact", () => {
  it("keeps ordinary reads empty and stores only a preference across projects", async () => {
    expect(readContactPreference()).toEqual({ status: "unasked" });
    expect(readdirSync(root)).toEqual([]);
    await rememberContactPreference({ status: "skipped" });
    expect(readContactPreference()).toEqual({ status: "skipped" });
    expect(readdirSync(join(root, ".mex"))).toEqual(["setup"]);
    expect(readFileSync(join(root, ".mex/setup/contact-skipped.json"), "utf8")).toBe('{"schemaVersion":1}\n');
  });

  it("submits email with an optional name, retains no contact data, and avoids a duplicate send", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => accepted());
    await rememberContactPreference({ status: "skipped" });
    expect(await submitSetupContact({ email: "someone@example.com", name: "" }, { fetch })).toMatchObject({ ok: true, status: "submitted" });
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe(WEB3FORMS_SUBMIT_URL);
    expect(JSON.parse(options!.body as string)).toMatchObject({ email: "someone@example.com", source: "mex-setup" });
    expect(JSON.parse(options!.body as string)).not.toHaveProperty("name");
    expect(JSON.stringify(options)).not.toMatch(/distinct_id|scaffold_id|installation_id/);
    await submitSetupContact({ email: "another@example.com", name: "Another person" }, { fetch });
    expect(fetch).toHaveBeenCalledOnce();
    await rememberContactPreference({ status: "skipped" });
    expect(readContactPreference()).toEqual({ status: "submitted" });
    const files = readdirSync(join(root, ".mex/setup"));
    expect(files.sort()).toEqual(["contact-skipped.json", "contact-submitted.json"]);
    for (const file of files) expect(readFileSync(join(root, ".mex/setup", file), "utf8")).toBe('{"schemaVersion":1}\n');
  });

  it("rejects invalid or extra fields before creating state or sending", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const input of [{ email: "bad", name: "" }, { email: "ok@example.com", name: "x".repeat(201) }, { email: "ok@example.com", name: "", endpoint: "https://example.com" }]) {
      await expect(submitSetupContact(input, { fetch })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it("keeps a failed submission retryable without recording a successful contact", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error("private upstream failure")).mockResolvedValueOnce(accepted());
    const result = await submitSetupContact({ email: "ok@example.com", name: "" }, { fetch });
    expect(result).toMatchObject({ ok: false, status: "unasked" });
    expect(result.message).not.toContain("private");
    expect(existsSync(join(root, ".mex/setup/contact-submitted.json"))).toBe(false);
    await expect(submitSetupContact({ email: "ok@example.com", name: "" }, { fetch })).resolves.toMatchObject({ ok: true });
  });

  it("does not read through redirected preference directories or repair malformed markers", async () => {
    const outside = join(root, "outside"); mkdirSync(outside); mkdirSync(join(root, ".mex"));
    symlinkSync(outside, join(root, ".mex/setup"), process.platform === "win32" ? "junction" : "dir");
    expect(readContactPreference()).toEqual({ status: "unavailable" });
    await expect(rememberContactPreference({ status: "skipped" })).rejects.toThrow();
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(root, ".mex/setup")); mkdirSync(join(root, ".mex/setup"));
    writeFileSync(join(root, ".mex/setup/contact-submitted.json"), "broken");
    expect(readContactPreference()).toEqual({ status: "unavailable" });
    await expect(rememberContactPreference({ status: "submitted" })).rejects.toThrow();
    expect(readFileSync(join(root, ".mex/setup/contact-submitted.json"), "utf8")).toBe("broken");
  });
});

describe("bounded contact transport", () => {
  it("rejects oversized responses and unaccepted provider results", async () => {
    for (const response of [new Response(" ".repeat(8193)), new Response('{"success":false}'), new Response('{"success":true}', { status: 500 })]) {
      await expect(submitContactPayload({ access_key: "public-key" }, async () => response)).resolves.toMatchObject({ ok: false });
    }
  });

  it("ends a stalled request at the deadline and forwards cancellation", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (_url, options) => { requestSignal = options?.signal ?? undefined; return new Promise(() => {}); };
    const pending = submitContactPayload({ access_key: "public-key" }, fetch);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(requestSignal?.aborted).toBe(true);
    const controller = new AbortController();
    const cancelled = submitContactPayload({ access_key: "public-key" }, fetch, controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ ok: false });
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
