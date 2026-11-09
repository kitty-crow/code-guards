#!/usr/bin/env node
/** Reproducible rule showcase: real AST checks with explicit, simulated NLI verdicts. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../../dist/src/project.js";
import { noNestedIf } from "../../dist/src/guards/no-nested-if.js";
import { typeReuse } from "../../dist/src/guards/type-reuse.js";
import { functionQuality } from "../../dist/src/guards/function-quality.js";
import { codeHealth } from "../../dist/src/guards/code-health.js";
import { crossModule } from "../../dist/src/guards/cross-module.js";
import { documentation } from "../../dist/src/guards/documentation.js";
import { repoHygiene } from "../../dist/src/guards/repo-hygiene.js";
import { renderFindings } from "../../dist/src/diagnostics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const supportedCodes = [...new Set([...readFileSync(path.join(root, "README.md"), "utf8").matchAll(/^\|\s*`(CG\d{3})`\s*\|/gm)].map(match => match[1]))].sort();
const simulatedScore = async () => ({ sameConcept: 0.96, differentConcept: 0.03 });

export async function collect() {
  const code = loadProject(path.join(here, "codebase/tsconfig.json"));
  const docs = loadProject(path.join(here, "documentation/tsconfig.json"));
  const groups = [
    [code.root, noNestedIf(code)],
    [code.root, await typeReuse(code, false, simulatedScore)],
    [code.root, await functionQuality(code, false, simulatedScore)],
    [code.root, codeHealth(code)],
    [code.root, crossModule(code)],
    [code.root, await documentation(code, simulatedScore)],
    [code.root, repoHygiene(code.root)],
    [docs.root, await documentation(docs, simulatedScore)]
  ];
  const found = new Map();
  for (const [projectRoot, findings] of groups) {
    for (const finding of findings) if (!found.has(finding.code)) found.set(finding.code, { finding, root: projectRoot });
  }
  const missing = supportedCodes.filter(code => !found.has(code));
  return { examples: [...found.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>value), supportedCodes, missing };
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  const result = await collect();
  const json = process.argv.includes("--json");
  const strict = process.argv.includes("--strict");
  const onlyAt = process.argv.indexOf("--code");
  const only = onlyAt < 0 ? undefined : process.argv[onlyAt+1];
  const shown = only ? result.examples.filter(item=>item.finding.code===only) : result.examples;
  if (json) {
    console.log(JSON.stringify({supportedCodes:result.supportedCodes, missing:result.missing, findings:shown.map(item=>item.finding)}, null, 2));
  } else {
    console.log(`Code Guards rule showcase: ${shown.length}/${result.supportedCodes.length} codes`);
    console.log("NLP verdicts in this showcase are SIMULATED to guarantee coverage. Run demo:semantic:bun for real MobileBERT inference.");
    for (const item of shown) console.log(renderFindings([item.finding], {root:item.root, format:"text", colour:"auto"}));
    if (result.missing.length) console.error(`Showcase missing codes: ${result.missing.join(", ")}`);
  }
  process.exitCode = result.missing.length ? 2 : strict && shown.length ? 1 : 0;
}
