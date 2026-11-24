import assert from "node:assert/strict";
import * as subject from "./subject.mjs";

assert.throws(() => fetch("https://fixture.invalid"), /Network disabled/);
const [name, value] = process.argv.slice(2);
assert.equal(subject[name](), Number(value));
