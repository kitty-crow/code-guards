"""No GPU or network required: persistent cache, crash recovery and snapshot roundtrip."""
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from inference_cache_store import WindowCache, export_snapshot, import_snapshot


class InferenceCacheTest(unittest.TestCase):
    def test_cross_run_reuse_and_changed_question(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = WindowCache(tmp, "model-a")
            first = cache.key("window one", "same", "different")
            cache.put_many([(first, 0.71, 0.18)])
            cache.close()
            second = WindowCache(tmp, "model-a")
            self.assertEqual(second.get_many([first]), {first: (0.71, 0.18)})
            self.assertNotEqual(second.key("modified window", "same", "different"), first)
            self.assertNotEqual(second.key("window one", "changed", "different"), first)
            third = WindowCache(tmp, "model-b")
            self.assertNotEqual(third.key("window one", "same", "different"), first)
            second.close()
            third.close()

    def test_sharded_snapshot_merges_without_source_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            original = WindowCache(base / "local", "weights-and-tokenizer")
            first = original.key("private TypeScript code", "same", "different")
            second = original.key("another passage", "same", "different")
            original.put_many([(first, 0.9, 0.1), (second, 0.2, 0.7)])
            original.close()
            export_snapshot(base / "local", base / "snapshot")
            for file in (base / "snapshot").glob("*.gz"):
                self.assertNotIn(b"private TypeScript code", file.read_bytes())
            import_snapshot(base / "snapshot", base / "other")
            imported = WindowCache(base / "other", "weights-and-tokenizer")
            self.assertEqual(imported.get_many([first, second]), {
                first: (0.9, 0.1), second: (0.2, 0.7)
            })
            imported.put_many([(first, 0.8, 0.3)])
            self.assertEqual(imported.get_many([first]), {first: (0.9, 0.1)})
            imported.close()


if __name__ == "__main__":
    unittest.main()
