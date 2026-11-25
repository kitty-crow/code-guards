#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { calibrateDataset, readCalibrationDataset } from "../src/calibration.ts";

const input = process.argv[2] ?? "";
if (!input) throw new Error("Usage: bun scripts/calibrate-findings.ts labelled.json");
console.log(JSON.stringify(calibrateDataset(readCalibrationDataset(readFileSync(input, "utf8"))), null, 2));
