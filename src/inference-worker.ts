/** Dedicated DirectML or CUDA model worker with explicit adapter affinity. */
import { createInterface } from "node:readline";
import {
  configureSemanticAcceleration, observeSemanticProgress, observeSemanticTimings, zeroShot,
  type SemanticQuestion
} from "./semantic.ts";
import type { Acceleration } from "./acceleration.ts";

type Request = { id: number; question: SemanticQuestion };
const gpuId = Number(process.env.CODE_GUARDS_GPU_WORKER_ID ?? "-1");
if (!Number.isSafeInteger(gpuId) || gpuId < 0) throw new Error("Worker requires a valid GPU identifier.");
const batchSize = Number(process.env.CODE_GUARDS_GPU_BATCH_SIZE ?? "4");
const backend = process.env.CODE_GUARDS_GPU_BACKEND;
if (backend !== "dml" && backend !== "cuda") throw new Error("Worker requires dml or cuda backend.");
const features = new Set<Acceleration>([backend]);
if (process.env.CODE_GUARDS_GPU_BATCH === "1") features.add("batch");
if (process.env.CODE_GUARDS_GPU_CACHE === "1") features.add("cache");
configureSemanticAcceleration({ features, batchSize });

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
    const request: unknown = JSON.parse(line);
    if (typeof request !== "object" || request === null || !("id" in request) ||
        !("question" in request) || typeof request.id !== "number") {
      throw new Error("Malformed GPU worker request");
    }
    const question = request.question;
    if (typeof question !== "object" || question === null || !("premise" in question) ||
        !("same" in question) || !("different" in question) ||
        typeof question.premise !== "string" || typeof question.same !== "string" ||
        typeof question.different !== "string") {
      throw new Error("Malformed semantic question");
    }
    const verdict = await zeroShot(question as SemanticQuestion);
    send({ type: "result", id: request.id, gpuId, verdict });
  } catch (error) {
    send({ type: "fatal", gpuId, message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    break;
  }
}
