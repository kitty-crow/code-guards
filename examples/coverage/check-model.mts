#!/usr/bin/env node
/** Optional end-to-end smoke check using the local MobileBERT/ONNX runtime. */
import { strict as assert } from "node:assert";
import { zeroShot } from "../../src/semantic.ts";

const premise = Array.from(Array<number>(115).keys(), index =>
  `Module ${index} handles project records and shares a reusable client type.`
).join(" ");
const result = await zeroShot({
  premise,
  same: "these modules could share one representation of project clients",
  different: "the modules describe distinct concepts with different contracts"
});
const windows = result.evidence.windows;
assert.ok(windows > 1, "expected multiple token-bounded inference windows");
assert.ok(Number.isFinite(result.sameConcept) && result.sameConcept >= 0 && result.sameConcept <= 1);
assert.ok(Number.isFinite(result.differentConcept) && result.differentConcept >= 0 && result.differentConcept <= 1);
console.log(`MobileBERT inference succeeded across ${windows} windows.`);
console.log(JSON.stringify(result, null, 2));
