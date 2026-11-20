#!/usr/bin/env bun
/** Opt-in local CPU/q8 MobileBERT benchmark. Never used by routine CI. */
import { performance } from "node:perf_hooks";
import {
  MODEL, configureSemanticAcceleration, observeSemanticTimings, semanticExecutionProvider, zeroShot,
  type SemanticQuestion, type SemanticTimingEvent
} from "../src/semantic.ts";
import { accelerationNames, parseAccelerationFlags } from "../src/acceleration.ts";

type Sample = {
  iteration: number;
  totalMs: number;
  modelLoadMs: number;
  windowingMs: number;
  inferenceMs: number;
  otherMs: number;
  windows: number;
  inferenceWindows: number;
  cacheHit: boolean;
  sameConcept: number;
  differentConcept: number;
  residentMemoryMb: number;
};

function positiveIterations(): number {
  const raw = process.env.CODE_GUARDS_BENCHMARK_ITERATIONS ?? "2";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error("CODE_GUARDS_BENCHMARK_ITERATIONS must be an integer between 1 and 20.");
  }
  return value;
}

function benchmarkQuestion(long: boolean): SemanticQuestion {
  const count = long ? 110 : 5;
  const fields = Array.from({ length: count }, (_, index) =>
    "Customer profile " + index + " has an identifier, display name, contact address and preferences. " +
    "The corresponding customer record holds equivalent fields with matching TypeScript types."
  ).join(" ");
  return {
    premise: "Two TypeScript declarations are being reviewed for reuse. " + fields,
    same: "both declarations represent the same domain concept and may share a reusable type",
    different: "the declarations represent different domain concepts and should remain separate"
  };
}

function elapsed(events: readonly SemanticTimingEvent[], phase: SemanticTimingEvent["phase"]): number {
  return events.filter(event => event.phase === phase).reduce((total, event) => total + event.milliseconds, 0);
}

function rounded(milliseconds: number): number {
  return Number(milliseconds.toFixed(3));
}

const parsed = parseAccelerationFlags(process.argv.slice(2));
if (parsed.remaining.length) throw new Error("Unknown benchmark argument: " + parsed.remaining[0]);
const restoreAcceleration = configureSemanticAcceleration(parsed.acceleration);
const repetitions = positiveIterations();
const long = process.env.CODE_GUARDS_BENCHMARK_LONG === "1";
const question = benchmarkQuestion(long);
const events: SemanticTimingEvent[] = [];
const samples: Sample[] = [];
const restore = observeSemanticTimings(event => { events.push(event); });

try {
  for (let iteration = 1; iteration <= repetitions; iteration += 1) {
    console.error("[Code Guards] MobileBERT CPU/q8 benchmark run " + iteration + "/" + repetitions);
    const eventOffset = events.length;
    const started = performance.now();
    const verdict = await zeroShot(question);
    const totalMs = performance.now() - started;
    const iterationEvents = events.slice(eventOffset);
    const modelLoadMs = elapsed(iterationEvents, "model-load");
    const windowingMs = elapsed(iterationEvents, "windowing");
    const inferenceMs = elapsed(iterationEvents, "inference");
    const completedWindows = iterationEvents.reduce(
      (total, event) => total + (event.phase === "inference" ? event.batchSize : 0), 0
    );
    const cacheHit = iterationEvents.some(event => event.phase === "cache-hit");
    if (!cacheHit && completedWindows !== verdict.evidence.windows) {
      throw new Error("Benchmark window count differs from completed inference calls.");
    }
    samples.push({
      iteration,
      totalMs: rounded(totalMs),
      modelLoadMs: rounded(modelLoadMs),
      windowingMs: rounded(windowingMs),
      inferenceMs: rounded(inferenceMs),
      otherMs: rounded(Math.max(0, totalMs - modelLoadMs - windowingMs - inferenceMs)),
      windows: verdict.evidence.windows,
      inferenceWindows: completedWindows,
      cacheHit,
      sameConcept: verdict.sameConcept,
      differentConcept: verdict.differentConcept,
      residentMemoryMb: Number((process.memoryUsage().rss / 1048576).toFixed(2))
    });
  }
} finally {
  restore();
}

const provider = semanticExecutionProvider();
restoreAcceleration();
const warm = samples.slice(1);
const meanWarmMs = warm.length
  ? rounded(warm.reduce((sum, sample) => sum + sample.totalMs, 0) / warm.length)
  : null;
console.log(JSON.stringify({
  model: MODEL,
  requestedAcceleration: accelerationNames(parsed.acceleration),
  batchSize: parsed.acceleration.features.has("batch") ? parsed.acceleration.batchSize : 1,
  executionProvider: provider.device,
  precision: provider.precision,
  runtime: "Bun",
  bunVersion: process.versions["bun"] ?? "unknown",
  platform: process.platform,
  architecture: process.arch,
  longPremise: long,
  offline: process.env.CODE_GUARDS_OFFLINE === "1",
  iterations: repetitions,
  meanWarmMs,
  samples
}, null, 2));
