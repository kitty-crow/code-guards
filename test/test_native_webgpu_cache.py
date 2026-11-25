"""Verify actual native-worker cache reuse without ONNX, GPU or downloads."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from inference_cache_store import PortableCpuWindowCache, WindowCache

spec = importlib.util.spec_from_file_location("native_webgpu_worker", SCRIPTS / "native-webgpu-worker.py")
assert spec is not None and spec.loader is not None
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class FakeTokenizer:
    def __init__(self):
        self.vocabulary: dict[str, int] = {}
        self.reverse: dict[int, str] = {}

    def encode(self, value: str, add_special_tokens: bool = False):
        result = []
        for word in value.split():
            if word not in self.vocabulary:
                number = len(self.vocabulary) + 1
                self.vocabulary[word] = number
                self.reverse[number] = word
            result.append(self.vocabulary[word])
        return types.SimpleNamespace(ids=result)

    def decode(self, ids, skip_special_tokens: bool = True):
        return " ".join(self.reverse[index] for index in ids)


class PairedEvidenceTest(unittest.TestCase):
    def test_distant_fragments_share_a_window(self):
        tokenizer = FakeTokenizer()
        left = " ".join(f"left{i}" for i in range(620))
        right = " ".join(f"right{i}" for i in range(620))
        question = {"premise": left + " " + right, "same": "same concept",
                    "different": "different contract",
                    "comparison": {"left": {"name": "alpha", "evidence": left},
                                   "right": {"name": "beta", "evidence": right}}}
        windows = worker.evidence_windows(question, tokenizer)
        self.assertTrue(all("First entity alpha:" in window and "Second entity beta:" in window
                            for window in windows))
        self.assertTrue(any("left0" in window and "right619" in window for window in windows))
        self.assertTrue(any("left619" in window and "right0" in window for window in windows))


class ProfilingIsolationTest(unittest.TestCase):
    def test_unique_native_profile_prefix_per_gpu_and_session(self):
        first = worker.profile_prefix(0)
        second = worker.profile_prefix(1)
        repeated = worker.profile_prefix(0)
        self.assertNotEqual(first, second)
        self.assertNotEqual(first, repeated)
        self.assertIn("gpu0", first)
        self.assertIn("gpu1", second)
        self.assertTrue(Path(first).is_absolute())
        self.assertEqual(Path(first).parent, Path(tempfile.gettempdir()))

    def test_windows_profile_lock_cannot_abort_verified_gpu_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "independent-profile.json"
            profile.write_text(json.dumps([{
                "cat": "Node", "dur": 1000,
                "args": {"provider": "WebGPUExecutionProvider", "op_name": "MatMul"}
            }]), encoding="utf-8")
            events = []
            session = types.SimpleNamespace(end_profiling=lambda: str(profile))
            with patch.object(worker, "emit", events.append), patch.object(
                Path, "unlink", side_effect=PermissionError(32, "profile is locked")
            ):
                proof = worker.verify_webgpu_execution(session, 1)
            self.assertEqual(proof["gpuNodes"], 1)
            self.assertEqual(events[0]["type"], "timing")
            self.assertEqual(events[0]["timing"]["phase"], "provider-proof")
            self.assertEqual(events[0]["gpuId"], 1)


class NativeWorkerCacheTest(unittest.TestCase):
    def test_reuses_unchanged_windows_after_a_partial_source_change(self):
        with tempfile.TemporaryDirectory() as directory:
            tokenizer = FakeTokenizer()
            session = types.SimpleNamespace(_code_guards_verified=True)
            calls: list[int] = []

            def inference(_session, _tokenizer, pairs):
                calls.append(len(pairs) // 2)
                return [[0.0, 2.0, 0.5] if index % 2 == 0 else [2.0, 0.0, 1.0]
                        for index in range(len(pairs))]

            words = [f"word_{index}" for index in range(1000)]
            question = {"premise": " ".join(words), "same": "same concept",
                        "different": "different concept"}
            output: list[dict] = []
            cache = WindowCache(directory, "fixed-model-fingerprint")
            with patch.object(worker, "run_pairs", inference), patch.object(worker, "emit", output.append):
                worker.classify({"id": 1, "question": question}, session, tokenizer,
                                1, 0, 0, 4, cache)
            first_verdict = [item for item in output if item["type"] == "result"][0]["verdict"]
            expected_windows = len(worker.evidence_windows(question, tokenizer))
            self.assertGreaterEqual(expected_windows, 3)
            self.assertEqual(sum(calls), expected_windows)
            self.assertEqual(first_verdict["rawEvidence"][0]["logits"]["support"], {"entailment": 2.0, "neutral": 0.5, "contradiction": 0.0})
            cache.close()

            # Only one interior window changes. First and last should survive.
            modified = words.copy()
            modified[650] = "replacement_token"
            question["premise"] = " ".join(modified)
            calls.clear()
            output.clear()
            restored = WindowCache(directory, "fixed-model-fingerprint")
            with patch.object(worker, "run_pairs", inference), patch.object(worker, "emit", output.append):
                worker.classify({"id": 2, "question": question}, session, tokenizer,
                                1, 0, 0, 4, restored)
            second_verdict = [item for item in output if item["type"] == "result"][0]["verdict"]
            self.assertEqual(sum(calls), 1, "Only the changed interior evidence window should run")
            self.assertEqual(second_verdict["evidence"]["windows"], expected_windows)
            self.assertEqual(second_verdict["sameConcept"], first_verdict["sameConcept"])
            self.assertEqual(second_verdict["differentConcept"], first_verdict["differentConcept"])
            self.assertEqual(second_verdict["rawEvidence"], first_verdict["rawEvidence"])
            restored.close()

    def test_legacy_windows_are_reused_until_complete_raw_evidence_is_requested(self):
        with tempfile.TemporaryDirectory() as directory:
            tokenizer = FakeTokenizer()
            session = types.SimpleNamespace(_code_guards_verified=True)
            question = {"premise": "some evidence", "same": "same", "different": "different"}
            cache = WindowCache(directory, "model")
            key = cache.key(question["premise"], question["same"], question["different"])
            cache.put_many([(key, 0.8, 0.2)])
            output = []
            with patch.object(worker, "emit", output.append), patch.object(worker, "run_pairs") as inference:
                worker.classify({"id": 1, "question": question}, session, tokenizer, 1, 0, 0, 4, cache)
                inference.assert_not_called()
                self.assertEqual(output[-1]["verdict"]["rawEvidence"], [{"window": 1, "logits": None}])
                inference.return_value = [[0.0, 2.0, 5.0], [2.0, 0.0, 3.0]]
                worker.classify({"id": 2, "question": question}, session, tokenizer, 1, 0, 0, 4, cache,
                                "provider-a", True)
                inference.assert_called_once()
                fresh = output[-1]["verdict"]
                self.assertEqual(fresh["rawEvidence"][0]["logits"]["support"]["neutral"], 5.0)
                inference.reset_mock()
                worker.classify({"id": 3, "question": question}, session, tokenizer, 1, 0, 0, 4, cache,
                                "provider-a", True)
                inference.assert_not_called()
                self.assertEqual(output[-1]["verdict"], fresh)
                self.assertEqual(cache.get_many([key]), {key: (0.8, 0.2)})
            cache.close()


class PortableCpuCacheTest(unittest.TestCase):
    def test_reuses_gpu_scores_and_isolates_cpu_results(self):
        with tempfile.TemporaryDirectory() as directory:
            gpu = WindowCache(directory, "model")
            first = gpu.key("first", "same", "different")
            second = gpu.key("second", "same", "different")
            gpu.put_many([(first, 0.8, 0.2)])
            cpu = PortableCpuWindowCache(directory, "model", "test-provider")
            self.assertEqual(cpu.get_many([first, second]), {first: (0.8, 0.2)})
            cpu.put_many([(second, 0.7, 0.3)])
            self.assertEqual(cpu.get_many([first, second]),
                             {first: (0.8, 0.2), second: (0.7, 0.3)})
            self.assertEqual(gpu.get_many([first, second]), {first: (0.8, 0.2)})
            gpu.put_many([(second, 0.9, 0.1)])
            self.assertEqual(cpu.get_many([second]), {second: (0.9, 0.1)})
            different_provider = PortableCpuWindowCache(directory, "model", "other-provider")
            third = gpu.key("third", "same", "different")
            cpu.put_many([(third, 0.6, 0.4)])
            self.assertEqual(different_provider.get_many([third]), {})
            different_provider.close()
            cpu.close()
            gpu.close()


if __name__ == "__main__":
    unittest.main()
