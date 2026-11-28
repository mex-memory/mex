import { expect, it } from "vitest";
import { readsAsComment, statesAction } from "../lesson-text.js";

// Claims from OSS-92's Hono, pip and go-git runs, with the blind labeller's verdicts.
const instructions = [
  "Avoid exporting utility types from src/types.ts where possible.",
  "When adding an adapter package, mark each corresponding src/adapter/<name> export @deprecated.",
  "Do not select compression encodings with substring includes checks.",
  "Prefer upstream fixes for vendored dependencies over carrying patches in pip.",
  "Prioritize updating the website's JWK middleware documentation instead of adding extensive JSDoc.",
  "For the pure Python profile module, save the results and inspect them in a separate process.",
  "We don't add an example directory to this repo.",
  "Keep getGeo out of conninfo.",
  "Wait until there is an actual wheel 2.0 proposal before adding advice.",
  "Pull requests are limited to maintainers. If you find a bug or want a change, please create an issue instead.",
  "Target main for new features and bug fixes.",
  "Represent core.filemode as a bool and default it to true.",
  "The transport layer should validate that new requests match the storage format.",
];
const descriptions = [
  "Substring checks do not cover all Accept-Encoding cases in compression negotiation.",
  "Using includes to select a compression encoding does not cover all Accept-Encoding cases.",
  "The main `ci.yml` skips changes that only touch `adapters/**`.",
  "Rich Status erases completed spinner lines on an interactive tty because it uses a transient Live display.",
  "Removing an API in v6 is fair game when no stable release ever exposed it.",
];
const comments = [
  "Hmm, this looks like it can blow up with a remote pylock with relative directory URLs.",
  "But detecting the version of the selected setuptools sounds fraught with edge cases, I wouldn't bother.",
  "we don't increase the code of this middleware.",
  "no stable release ever exposed it, so removing it in v6 is fair game.",
];

it("tells an instruction from a description of a trap", () => {
  for (const claim of instructions) expect(statesAction(claim, "pitfall"), claim).toBe(true);
  for (const claim of descriptions) expect(statesAction(claim, "pitfall"), claim).toBe(false);
  // Outside pitfalls an unlisted verb still reads as an instruction; a described state does not.
  for (const claim of ["Flush the queue before commit.", "Dates use date-fns, not moment."]) expect(statesAction(claim, "decision"), claim).toBe(true);
  for (const claim of ["The main `ci.yml` skips changes that only touch `adapters/**`.", "Removing an API in v6 is fair game when no stable release ever exposed it."])
    expect(statesAction(claim, "process"), claim).toBe(false);
});

it.each([
  "Assign the setting on the fixture that owns it.",
  "Access the endpoint through the test client.",
  "Bring breaking changes to the maintainers before implementation.",
  "Buffer partial updates until the record is complete.",
  "Serialize socket writes through the shared writer.",
])("recognizes the imperative in %j", claim => {
  expect(statesAction(claim, "pitfall")).toBe(true);
});

it("tells a pasted review comment from a stated rule", () => {
  for (const claim of comments) expect(readsAsComment(claim), claim).toBe(true);
  for (const claim of [...instructions, ...descriptions]) expect(readsAsComment(claim), claim).toBe(false);
});
