import { expect, it } from "vitest";
import { docKind } from "../harvest/documents.js";

it.each([
  "docs/CODE_OF_CONDUCT.md", "SECURITY.md", ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug.md", "docs/nested/code-of-conduct.md", "docs/policies/Security Policy.rst",
  "docs/LICENCE.adoc", "docs/history.md", "docs/CHANGELOG/2.0.md", "docs/decisions/release-notes.mdx",
  "docs/funding.md", "docs/SUPPORT.md", "docs/AUTHORS.md", "docs/contributor_list.md", "docs/governance/process.md",
  "docs/ISSUE_TEMPLATE/bug.md", "docs/release_notes/upgrading.md",
])("excludes repository policy or boilerplate at %s", path => {
  expect(docKind(path)).toBeUndefined();
});

it.each(["docs/CONTRIBUTING.md", "docs/development/supporting-formats.md", "docs/contributors/testing.md",
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
