import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEAM_ACCESS_FOLLOW_UP_SUBJECT,
  TEAM_ACCESS_SOURCE,
  TEAM_ACCESS_STORAGE_KEY,
  TEAM_ACCESS_SUBJECT,
  TEAM_ACCESS_SUBMIT_ERROR,
  WEB3FORMS_SUBMIT_URL,
  __setWeb3FormsAccessKeyForTests,
  buildTeamAccessContactPayload,
  buildTeamAccessFollowUpPayload,
  readTeamAccessState,
  submitTeamAccessPayload,
  validateTeamAccessEmail,
  writeTeamAccessState,
} from "./team-access-lead";

afterEach(() => {
  vi.useRealTimers();
  __setWeb3FormsAccessKeyForTests(null);
  window.localStorage.removeItem(TEAM_ACCESS_STORAGE_KEY);
});

describe("team-access lead payloads", () => {
  it("builds an email-only contact payload without repo or machine fields", () => {
    __setWeb3FormsAccessKeyForTests("public-test-key");
    const payload = buildTeamAccessContactPayload({ email: " ada@example.com " });

    expect(payload).toEqual({
      access_key: "public-test-key",
      email: "ada@example.com",
      subject: TEAM_ACCESS_SUBJECT,
      from_name: "mex Hub",
      source: TEAM_ACCESS_SOURCE,
    });
    expect(Object.keys(payload).sort()).toEqual([
      "access_key",
      "email",
      "from_name",
      "source",
      "subject",
    ]);
  });

  it("omits empty optional follow-up fields and keeps the same contact identity", () => {
    __setWeb3FormsAccessKeyForTests("public-test-key");
    const payload = buildTeamAccessFollowUpPayload({
      email: "ada@example.com",
      engineersUsingAgents: "",
      name: "  ",
      company: "  ",
      teamSize: "",
      foundMex: "",
      installReason: "",
      repoKind: "",
      need: "",
      missing: "",
    });

    expect(payload).toEqual({
      access_key: "public-test-key",
      email: "ada@example.com",
      subject: TEAM_ACCESS_FOLLOW_UP_SUBJECT,
      from_name: "mex Hub",
      source: TEAM_ACCESS_SOURCE,
    });
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("company");
    expect(payload).not.toHaveProperty("i_want");
    expect(payload).not.toHaveProperty("repo");
    expect(payload).not.toHaveProperty("path");
  });

  it("includes only allowlisted optional answers", () => {
    __setWeb3FormsAccessKeyForTests("public-test-key");
    const payload = buildTeamAccessFollowUpPayload({
      email: "ada@example.com",
      engineersUsingAgents: "6–20",
      name: "Ada Lovelace",
      company: "Analytical Engines",
      teamSize: "2–10",
      foundMex: "GitHub",
      installReason: "Agent memory",
      repoKind: "Work",
      need: "Shared team memory",
      missing: "Shared follow-up",
    });

    expect(payload).toMatchObject({
      engineers_using_agents: "6–20",
      name: "Ada Lovelace",
      company: "Analytical Engines",
      team_size: "2–10",
      found_mex: "GitHub",
      install_reason: "Agent memory",
      repo_kind: "Work",
      i_need: "Shared team memory",
      whats_missing: "Shared follow-up",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "access_key",
      "company",
      "email",
      "engineers_using_agents",
      "found_mex",
      "from_name",
      "i_need",
      "install_reason",
      "name",
      "repo_kind",
      "source",
      "subject",
      "team_size",
      "whats_missing",
    ]);
    expect(payload).not.toHaveProperty("repo");
    expect(payload).not.toHaveProperty("path");
  });

  it("asks only for a valid email before submit", () => {
    expect(validateTeamAccessEmail("")).toEqual({ email: "Enter your email." });
    expect(validateTeamAccessEmail("not-an-email")).toEqual({ email: "Enter a valid email." });
    expect(validateTeamAccessEmail("ada@example.com")).toEqual({});
  });

  it("drops an engineer count outside the offered answers", () => {
    __setWeb3FormsAccessKeyForTests("public-test-key");
    const payload = buildTeamAccessFollowUpPayload({
      email: "ada@example.com", engineersUsingAgents: "500", name: "", company: "", teamSize: "",
      foundMex: "", installReason: "", repoKind: "", need: "", missing: "",
    });
    expect(payload).not.toHaveProperty("engineers_using_agents");
  });
});

describe("team-access Web3Forms submit", () => {
  it("posts JSON to Web3Forms and requires a success response", async () => {
    __setWeb3FormsAccessKeyForTests("public-test-key");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    const payload = buildTeamAccessContactPayload({ email: "ada@example.com" });
    const result = await submitTeamAccessPayload(payload, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(WEB3FORMS_SUBMIT_URL);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(payload);
  });

  it("stays failed when Web3Forms does not accept the payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, message: "invalid" }),
    });
    const result = await submitTeamAccessPayload(
      { access_key: "public-test-key", name: "Ada", email: "ada@example.com" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, message: TEAM_ACCESS_SUBMIT_ERROR });
  });

  it("aborts and settles after fifteen seconds when the request stalls", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}));
    const settled = vi.fn();
    const result = submitTeamAccessPayload(
      { access_key: "public-test-key", name: "Ada", email: "ada@example.com" },
      fetchImpl,
    ).then(settled);
    const signal = fetchImpl.mock.calls[0]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;

    expect(settled).toHaveBeenCalledExactlyOnceWith({ ok: false, message: TEAM_ACCESS_SUBMIT_ERROR });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rejects", "ignores"] as const)(
    "bounds a stalled response body when its reader %s the abort",
    async (abortBehavior) => {
      vi.useFakeTimers();
      const bodyAborted = vi.fn();
      const readBody = vi.fn();
      const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        readBody.mockImplementation(() => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            bodyAborted();
            if (abortBehavior === "rejects") reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        }));
        return Promise.resolve({ ok: true, json: readBody } as unknown as Response);
      });
      const result = submitTeamAccessPayload(
        { access_key: "public-test-key", name: "Ada", email: "ada@example.com" },
        fetchImpl,
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(readBody).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(result).resolves.toEqual({ ok: false, message: TEAM_ACCESS_SUBMIT_ERROR });
      expect(bodyAborted).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["success", "rejection"] as const)(
    "clears the deadline after early %s without later aborting the request",
    async (outcome) => {
      vi.useFakeTimers();
      const fetchImpl = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => (
        outcome === "success"
          ? Promise.resolve({ ok: true, json: async () => ({ success: true }) } as Response)
          : Promise.reject(new Error("Network unavailable"))
      ));
      const result = await submitTeamAccessPayload(
        { access_key: "public-test-key", name: "Ada", email: "ada@example.com" },
        fetchImpl,
      );
      const signal = fetchImpl.mock.calls[0]?.[1]?.signal;

      expect(result).toEqual(outcome === "success"
        ? { ok: true }
        : { ok: false, message: TEAM_ACCESS_SUBMIT_ERROR });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(signal?.aborted).toBe(false);
    },
  );

  it("does not call the network when the public access key is missing", async () => {
    const fetchImpl = vi.fn();
    const result = await submitTeamAccessPayload(
      { access_key: "", name: "Ada", email: "ada@example.com" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, message: TEAM_ACCESS_SUBMIT_ERROR });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("team-access local state", () => {
  it("remembers that this Hub checkout already sent contact details", () => {
    expect(readTeamAccessState()).toBeNull();
    writeTeamAccessState({ contactSent: true });
    expect(readTeamAccessState()).toEqual({ contactSent: true });
  });
});
