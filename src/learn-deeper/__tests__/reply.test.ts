import { expect, it } from "vitest";
import { replyJson } from "../reply.js";

it.each([
  ['{"a":1}', { a: 1 }], ['\n {"a":1}\n', { a: 1 }], ['```json\n{"a":1}\n```', { a: 1 }], ['```\n{"a":1}\n```\n', { a: 1 }],
  ['Here it is:\n{"a":"```"}\nDone.', { a: "```" }], ['{"a":"} and {"}', { a: "} and {" }], ["null", null],
  ["", undefined], ["no", undefined], ['{"a":', undefined], ["} {", undefined], ['{"a":1} or {"b":2}', undefined],
])("finds the JSON in a reply: %s", (text, value) => { expect(replyJson(text)).toEqual(value); });
