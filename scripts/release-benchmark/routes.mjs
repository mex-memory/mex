export const RELEASE_ROUTE_PATTERNS = Object.freeze({
  home: "/",
  repo: "/repos/:projectId",
});

export const RELEASE_ROUTE_KEYS = Object.freeze(Object.keys(RELEASE_ROUTE_PATTERNS));

// Both pages are currently eager and contribute to the initial closure. If
// Vite emits a page as its own chunk, charge it to the route that loads it.
export const RELEASE_ROUTE_MANIFEST_HINTS = Object.freeze({
  home: Object.freeze(["AllReposPage", "src/machine/pages.tsx"]),
  repo: Object.freeze(["RepoPage", "src/machine/pages.tsx"]),
});

export function releaseWorkbenchPaths({ projectId }) {
  if (typeof projectId !== "string" || !/^[gf]-[a-f0-9]{24}$/u.test(projectId)) {
    throw new Error("The benchmark checkout must have a machine project ID.");
  }
  return {
    home: RELEASE_ROUTE_PATTERNS.home,
    repo: RELEASE_ROUTE_PATTERNS.repo.replace(":projectId", projectId),
  };
}
