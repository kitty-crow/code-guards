import { strict as assert } from "node:assert";
import path from "node:path";
import { test } from "node:test";
import { renderFindings } from "../src/diagnostics.ts";
import { noNestedIf } from "../src/guards/no-nested-if.ts";
import { typeReuse } from "../src/guards/type-reuse.ts";
import { functionQuality } from "../src/guards/function-quality.ts";
import { loadProject } from "../src/project.ts";
import type { SemanticScorer } from "../src/semantic.ts";

const project = loadProject(path.resolve("examples/violations/tsconfig.json"));
const noInference: SemanticScorer = async () => { throw new Error("This demonstration does not require model inference"); };

async function findings() {
  return [
    ...noNestedIf(project),
    ...await typeReuse(project, false, noInference),
    ...await functionQuality(project, false, noInference)
  ];
}

test("advisory report shows the exact offending clauses, related locations and refactoring examples", async () => {
  const result = renderFindings(await findings(), { root: project.root, format: "text", colour: "never" });
  assert.match(result, /src\/nested\.ts:4:5/);
  assert.match(result, /> 4 │\s+if \(allowed\) return "authorised";/);
  assert.match(result, /Clause\s+if \(allowed\)/);
  assert.match(result, /if \(!connected\) return "pending";/);
  assert.match(result, /if \(allowed\) return "authorised";/);
  assert.match(result, /The preceding 'if \(primary\)' branch always returns or throws/);
  assert.match(result, /import type \{ EnquiryContact \} from "\.\/enquiry-contact\.js"/);
  assert.match(result, /calculateInvoiceTotal and computeQuotedTotal/);
  assert.match(result, /See\s+src\/price-one\.ts:1:17/);
  assert.match(result, /4 finding\(s\): 4 warning\(s\)/);
  assert.doesNotMatch(result, /\u001b\[/);
});

test("terminal colouring is yellow in interactive mode, disable-able, and never leaks to JSON", async () => {
  const values = await findings();
  const yellow = renderFindings(values, { root: project.root, format: "text", colour: "always" });
  assert.match(yellow, /\u001b\[33m⚠ WARNING\u001b\[0m/);
  const plain = renderFindings(values, { root: project.root, format: "text", colour: "never" });
  assert.doesNotMatch(plain, /\u001b\[/);
  const json = renderFindings(values, { root: project.root, format: "json", colour: "always" });
  assert.equal(values.length, 4);
  assert.equal(json, JSON.stringify(values, null, 2));
  assert.doesNotMatch(json, /\u001b\[/);
});

test("GitHub annotations carry actionable suggestions without terminal colouring", async () => {
  const result = renderFindings(await findings(), { root: project.root, format: "github", colour: "always" });
  assert.match(result, /::warning file=src\/nested\.ts,line=4,col=5,title=CG001::/);
  assert.match(result, /if \(!connected\) return "pending"/);
  assert.match(result, /%0A/);
  assert.doesNotMatch(result, /\u001b\[/);
});

test("automatic colour only activates for terminals; NO_COLOR disables forced colours", async () => {
  const values = await findings();
  const previous = process.env.NO_COLOR ?? null;
  delete process.env.NO_COLOR;
  try {
    const interactive = renderFindings(values, { root: project.root, format: "text", colour: "auto", isTTY: true });
    assert.match(interactive, /\u001b\[33m/);
    const redirected = renderFindings(values, { root: project.root, format: "text", colour: "auto", isTTY: false });
    assert.doesNotMatch(redirected, /\u001b\[/);
    process.env.NO_COLOR = "1";
    const noColour = renderFindings(values, { root: project.root, format: "text", colour: "always" });
    assert.doesNotMatch(noColour, /\u001b\[/);
  } finally {
    if (previous === null) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});
