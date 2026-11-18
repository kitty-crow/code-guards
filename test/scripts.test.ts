import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readScripts } from "../src/scripts.ts";

test("package scripts retain escaped command strings and ignore other properties", () => {
  assert.deepEqual(readScripts(JSON.stringify({name: "demo", scripts: {build: 'echo "hello"'}}), "package.json"), {build: 'echo "hello"'});
  assert.deepEqual(readScripts('{"name":"demo"}', "package.json"), {});
  assert.throws(() => readScripts('{"scripts":{"build":3}}', "package.json"), /non-string script/);
});
