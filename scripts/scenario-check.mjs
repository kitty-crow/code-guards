#!/usr/bin/env node
// Opt-in external acceptance scenario. This runs only after Code Guards passes
// its own strict CI; do not couple these expectations to detection rules.
import { existsSync } from "node:fs";
import path from "node:path";
import { analyse } from "../dist/src/engine.js";
import { renderFindings } from "../dist/src/diagnostics.js";
import { guards } from "../dist/src/model.js";

const target = path.resolve(process.env.CODE_GUARDS_SCENARIO_PATH ?? "../slopdetector");
if (!existsSync(target)) {
  console.error(`Scenario checkout not found: ${target}. Clone it beside code-guards or set CODE_GUARDS_SCENARIO_PATH.`);
  process.exitCode = 2;
} else {
  console.log(`External scenario: ${target}`);
  const { findings, root } = await analyse({
    enabled: new Set(guards),
    project: target,
    includeTests: false
  });
  console.log(renderFindings(findings, {root, format: "text", colour: "auto"}));

  const readmeFindings = findings.filter(finding =>
    finding.code === "CG411" && finding.location.file.toLowerCase() === "readme.md"
  );
  const introduction = readmeFindings.some(finding =>
    finding.message === "README introduction prioritises development history over usage"
  );
  const handover = readmeFindings.some(finding =>
    finding.message === "Development handover prose in README"
  );
  if (!introduction || !handover) {
    const missing = [
      ...(!introduction ? ["introduction quality"] : []),
      ...(!handover ? ["development-handover prose"] : [])
    ];
    console.error(`Scenario failed: CG411 did not detect ${missing.join(" and ")} in the README.`);
    process.exitCode = 1;
  } else {
    console.log("Scenario passed: the README introduction and development handover were both detected.");
  }
}
