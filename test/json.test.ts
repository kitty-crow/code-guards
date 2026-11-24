import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseRecord } from "../src/json.ts";

test("JSON records decode escaped text, nested fields and finite numbers", () => {
  const original = { text: "line\nquote\"\\\t☺", number: -1.25e-4, child: { values: ["α", "β"] } };
  const record = parseRecord(JSON.stringify(original));
  assert.equal(record.text("text"), original.text);
  assert.equal(record.number("number"), original.number);
  assert.deepEqual(record.record("child").strings("values"), original.child.values);
  assert.equal(record.get("missing"), null);
  assert.equal(parseRecord('{"text":"\\uD83D\\uDE00"}').text("text"), "😀");
});

test("JSON IPC rejects malformed syntax and unexpected field types", () => {
  for (const input of ["[]", '{"x":}', '{"x":01}', '{"x":1,}', '{"x":[1,]}', '{"x":1} false', '{"x":1e999}', '{"x":"\\x41"}']) {
    assert.throws(() => parseRecord(input));
  }
  const record = parseRecord('{"x":"wrong","y":[1]}');
  assert.throws(() => record.number("x"));
  assert.throws(() => record.strings("y"));
  assert.throws(() => record.record("x"));
});
