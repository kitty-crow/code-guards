import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NO_ACCELERATION, parseAccelerationFlags } from "../src/acceleration.ts";
import { decodeEmbeddingRows, validateExpertAdapter, requireExpertHeadroom } from "../src/expert-gpu.ts";
import { parseRecord } from "../src/json.ts";

test("expert GPU shares explicitly mapped native judge adapters without disabling either worker", () => {
  validateExpertAdapter(0, "GPU-a1", NO_ACCELERATION, "");
  const judge = parseAccelerationFlags(["--accelerate", "parallel,webgpu", "--gpu-ids", "0"]).acceleration;
  validateExpertAdapter(1, "GPU-b2", judge, "0=GPU-a1");
  validateExpertAdapter(0, "GPU-a1", judge, "0=GPU-a1");
  const dual = parseAccelerationFlags(["--accelerate", "parallel,webgpu", "--gpu-ids", "0,1", "--concurrency", "4"]).acceleration;
  validateExpertAdapter(1, "GPU-b2", dual, "0=GPU-a1,1=GPU-b2");
  assert.deepEqual(dual.gpuIds, [0, 1]);
  assert.throws(() => validateExpertAdapter(0, "GPU-b2", judge, "0=GPU-a1"), /contradicts/);
  assert.throws(() => validateExpertAdapter(1, "GPU-a1", judge, "0=GPU-a1"), /another judge adapter/);
  assert.throws(() => validateExpertAdapter(1, "GPU-b2", judge, ""), /mapping|map/);
});

test("GPU embedding IPC validates complete vector dimensions and represents overlength inputs", () => {
  const rows = parseRecord('{"rows":[[0.5,0.25],null]}').get("rows");
  assert.deepEqual(decodeEmbeddingRows(rows, 2), [[0.5, 0.25], null]);
  assert.throws(() => decodeEmbeddingRows(rows, 3), /dimensions/);
  assert.throws(() => decodeEmbeddingRows(parseRecord('{"rows":[["invalid",0]]}').get("rows"), 2), /value/);
});

test("specialist admission accounts for existing GPU allocations", () => {
  const device = {uuid: "GPU-a1", usedMiB: 1500, totalMiB: 11264};
  requireExpertHeadroom(device, 10240, 642000000);
  assert.throws(() => requireExpertHeadroom({...device, usedMiB: 9000}, 10240, 642000000), /headroom/);
});
