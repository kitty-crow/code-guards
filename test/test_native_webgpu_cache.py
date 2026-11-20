"""Verify actual native-worker cache reuse without ONNX, GPU or downloads."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from inference_cache_store import WindowCache

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


class NativeWorkerCacheTest(unittest.TestCase):
    def test_reuses_unchanged_windows_after_a_partial_source_change(self):
        with tempfile.TemporaryDirectory() as directory:
            tokenizer = FakeTokenizer()
            session = types.SimpleNamespace(_code_guards_verified=True)
            calls: list[int] = []

            def inference(_session, _tokenizer, pairs):
                calls.append(len(pairs) // 2)
                return [[0.0, 2.0] if index % 2 == 0 else [2.0, 0.0]
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
            restored.close()


if __name__ == "__main__":
    unittest.main()
