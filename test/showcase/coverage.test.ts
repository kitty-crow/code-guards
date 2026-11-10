import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import path from "node:path";

const script = path.resolve("dist/examples/coverage/run.mjs");

function invoke(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {encoding: "utf8"});
}

test("the coverage showcase produces an actionable finding for all 54 active warning codes", () => {
  const execution = invoke(["--json"]);
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout) as {
    supportedCodes: string[];
    missing: string[];
    findings: {code: string; message: string; reason?: string; suggestion?: string; location: {file: string; line: number}}[];
  };
  assert.equal(result.supportedCodes.length, 54);
  assert.deepEqual(result.missing, []);
  // New rules need committed source fixtures, not just passing isolated unit tests.
  for (const code of ["CG206", "CG316", "CG317", "CG318", "CG404", "CG411"]) {
    assert.ok(result.findings.some(item => item.code === code), `missing committed showcase fixture for ${code}`);
  }
  assert.deepEqual(result.findings.map(item=>item.code), result.supportedCodes);
  for (const finding of result.findings) {
    assert.ok(finding.message, `${finding.code} lacks a title`);
    assert.ok(finding.reason, `${finding.code} lacks a reason`);
    assert.ok(finding.suggestion, `${finding.code} lacks a suggested correction`);
    assert.ok(finding.location.line >= 1, `${finding.code} lacks a source location`);
  }
});

test("showcase advisory output has source excerpts; strict mode returns exit 1", () => {
  const result = invoke(["--code", "CG001"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARNING\s+CG001/);
  assert.match(result.stdout, /Clause/);
  assert.match(result.stdout, /Why/);
  assert.match(result.stdout, /Fix/);
  assert.match(result.stdout, /\^/);
  assert.match(result.stdout, /SIMULATED/);
  const strict = invoke(["--code", "CG001", "--strict"]);
  assert.equal(strict.status, 1, strict.stderr);
});

test("all-code showcase is independent of the real model runtime", () => {
  const run = invoke(["--code", "CG410", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout) as {findings: {code: string}[]};
  assert.deepEqual(result.findings.map(item=>item.code), ["CG410"]);
});
