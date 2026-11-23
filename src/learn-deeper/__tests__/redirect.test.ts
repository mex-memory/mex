import { expect, it, vi } from "vitest";
import { ForgeClient, SourceError } from "../forge.js";
import { githubRepository } from "../github.js";

const repo = { host: "github.com", slug: "square/okhttp" } as const;

function client(request: typeof fetch) {
  return new ForgeClient(repo, "fixture-token", request, 0);
}

it("follows a same-host rename and reports a redirect it cannot follow as a moved repository", async () => {
  const seen: string[] = [];
  const renamed = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/repos/square/okhttp")) {
      return new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/5152285" } });
    }
    return Response.json({ full_name: "lysine-dev/okhttp", private: false, fork: false });
  });
  const followed = client(renamed);
  await expect(githubRepository(followed)).resolves.toMatchObject({ source: { slug: "lysine-dev/okhttp" }, visibility: "public" });
  expect(followed.renamed?.slug).toBe("lysine-dev/okhttp");
  expect(followed.repo.slug).toBe("lysine-dev/okhttp");
  expect(seen).toEqual(["https://api.github.com/repos/square/okhttp", "https://api.github.com/repositories/5152285"]);

  const foreign = vi.fn(async () => new Response(null, { status: 301, headers: { location: "https://evil.example/repos/square/okhttp" } }));
  await expect(githubRepository(client(foreign))).rejects.toThrow(/The repository moved\./u);
  await expect(githubRepository(client(foreign))).rejects.toThrow(expect.not.stringMatching(/could not be reached|evil\.example/u));

  const spinning = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://api.github.com/repos/square/okhttp" } }));
  await expect(githubRepository(client(spinning))).rejects.toThrow(SourceError);
  expect(spinning).toHaveBeenCalledTimes(4);

  const down = vi.fn(async () => { throw new Error("network"); });
  await expect(githubRepository(client(down))).rejects.toThrow(/could not be reached/u);
});
