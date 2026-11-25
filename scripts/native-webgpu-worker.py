"""Physical-adapter WebGPU inference using ONNX Runtime's native plugin.

Bun owns Code Guards, candidate scheduling and the 60-second benchmark.
This optional Python subprocess exists because the current JS/Node WebGPU
binding does not expose Dawn's physical adapterIndex selection.
"""
from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any
from inference_cache_store import PortableCpuWindowCache, WindowCache, model_namespace, RawPair, raw_pair

MODEL = "Xenova/mobilebert-uncased-mnli"
TEMPLATE = "The evidence indicates that {}."
MAX_TOKENS = 512
OVERLAP = 48
SAFETY_TOKENS = 8


def emit(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def model_files() -> tuple[str, str, dict[str, Any]]:
    if os.environ.get("CODE_GUARDS_OFFLINE") == "1":
        os.environ["HF_HUB_OFFLINE"] = "1"
    from huggingface_hub import hf_hub_download
    model = hf_hub_download(MODEL, filename="onnx/model.onnx")
    tokenizer = hf_hub_download(MODEL, filename="tokenizer.json")
    config = json.loads(Path(hf_hub_download(MODEL, filename="config.json")).read_text(encoding="utf-8"))
    return model, tokenizer, config


def profile_prefix(adapter_index: int) -> str:
    """Avoid same-second ONNX Runtime profile collisions across GPU processes.

    ORT's default filename is timestamp-based. Two native workers starting
    together can collide on Windows, where the open file cannot be replaced.
    """
    return str(Path(tempfile.gettempdir()) /
               f"code-guards-ort-gpu{adapter_index}-{os.getpid()}-{uuid.uuid4().hex}")


def webgpu_session(model_path: str, adapter_index: int) -> Any:
    import onnxruntime as ort
    import onnxruntime_ep_webgpu as webgpu_ep

    ort.register_execution_provider_library("code_guards_webgpu", webgpu_ep.get_library_path())
    matching = [item for item in ort.get_ep_devices() if item.ep_name == webgpu_ep.get_ep_name()]
    if not matching:
        raise RuntimeError("The ONNX Runtime native WebGPU plugin exposed no GPU EP device.")

    # Unlike ORT's deviceId, adapterIndex selects a PHYSICAL Dawn adapter.
    options = ort.SessionOptions()
    # CPU kernels are allowed only for unsupported graph operations. We
    # independently verify WebGPU execution using ONNX's node profiler.
    options.enable_profiling = True
    options.profile_file_prefix = profile_prefix(adapter_index)
    options.add_provider_for_devices(
        [matching[0]], {"adapterIndex": str(adapter_index), "powerPreference": "high-performance"}
    )
    session = ort.InferenceSession(model_path, sess_options=options, enable_fallback=False)
    session.disable_fallback()
    if not any("webgpu" in provider.lower() for provider in session.get_providers()):
        raise RuntimeError("Native WebGPU provider was not activated.")
    return session


def initialise(adapter_index: int) -> tuple[Any, Any, int, int, str]:
    from tokenizers import Tokenizer
    model_path, tokenizer_path, config = model_files()
    tokenizer = Tokenizer.from_file(tokenizer_path)
    session = webgpu_session(model_path, adapter_index)
    labels = {str(name).lower(): int(index) for name, index in config["label2id"].items()}
    return session, tokenizer, labels["entailment"], labels["contradiction"], model_namespace(model_path, tokenizer_path, (labels["entailment"], labels["contradiction"]))


def initialise_cpu() -> tuple[Any, Any, int, int, str]:
    """Use the same model and tokenizer with the explicit CPU FP32 provider."""
    import onnxruntime as ort
    from tokenizers import Tokenizer

    model_path, tokenizer_path, config = model_files()
    tokenizer = Tokenizer.from_file(tokenizer_path)
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(model_path, sess_options=options,
                                   providers=["CPUExecutionProvider"])
    session.disable_fallback()
    if session.get_providers() != ["CPUExecutionProvider"]:
        raise RuntimeError("Native CPU provider was not activated.")
    labels = {str(name).lower(): int(index) for name, index in config["label2id"].items()}
    entailment, contradiction = labels["entailment"], labels["contradiction"]
    return session, tokenizer, entailment, contradiction, model_namespace(
        model_path, tokenizer_path, (entailment, contradiction))


def decode_windows(tokens: list[int], capacity: int, tokenizer: Any) -> list[str]:
    if not tokens:
        return [""]
    windows: list[str] = []
    step = max(1, capacity - OVERLAP)
    for start in range(0, len(tokens), step):
        windows.append(tokenizer.decode(tokens[start:start + capacity], skip_special_tokens=True))
        if start + capacity >= len(tokens):
            break
    return windows


def paired_windows(comparison: Any, tokenizer: Any, capacity: int) -> list[str]:
    if not isinstance(comparison, dict) or any(
        not isinstance(comparison.get(side), dict) or any(
            not isinstance(comparison[side].get(key), str) for key in ("name", "evidence")
        ) for side in ("left", "right")
    ):
        raise ValueError("Invalid paired evidence.")
    left, right = comparison["left"], comparison["right"]
    first = f"First entity {left['name']}: "
    second = f"Second entity {right['name']}: "
    overhead = len(tokenizer.encode(first + "\n" + second, add_special_tokens=False).ids)
    budget = (capacity - overhead - SAFETY_TOKENS) // 2
    if budget < 49:
        raise ValueError("Comparison labels exceed the paired evidence budget.")
    left_chunks = decode_windows(tokenizer.encode(left["evidence"], add_special_tokens=False).ids, budget, tokenizer)
    right_chunks = decode_windows(tokenizer.encode(right["evidence"], add_special_tokens=False).ids, budget, tokenizer)
    if len(left_chunks) * len(right_chunks) > 256:
        raise ValueError("Comparison exceeds 256 paired evidence windows; narrower evidence is required.")
    windows = [first + a + "\n" + second + b for a in left_chunks for b in right_chunks]
    if any(len(tokenizer.encode(window, add_special_tokens=False).ids) > capacity for window in windows):
        raise ValueError("Re-encoded comparison exceeds the model token budget.")
    return windows


def evidence_windows(question: dict[str, Any], tokenizer: Any) -> list[str]:
    hypotheses = [TEMPLATE.format(question["same"]), TEMPLATE.format(question["different"])]
    max_hypothesis = max(len(tokenizer.encode(text, add_special_tokens=False).ids) for text in hypotheses)
    capacity = MAX_TOKENS - max_hypothesis - 3 - SAFETY_TOKENS
    if capacity < 48:
        raise ValueError("Zero-shot hypothesis exceeds MobileBERT context budget.")
    tokens = tokenizer.encode(question["premise"], add_special_tokens=False).ids
    if len(tokens) <= capacity:
        return [question["premise"]]
    if "comparison" in question:
        return paired_windows(question["comparison"], tokenizer, capacity)
    return decode_windows(tokens, capacity, tokenizer)


def run_pairs(session: Any, tokenizer: Any, pairs: list[tuple[str, str]]) -> Any:
    import numpy as np

    encoded = [tokenizer.encode(premise, hypothesis) for premise, hypothesis in pairs]
    if any(len(enc.ids) > MAX_TOKENS for enc in encoded):
        raise RuntimeError("Tokenized NLI pair exceeded MobileBERT's 512-token budget.")
    width = max(len(item.ids) for item in encoded)
    input_fields = {
        "input_ids": [[*item.ids, *([0] * (width - len(item.ids)))] for item in encoded],
        "attention_mask": [[*item.attention_mask, *([0] * (width - len(item.ids)))] for item in encoded],
        "token_type_ids": [[*item.type_ids, *([0] * (width - len(item.ids)))] for item in encoded],
    }
    feeds = {}
    for arg in session.get_inputs():
        if arg.name not in input_fields:
            raise RuntimeError("Unexpected ONNX input: " + arg.name)
        dtype = np.int32 if arg.type == "tensor(int32)" else np.int64
        feeds[arg.name] = np.asarray(input_fields[arg.name], dtype=dtype)
    logits = session.run(None, feeds)[0]
    if logits.shape[0] != len(pairs):
        raise RuntimeError("ONNX model returned the wrong batch length.")
    return logits




def summarise_provider_profile(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Prove execution, not mere registration of a WebGPU provider."""
    kernels = [
        event for event in events
        if event.get("cat") == "Node" and
        isinstance(event.get("args"), dict) and
        isinstance(event["args"].get("provider"), str)
    ]
    gpu = [event for event in kernels if "webgpu" in event["args"]["provider"].lower()]
    cpu = [event for event in kernels if "cpu" in event["args"]["provider"].lower()]
    if not gpu:
        providers = sorted({event["args"]["provider"] for event in kernels})
        raise RuntimeError(
            "MobileBERT executed no WebGPU kernels; rejecting CPU-only inference. "
            f"Observed node providers: {providers or ['no profiling node events']}"
        )
    return {
        "gpuNodes": len(gpu),
        "cpuNodes": len(cpu),
        "gpuOps": sorted({
            str(event["args"].get("op_name") or "unknown") for event in gpu
        })[:16],
        "gpuTimeMs": round(sum(float(event.get("dur", 0)) for event in gpu) / 1000, 3),
        "cpuTimeMs": round(sum(float(event.get("dur", 0)) for event in cpu) / 1000, 3),
    }


def verify_webgpu_execution(session: Any, gpu_id: int) -> dict[str, Any]:
    """After first inference, inspect actual ONNX Runtime kernel events."""
    profile = session.end_profiling()
    if not profile:
        raise RuntimeError("ONNX Runtime did not produce a WebGPU execution profile.")
    target = Path(profile)
    try:
        events = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(events, list):
            raise RuntimeError("ONNX Runtime emitted a malformed execution profile.")
        proof = summarise_provider_profile(events)
    finally:
        # Windows may still hold an ONNX profiler handle briefly after
        # end_profiling(). Cleanup is best-effort and must never abort the
        # scan after GPU execution and its WebGPU proof have succeeded.
        try:
            target.unlink(missing_ok=True)
        except PermissionError:
            pass
    emit({"type": "timing", "gpuId": gpu_id, "timing": {
        "phase": "provider-proof", "milliseconds": 0, **proof
    }})
    return proof


def sigmoid(delta: float) -> float:
    if delta >= 0:
        return 1 / (1 + math.exp(-delta))
    exponent = math.exp(delta)
    return exponent / (1 + exponent)


def ordered_logits(logits: Any, entailment: int, contradiction: int) -> tuple[float, float, float]:
    """Keep three original logits in entailment, neutral, contradiction order."""
    if len(logits) != 3 or entailment == contradiction or not all(
        0 <= index < 3 for index in (entailment, contradiction)
    ):
        raise ValueError("Expected a three-class NLI classifier.")
    neutral = 3 - entailment - contradiction
    return float(logits[entailment]), float(logits[neutral]), float(logits[contradiction])


def legacy_scores(pair: RawPair) -> tuple[float, float]:
    return tuple(sigmoid(row[0] - row[2]) for row in pair)


def logit_record(row: tuple[float, float, float]) -> dict[str, float]:
    return dict(zip(("entailment", "neutral", "contradiction"), row))


def classify(request: dict[str, Any], session: Any, tokenizer: Any, entailment: int,
             contradiction: int, gpu_id: int, batch_size: int, cache: WindowCache | None = None,
             provider: str = "test", require_raw: bool = False) -> None:
    question = request["question"]
    if not isinstance(question, dict) or any(
        not isinstance(question.get(key), str) for key in ("premise", "same", "different")
    ):
        raise ValueError("Invalid semantic question.")
    started = time.perf_counter()
    window_started = time.perf_counter()
    windows = evidence_windows(question, tokenizer)
    emit({"type": "timing", "gpuId": gpu_id, "timing": {
        "phase": "windowing", "milliseconds": (time.perf_counter() - window_started) * 1000,
        "windows": len(windows)
    }})
    positive = negative = 0.0
    positive_window = negative_window = 0
    raw_evidence: list[dict[str, Any]] = []
    for index in range(0, len(windows), batch_size):
        group = windows[index:index + batch_size]
        keys = ([cache.key(window, question["same"], question["different"]) for window in group]
                if cache is not None else [])
        cached = cache.get_many(keys) if cache is not None else {}
        raw_cached = cache.get_raw_many(keys, provider) if cache is not None else {}
        positions = [offset for offset in range(len(group))
                     if cache is None or (keys[offset] not in raw_cached and
                         (require_raw or keys[offset] not in cached))]
        computed: dict[int, RawPair] = {}
        if positions:
            pairs = [(group[offset], TEMPLATE.format(label)) for offset in positions
                     for label in (question["same"], question["different"])]
            began = time.perf_counter()
            logits = run_pairs(session, tokenizer, pairs)
            elapsed = (time.perf_counter() - began) * 1000
            if not hasattr(session, "_code_guards_verified"):
                if os.environ.get("CODE_GUARDS_GPU_BACKEND") == "cpu":
                    if session.get_providers() != ["CPUExecutionProvider"]:
                        raise RuntimeError("Expected native CPU execution.")
                else:
                    verify_webgpu_execution(session, gpu_id)
                session._code_guards_verified = True
            emit({"type": "timing", "gpuId": gpu_id, "timing": {
                "phase": "inference", "milliseconds": elapsed, "batchSize": len(positions),
                "window": index + 1, "windows": len(windows)
            }})
            for pos_index, offset in enumerate(positions):
                computed[offset] = raw_pair([
                    ordered_logits(logits[pos_index * 2], entailment, contradiction),
                    ordered_logits(logits[pos_index * 2 + 1], entailment, contradiction)
                ])
            if cache is not None:
                cache.put_raw_many(((keys[offset], pair) for offset, pair in computed.items()), provider)
                cache.put_many((keys[offset], *legacy_scores(pair)) for offset, pair in computed.items())
        else:
            emit({"type": "timing", "gpuId": gpu_id, "timing": {
                "phase": "cache-hit", "milliseconds": 0
            }})
        for offset in range(len(group)):
            pair = computed.get(offset)
            if pair is None and cache is not None:
                pair = raw_cached.get(keys[offset])
            previous = cached.get(keys[offset]) if cache is not None else None
            if pair is not None:
                result = legacy_scores(pair)
                # The portable legacy cache may contain another provider's
                # scores. Retain them unless complete raw evidence was requested.
                if previous is not None and not require_raw and previous != result:
                    pair, result = None, previous
            elif previous is not None and not require_raw:
                result = previous
            else:
                raise RuntimeError("Missing completed NLI window.")
            same_score, different_score = result
            raw_evidence.append({
                "window": index + offset + 1,
                "logits": None if pair is None else {
                    "support": logit_record(pair[0]), "opposition": logit_record(pair[1])
                }
            })
            if same_score > positive:
                positive = same_score
                positive_window = index + offset + 1
            if different_score > negative:
                negative = different_score
                negative_window = index + offset + 1
    emit({"type": "timing", "gpuId": gpu_id, "timing": {
        "phase": "verdict", "milliseconds": (time.perf_counter() - started) * 1000,
        "windows": len(windows)
    }})
    emit({"type": "result", "id": request["id"], "gpuId": gpu_id, "verdict": {
        "sameConcept": positive, "differentConcept": negative,
        "rawEvidence": raw_evidence,
        "evidence": {
            "windows": len(windows), "supportWindow": positive_window,
            "oppositionWindow": negative_window
        }
    }})


def embedding_assets(model: str, revision: str) -> tuple[str, Any]:
    from huggingface_hub import hf_hub_download
    from tokenizers import Tokenizer
    offline = os.environ.get("CODE_GUARDS_OFFLINE") == "1"
    cache = os.environ.get("CODE_GUARDS_MODEL_CACHE") or None
    model_path = hf_hub_download(model, filename="onnx/model.onnx", revision=revision,
                                 local_files_only=offline, cache_dir=cache)
    tokenizer_path = hf_hub_download(model, filename="tokenizer.json", revision=revision,
                                     local_files_only=offline, cache_dir=cache)
    tokenizer = Tokenizer.from_file(tokenizer_path)
    tokenizer.no_truncation()
    tokenizer.no_padding()
    return model_path, tokenizer


def embedding_rows(session: Any, tokenizer: Any, passages: list[str], capacity: int,
                   dimensions: int) -> list[Any]:
    import numpy as np
    encoded = [tokenizer.encode(text) for text in passages]
    positions = [i for i, item in enumerate(encoded) if len(item.ids) <= capacity]
    output = [None] * len(passages)
    if not positions:
        return output
    batch = [encoded[i] for i in positions]
    width = max(len(item.ids) for item in batch)
    fields = {
        "input_ids": [item.ids + [0] * (width - len(item.ids)) for item in batch],
        "attention_mask": [item.attention_mask + [0] * (width - len(item.ids)) for item in batch],
        "token_type_ids": [item.type_ids + [0] * (width - len(item.ids)) for item in batch],
    }
    feeds = {}
    for arg in session.get_inputs():
        if arg.name not in fields or arg.type not in ("tensor(int32)", "tensor(int64)"):
            raise RuntimeError("Unsupported embedding input: " + arg.name)
        feeds[arg.name] = np.asarray(fields[arg.name], dtype=np.int32 if arg.type == "tensor(int32)" else np.int64)
    hidden = session.run(["last_hidden_state"], feeds)[0]
    if hidden.shape != (len(batch), width, dimensions):
        raise RuntimeError("Unexpected specialist token embedding shape.")
    mask = np.asarray(fields["attention_mask"], dtype=np.float32)[..., None]
    pooled = (hidden * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1)
    norms = np.linalg.norm(pooled, axis=1, keepdims=True)
    if not np.all(np.isfinite(pooled)) or np.any(norms == 0):
        raise RuntimeError("Invalid specialist embedding.")
    for index, row in zip(positions, pooled / norms):
        output[index] = row.tolist()
    return output


def embedding_main(gpu_id: int) -> int:
    model = os.environ["CODE_GUARDS_EMBEDDING_MODEL"]
    revision = os.environ["CODE_GUARDS_EMBEDDING_REVISION"]
    capacity = int(os.environ["CODE_GUARDS_EMBEDDING_CONTEXT"])
    dimensions = int(os.environ["CODE_GUARDS_EMBEDDING_DIMENSIONS"])
    batch_size = int(os.environ["CODE_GUARDS_GPU_BATCH_SIZE"])
    model_path, tokenizer = embedding_assets(model, revision)
    session = webgpu_session(model_path, gpu_id)
    emit({"type": "ready", "gpuId": gpu_id})
    verified = False
    for line in sys.stdin:
        request = json.loads(line)
        passages = request["passages"]
        if not isinstance(passages, list) or not 1 <= len(passages) <= batch_size or not all(
                isinstance(text, str) for text in passages):
            raise ValueError("Malformed embedding batch.")
        rows = embedding_rows(session, tokenizer, passages, capacity, dimensions)
        if not verified and any(row is not None for row in rows):
            verify_webgpu_execution(session, gpu_id)
            verified = True
        emit({"type": "embeddings", "gpuId": gpu_id, "rows": rows})
    del session
    return 0


def main() -> int:
    gpu_id = int(os.environ["CODE_GUARDS_GPU_WORKER_ID"])
    if not 0 <= gpu_id < 16:
        raise ValueError("GPU adapter index must be between 0 and 15.")
    if os.environ.get("CODE_GUARDS_EMBEDDING_MODEL"):
        return embedding_main(gpu_id)
    batch_size = int(os.getenv("CODE_GUARDS_GPU_BATCH_SIZE", "4")) if os.getenv("CODE_GUARDS_GPU_BATCH") == "1" else 1
    if not 1 <= batch_size <= 16:
        raise ValueError("Batch size must be 1..16.")
    emit({"type": "loading", "gpuId": gpu_id})
    start = time.perf_counter()
    cpu = os.environ.get("CODE_GUARDS_GPU_BACKEND") == "cpu"
    session, tokenizer, entailment, contradiction, namespace = (
        initialise_cpu() if cpu else initialise(gpu_id))
    import onnxruntime as ort
    from importlib.metadata import version
    provider = "cpu-fp32:" + ort.__version__ if cpu else (
        "webgpu-fp32:" + ort.__version__ + ":" + version("onnxruntime-ep-webgpu"))
    require_raw = os.environ.get("CODE_GUARDS_REQUIRE_RAW_NLI") == "1"
    cache_dir = os.environ.get("CODE_GUARDS_INFERENCE_CACHE_DIR")
    cache = None
    if cache_dir:
        if cpu:
            cache = PortableCpuWindowCache(cache_dir, namespace, ort.__version__)
        else:
            cache = WindowCache(cache_dir, namespace)
    emit({"type": "timing", "gpuId": gpu_id, "timing": {
        "phase": "model-load", "milliseconds": (time.perf_counter() - start) * 1000
    }})
    emit({"type": "ready", "gpuId": gpu_id, "backend": "cpu" if cpu else "webgpu"})
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(request.get("id"), int):
                raise ValueError("Malformed WebGPU worker request.")
            classify(request, session, tokenizer, entailment, contradiction, gpu_id, batch_size,
                     cache, provider, require_raw)
    finally:
        if cache is not None:
            cache.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        emit({"type": "fatal", "gpuId": int(os.getenv("CODE_GUARDS_GPU_WORKER_ID", "-1")),
              "message": f"{type(exc).__name__}: {exc}"})
        sys.exit(1)
