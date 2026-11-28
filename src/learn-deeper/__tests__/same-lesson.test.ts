import { expect, it } from "vitest";
import { parseNorms } from "../norm-writer.js";
import { observation, fixtureNorm, fixturePath } from "./fixtures/observations.js";

it("uses an explicit link to an existing norm for newly corroborating observations", () => {
  const item = observation(4, { stated_as_rule: false, form: "decision", why: "Retry dispatch stays serialized." });
  const earlier = [{ id: "mx_deep" + "a".repeat(32), claim: fixtureNorm }];
  const row = { text: "Route retry dispatch through `queueTransport` in `src/queue.ts`.", kind: "api-design",
    scope: [fixturePath], patternable: false, support: [item.id], extends: earlier[0]!.id };
  const read = (norm: object, prior = earlier) =>
    parseNorms(JSON.stringify({ policies: [], norms: [norm] }), [item], prior, new Map(), [fixturePath]);
  expect(read(row).drafts[0]?.support).toMatchObject({ earlier: earlier[0]!.id, pulls: [4] });
  expect(read({ ...row, extends: "unknown" }).drafts).toEqual([]);
  expect(read(row, [{ ...earlier[0]!, refused: true } as typeof earlier[number]]).drops).toEqual({ "unknown-support": 1 });
  expect(read({ ...row, extends: undefined }).drops).toEqual({ support: 1 });
});
