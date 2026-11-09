#!/usr/bin/env node
/** Optional end-to-end smoke check using the real local MobileBERT/ONNX runtime. */
import { strict as assert } from "node:assert";
import { zeroShot } from "../../dist/src/semantic.js";

const premise = Array.from({ length: 115 }, (_, index) =>
  `Module ${index} handles project records and shares a reusable client type.`
).join(" ");
const result = await zeroShot({
  premise,
  same: "these modules could share one representation of project clients",
  different: "the modules describe distinct concepts with different contracts"
});
assert.ok(result.evidence && result.evidence.windows > 1, "expected multiple token-bounded inference windows");
assert.ok(Number.isFinite(result.sameConcept) && result.sameConcept >= 0 && result.sameConcept <= 1);
assert.ok(Number.isFinite(result.differentConcept) && result.differentConcept >= 0 && result.differentConcept <= 1);
console.log(`MobileBERT inference succeeded across ${result.evidence.windows} windows.`);
console.log(JSON.stringify(result, null, 2));
