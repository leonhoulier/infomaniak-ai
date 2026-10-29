import assert from "node:assert/strict";
import { test } from "node:test";
import { txtData } from "../dist/registry.js";
test("DNS TXT comparison decodes presentation quotes, chunks and DNS escapes without changing malformed data", () => {
  for (const [input, output] of [
    ["plain", "plain"],
    ['"plain"', "plain"],
    ['"one" "two"', "onetwo"],
    ['"a\\032b"', "a b"],
    ['"a\\"b"', 'a"b'],
    ['"a\\\\b"', "a\\b"],
    ['"\\u0041"', "u0041"],
    ['"é"', "é"],
    ['"\\195\\169"', "é"],
    ['"broken', '"broken'],
    ['"one"trailing', '"one"trailing'],
    ['"\\999"', '"\\999"'],
    ['"\\255"', '"\\255"'],
  ])
    assert.equal(txtData(input), output, input);
});
