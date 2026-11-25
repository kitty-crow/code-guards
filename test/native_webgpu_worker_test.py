"""Tests for fail-closed native WebGPU provider evidence without GPU access."""
import importlib.util
import unittest
from types import SimpleNamespace
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "native-webgpu-worker.py"
spec = importlib.util.spec_from_file_location("native_webgpu_worker", SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError("Unable to load native WebGPU worker")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ProviderProofTests(unittest.TestCase):
    def test_mixed_execution_is_accepted_and_reported(self):
        events = [
            {"cat": "Node", "args": {"provider": "WebGpuExecutionProvider", "op_name": "MatMul"}, "dur": 1000},
            {"cat": "Node", "args": {"provider": "CPUExecutionProvider", "op_name": "Shape"}, "dur": 100},
            {"cat": "Session", "args": {}, "dur": 100},
        ]
        proof = worker.summarise_provider_profile(events)
        self.assertEqual(proof["gpuNodes"], 1)
        self.assertEqual(proof["cpuNodes"], 1)
        self.assertEqual(proof["gpuOps"], ["MatMul"])

    def test_cpu_only_execution_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "no WebGPU kernels"):
            worker.summarise_provider_profile([
                {"cat": "Node", "args": {"provider": "CPUExecutionProvider", "op_name": "MatMul"}}
            ])

    def test_missing_profiling_evidence_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "no WebGPU kernels"):
            worker.summarise_provider_profile([])


class LargeEvidenceTests(unittest.TestCase):
    def test_full_pair_product_beyond_256_windows(self):
        class Tokenizer:
            def encode(self, text, add_special_tokens=False):
                return SimpleNamespace(ids=text.split())

            def decode(self, tokens, skip_special_tokens=True):
                return " ".join(tokens)

        left = " ".join(f"left{i}" for i in range(4000))
        right = " ".join(f"right{i}" for i in range(4000))
        windows = worker.paired_windows({
            "left": {"name": "a", "evidence": left},
            "right": {"name": "b", "evidence": right}
        }, Tokenizer(), 450)
        self.assertGreater(len(windows), 256)
        self.assertTrue(any("left0 " in window and "right3999" in window for window in windows))
        self.assertTrue(any("left3999" in window and "right0 " in window for window in windows))
        self.assertTrue(all(len(window.split()) <= 450 for window in windows))


if __name__ == "__main__":
    unittest.main()
