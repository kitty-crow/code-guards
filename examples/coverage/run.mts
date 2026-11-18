#!/usr/bin/env node
/** Reproducible rule showcase with deterministic, simulated NLI verdicts. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../../src/project.ts";
import {
  noNestedIf, typeReuse, functionQuality, moduleCohesion, codeHealth,
  crossModule, documentation, repoHygiene, enterpriseLookingNaming, reviewPractices
} from "../../src/guards/index.ts";
import { renderFindings } from "../../src/diagnostics.ts";
import type { Finding } from "../../src/model.ts";
import type { SemanticScorer } from "../../src/semantic.ts";

type Example = {finding: Finding; root: string};
const root = process.cwd();
const folder = path.join(root, "examples/coverage");
const supportedCodes = [...new Set([...readFileSync(path.join(root, "README.md"), "utf8")
  .matchAll(/^\|\s*`(CG\d{3})`\s*\|/gm)]
  .map(match => match[1] ?? "").filter(Boolean))].sort();
const simulatedScore: SemanticScorer = async () => ({sameConcept: 0.96, differentConcept: 0.03});

export async function collect(): Promise<{examples: Example[]; supportedCodes: string[]; missing: string[]}> {
  const code = loadProject(path.join(folder, "codebase/tsconfig.json"));
  const docs = loadProject(path.join(folder, "documentation/tsconfig.json"));
  const groups: [string, Finding[]][] = [
    [code.root, noNestedIf(code)],
    [code.root, await typeReuse(code, false, simulatedScore)],
    [code.root, await functionQuality(code, false, simulatedScore)],
    [code.root, await moduleCohesion(code, false, simulatedScore)],
    [code.root, codeHealth(code)],
    [code.root, crossModule(code)],
    [code.root, enterpriseLookingNaming(code)],
    [code.root, reviewPractices(code)],
    [code.root, await documentation(code, simulatedScore)],
    [code.root, repoHygiene(code.root)],
    [docs.root, await documentation(docs, simulatedScore)]
  ];
  const found = new Map<string, Example>();
  for (const [projectRoot, findings] of groups) {
    for (const finding of findings) {
      if (!found.has(finding.code)) found.set(finding.code, {finding, root: projectRoot});
    }
  }
  const missing = supportedCodes.filter(code => !found.has(code));
  return {
    examples: [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
    supportedCodes, missing
  };
}

async function showCoverage(): Promise<void> {
  const result = await collect();
  const json = process.argv.includes("--json");
  const strict = process.argv.includes("--strict");
  const onlyAt = process.argv.indexOf("--code");
  const only = onlyAt < 0 ? "" : process.argv[onlyAt + 1] ?? "";
  const shown = only ? result.examples.filter(item => item.finding.code === only) : result.examples;

  if (json) {
    console.log(JSON.stringify({
      supportedCodes: result.supportedCodes, missing: result.missing,
      findings: shown.map(item => item.finding)
    }, null, 2));
    process.exitCode = result.missing.length ? 2 : strict && shown.length ? 1 : 0;
    return;
  }

  console.log(`Code Guards rule showcase: ${shown.length}/${result.supportedCodes.length} codes`);
  console.log("NLI verdicts are SIMULATED. Run demo:semantic:bun for real MobileBERT inference.");
  for (const item of shown) {
    console.log(renderFindings([item.finding], {root: item.root, format: "text", colour: "auto"}));
  }
  if (result.missing.length) console.error(`Showcase missing codes: ${result.missing.join(", ")}`);
  process.exitCode = result.missing.length ? 2 : strict && shown.length ? 1 : 0;
}

const entry = process.argv[1] ?? "";
const entrypoint = entry ? path.resolve(entry) : "";
if (entrypoint === fileURLToPath(import.meta.url)) await showCoverage();
