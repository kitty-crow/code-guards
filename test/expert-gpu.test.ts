import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NO_ACCELERATION, parseAccelerationFlags } from "../src/acceleration.ts";
import { decodeEmbeddingRows, validateExpertAdapter } from "../src/expert-gpu.ts";
import { parseRecord } from "../src/json.ts";

test("expert GPU requires disjoint physical adapters or a CPU judge", () => {
  validateExpertAdapter(0, "GPU-a1", NO_ACCELERATION, "");
  const judge = parseAccelerationFlags(["--accelerate", "parallel,webgpu", "--gpu-ids", "0"]).acceleration;
  validateExpertAdapter(1, "GPU-b2", judge, "0=GPU-a1");
  assert.throws(() => validateExpertAdapter(0, "GPU-b2", judge, "0=GPU-a1"), /dedicated/);
  assert.throws(() => validateExpertAdapter(1, "GPU-a1", judge, "0=GPU-a1"), /share/);
  assert.throws(() => validateExpertAdapter(1, "GPU-b2", judge, ""), /mapping|map/);
});

test("GPU embedding IPC validates complete vector dimensions and represents overlength inputs", () => {
  const rows = parseRecord('{"rows":[[0.5,0.25],null]}').get("rows");
  assert.deepEqual(decodeEmbeddingRows(rows, 2), [[0.5, 0.25], null]);
  assert.throws(() => decodeEmbeddingRows(rows, 3), /dimensions/);
  assert.throws(() => decodeEmbeddingRows(parseRecord('{"rows":[["invalid",0]]}').get("rows"), 2), /value/);
});
