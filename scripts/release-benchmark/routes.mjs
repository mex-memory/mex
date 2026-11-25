export const RELEASE_ROUTE_PATTERNS = Object.freeze({
  home: "/",
  repo: "/repos/:projectId",
});

export const RELEASE_ROUTE_KEYS = Object.freeze(Object.keys(RELEASE_ROUTE_PATTERNS));

// The two Home routes share one lazy page. Jobs, Knowledge, and Review load their own chunks.
export const RELEASE_ROUTE_MANIFEST_HINTS = Object.freeze({
  home: Object.freeze(["HomePage", "src/machine/HomePage.tsx"]),
  repo: Object.freeze(["HomePage", "src/machine/HomePage.tsx", "RepoPage"]),
  jobs: Object.freeze(["JobsPage", "src/machine/JobsPage.tsx"]),
  knowledge: Object.freeze(["KnowledgePage", "src/machine/KnowledgePage.tsx"]),
  review: Object.freeze(["ReviewPage", "src/machine/ReviewPage.tsx"]),
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
