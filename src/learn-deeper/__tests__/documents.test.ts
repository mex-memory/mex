import { expect, it } from "vitest";
import { docKind, documentCandidates } from "../harvest/documents.js";
import { Gaps } from "../harvest/evidence.js";
import { Reviewers } from "../reviewers.js";

it.each([
  "docs/CODE_OF_CONDUCT.md", "SECURITY.md",
  ".github/ISSUE_TEMPLATE/bug.md", "docs/nested/code-of-conduct.md", "docs/policies/Security Policy.rst",
  "docs/LICENCE.adoc", "docs/history.md", "docs/CHANGELOG/2.0.md", "docs/AGENTS.override.md", "docs/GEMINI.md", ".claude/workflows/development.md", ".cursor/rules/STYLE.txt", "docs/decisions/release-notes.mdx",
  "docs/funding.md", "docs/SUPPORT.md", "docs/AUTHORS.md", "docs/contributor_list.md", "docs/governance/process.md",
  "docs/ISSUE_TEMPLATE/bug.md", "docs/release_notes/upgrading.md",
  ".claude/AI_POLICY.md", "vendor/AI_POLICY.md",
])("excludes repository policy or boilerplate at %s", path => {
  expect(docKind(path)).toBeUndefined();
});

it.each(["docs/CONTRIBUTING.md", ".github/CONTRIBUTING.txt", ".github/PULL_REQUEST_TEMPLATE.md", "docs/internals/contributing/coding-style.txt", "docs/development/supporting-formats.md", "docs/contributors/testing.md",
  "AI_POLICY.md", ".github/ai-usage-policy.md", "docs/contributing/AI_Contribution_Policy.mdx",
  "docs/html/development/architecture/overview.rst", "MAINTAINING.md", "HACKING.md", "STYLE.md", "release-process.md"])(
  "keeps contributor guidance at %s", path => {
    expect(docKind(path)).toBe("doc");
  },
);

it.each([
  ["docs/html/installation.md", "# Installation\n\nInstall the package."],
  ["docs/html/topics/configuration.md", "# Configuration\n\nSet the port.\n\n## Development\n\nSee the repository."],
  ["docs/html/user-guide.rst", "User Guide\n==========\n\nStart the service."],
])("requires a contributor topic in the path or first heading at %s", (path, text) => {
  expect(docKind(path)).toBeUndefined();
  expect(docKind(path, text)).toBeUndefined();
});

it.each([
  ["docs/security-review.md", "# Maintaining the review checklist"],
  ["docs/security/hardening.md", "# Running tests for transport hardening"],
  ["docs/html/working-copy.rst", "Building from source\n===================="],
  ["docs/html/bundles.adoc", "= Release process"],
])("accepts a contributor first heading at %s", (path, text) => {
  expect(docKind(path)).toBeUndefined();
  expect(docKind(path, text)).toBe("doc");
});

it("keeps a dedicated AI usage policy passage in the contributor docs input", () => {
  const point = { id: ".github/ai-usage-policy.md", at: "2026-05-01T00:00:00Z" };
  const text = "Disclose tool use in the pull request.";
  expect(documentCandidates(point, "doc", "# AI Usage Policy\n\n" + text, new Reviewers(), new Gaps()))
    .toMatchObject([{ text, document: { consumerUsage: false } }]);
});
