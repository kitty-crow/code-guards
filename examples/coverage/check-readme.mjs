#!/usr/bin/env node
/** Real-model regression: a known handover-heavy README must produce CG411. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../../dist/src/project.js";
import { documentation } from "../../dist/src/guards/documentation.js";
import { zeroShot } from "../../dist/src/semantic.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(path.join(here, "fixtures/slopdetector-README.md"), "utf8");
const root = mkdtempSync(path.join(os.tmpdir(), "code-guards-readme-regression-"));
try {
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/index.ts"), "export const example = true;\n");
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: "ES2022", moduleResolution: "Bundler" },
    include: ["src/**/*.ts"]
  }));
  writeFileSync(path.join(root, "README.md"), readme);
  const findings = (await documentation(loadProject(root), async question => {
    const verdict = await zeroShot(question);
    // Print the model's actual evidence for the known problematic paragraph.
    if (question.premise.includes("during preparation of this source bundle")) {
      console.log(`Regression evidence: supporting=${verdict.sameConcept.toFixed(3)}, opposing=${verdict.differentConcept.toFixed(3)}`);
    }
    return verdict;
  })).filter(item => item.code === "CG411");
  if (!findings.length) {
    throw new Error("Real MobileBERT regression failed: the known handover-heavy Slopdetector README passed CG411. Refine NLP classification before shipping this guard.");
  }
  console.log(`CG411 real-model regression passed: ${findings.length} handover finding(s) in the full Slopdetector README.`);
  for (const finding of findings.slice(0, 5)) console.log(`  ${finding.location.file}:${finding.location.line}: ${finding.subject}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
