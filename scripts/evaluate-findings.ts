#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { evaluateFindings, readEvaluationManifest, readFindingAnchors } from "../src/evaluation.ts";

const [manifestPath, baselinePath, candidatePath] = process.argv.slice(2);
if (!manifestPath || !baselinePath || !candidatePath) throw new Error("Usage: bun scripts/evaluate-findings.ts manifest.json baseline.json candidate.json");
const manifest = readEvaluationManifest(readFileSync(manifestPath, "utf8"));
const baseline = evaluateFindings(manifest.labels, readFindingAnchors(readFileSync(baselinePath, "utf8")));
const candidate = evaluateFindings(manifest.labels, readFindingAnchors(readFileSync(candidatePath, "utf8")));
const {labels, ...provenance} = manifest;
console.log(JSON.stringify({provenance, reviewedAnchors: labels.length, baseline, candidate}, null, 2));
