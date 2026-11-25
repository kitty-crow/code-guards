/** Dedicated DirectML or CUDA model worker with explicit adapter affinity. */
import { createInterface } from "node:readline";
import {
  configureSemanticAcceleration, disposeLocalSemanticModel, observeSemanticProgress, observeSemanticTimings, zeroShot
} from "./semantic.ts";
import type { Acceleration } from "./acceleration.ts";
import { parseRecord } from "./json.ts";
import { decodeSemanticQuestion } from "./inference-workers.ts";

const gpuId = Number(process.env.CODE_GUARDS_GPU_WORKER_ID ?? "-1");
if (!Number.isSafeInteger(gpuId) || gpuId < 0) throw new Error("Worker requires a valid GPU identifier.");
const batchSize = Number(process.env.CODE_GUARDS_GPU_BATCH_SIZE ?? "4");
const backend = process.env.CODE_GUARDS_GPU_BACKEND ?? "";
if (backend !== "dml" && backend !== "cuda") throw new Error("Worker requires dml or cuda backend.");
const features = new Set<Acceleration>([backend]);
if ((process.env.CODE_GUARDS_GPU_BATCH ?? "") === "1") features.add("batch");
if ((process.env.CODE_GUARDS_GPU_CACHE ?? "") === "1") features.add("cache");
configureSemanticAcceleration({ features, batchSize, concurrency: 1, gpuIds: [] });

function send(data: object): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

observeSemanticProgress(event => {
  if (event === "loading" || event === "ready") send({ type: event, gpuId });
});
observeSemanticTimings(timing => {
  send({ type: "timing", gpuId, timing });
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  try {
    const request = parseRecord(line);
    const id = request.number("id");
    if (!Number.isSafeInteger(id)) throw new Error("Invalid GPU worker request ID.");
    const question = decodeSemanticQuestion(request.record("question"));
    const verdict = await zeroShot(question);
    send({ type: "result", id, gpuId, verdict });
  } catch (error) {
    send({ type: "fatal", gpuId, message: error instanceof Error ? error.message : typeof error === "string" ? error : "Worker failed" });
    process.exitCode = 1;
    break;
  }
}

await disposeLocalSemanticModel();
