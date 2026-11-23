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

it.each(["docs/CONTRIBUTING.md", "docs/development/supporting-formats.md", "docs/security-review.md",
  "docs/security/hardening.md", "docs/contributors/testing.md"])(
  "keeps contributor guidance at %s", path => {
    expect(docKind(path)).toBe("doc");
  },
);
