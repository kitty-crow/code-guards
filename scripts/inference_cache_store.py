"""Crash-resilient, content-addressed MobileBERT inference-window cache.

Scores are stored without source text. SQLite WAL serialises concurrent writes
from independently scheduled GPU workers. Each completed batch is committed.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
from typing import Iterable

SCHEMA_VERSION = 1
CREATE = """CREATE TABLE IF NOT EXISTS windows (
    key TEXT PRIMARY KEY,
    same REAL NOT NULL,
    different REAL NOT NULL
) WITHOUT ROWID"""


def file_sha256(filename: str) -> str:
    digest = hashlib.sha256()
    with open(filename, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def model_namespace(model_path: str, tokenizer_path: str, label_ids: tuple[int, int]) -> str:
    """Invalidate old results when weights, vocabulary, scoring or ABI change."""
    material = json.dumps([
        "code-guards-native-webgpu-fp32-v1", file_sha256(model_path),
        file_sha256(tokenizer_path), list(label_ids), 512, 48, 8,
        "The evidence indicates that {}.", "sigmoid(entailment-contradiction)"
    ], separators=(",", ":"))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


class WindowCache:
    def __init__(self, directory: str | Path, namespace: str):
        root = Path(directory).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(str(root / "windows.sqlite3"), timeout=30.0)
        self.connection.execute("PRAGMA busy_timeout=30000")
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute(CREATE)
        self.connection.commit()
        self.namespace = namespace

    def key(self, window: str, same: str, different: str) -> str:
        material = json.dumps([SCHEMA_VERSION, self.namespace, window, same, different],
                              ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    def get_many(self, keys: Iterable[str]) -> dict[str, tuple[float, float]]:
        result: dict[str, tuple[float, float]] = {}
        for key in keys:
            row = self.connection.execute(
                "SELECT same, different FROM windows WHERE key=?", (key,)
            ).fetchone()
            if row is not None:
                result[key] = (float(row[0]), float(row[1]))
        return result

    def put_many(self, entries: Iterable[tuple[str, float, float]]) -> None:
        values = list(entries)
        if not values:
            return
        if any(not (math.isfinite(s) and math.isfinite(d)) for _, s, d in values):
            raise ValueError("Refusing non-finite model scores in inference cache.")
        with self.connection:
            self.connection.executemany(
                "INSERT OR IGNORE INTO windows(key, same, different) VALUES (?, ?, ?)", values
            )

    def close(self) -> None:
        self.connection.close()


class PortableCpuWindowCache(WindowCache):
    """Read existing WebGPU FP32 results; isolate newly computed CPU scores."""

    def __init__(self, directory: str | Path, namespace: str, provider: str):
        super().__init__(directory, namespace)
        self.provider = provider

    def cpu_key(self, key: str) -> str:
        return hashlib.sha256(json.dumps(
            ["code-guards-native-cpu-fp32-v1", self.provider, key],
            separators=(",", ":")
        ).encode("utf-8")).hexdigest()

    def get_many(self, keys: Iterable[str]) -> dict[str, tuple[float, float]]:
        requested = list(keys)
        result = super().get_many(requested)
        missing = {self.cpu_key(key): key for key in requested if key not in result}
        for cpu_key, value in super().get_many(missing).items():
            result[missing[cpu_key]] = value
        return result

    def put_many(self, entries: Iterable[tuple[str, float, float]]) -> None:
        super().put_many((self.cpu_key(key), same, different)
                         for key, same, different in entries)


def shard_name(key: str) -> str:
    if len(key) != 64 or any(char not in "0123456789abcdef" for char in key):
        raise ValueError("Invalid content-addressed window key.")
    return key[:1] + format(int(key[1], 16) // 4, "x")


def export_snapshot(database_dir: Path, output: Path) -> None:
    """Export 64 deterministic compressed shards for a Git-tracked cache branch."""
    database = database_dir / "windows.sqlite3"
    output.mkdir(parents=True, exist_ok=True)
    if not database.is_file():
        raise FileNotFoundError(f"Inference cache database does not exist: {database}")
    connection = sqlite3.connect(str(database), timeout=30)
    try:
        entries = connection.execute("SELECT key, same, different FROM windows ORDER BY key")
        writers: dict[str, tuple[object, gzip.GzipFile]] = {}
        try:
            for key, same, different in entries:
                if not (math.isfinite(same) and math.isfinite(different)):
                    raise ValueError("Cache contains non-finite scores.")
                name = shard_name(key)
                if name not in writers:
                    handle = (output / f"{name}.jsonl.gz").open("wb")
                    writers[name] = (handle, gzip.GzipFile(fileobj=handle, mode="wb", mtime=0))
                _, writer = writers[name]
                writer.write((json.dumps([key, same, different], separators=(",", ":")) + "\n").encode("utf-8"))
        finally:
            for handle, writer in writers.values():
                writer.close()
                handle.close()
        (output / "manifest.json").write_text(json.dumps({
            "schemaVersion": SCHEMA_VERSION,
            "format": "sha256-score-shards",
            "description": "Content-addressed MobileBERT window scores. No source text is stored."
        }, indent=2) + "\n", encoding="utf-8")
    finally:
        connection.close()


def import_snapshot(source: Path, database_dir: Path) -> None:
    """Merge existing remote scores without deleting locally completed work."""
    database_dir.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(database_dir / "windows.sqlite3"), timeout=30)
    try:
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(CREATE)
        for shard in sorted(source.glob("*.jsonl.gz")):
            batch: list[tuple[str, float, float]] = []
            with gzip.open(shard, "rt", encoding="utf-8") as stream:
                for line in stream:
                    item = json.loads(line)
                    if not (isinstance(item, list) and len(item) == 3 and
                            isinstance(item[0], str) and shard_name(item[0]) == shard.stem.split(".")[0]):
                        raise ValueError("Invalid remote inference-cache entry.")
                    same, different = float(item[1]), float(item[2])
                    if not (math.isfinite(same) and math.isfinite(different)):
                        raise ValueError("Invalid scores in remote inference cache.")
                    batch.append((item[0], same, different))
                    if len(batch) >= 1024:
                        with connection:
                            connection.executemany(
                                "INSERT OR IGNORE INTO windows VALUES (?, ?, ?)", batch
                            )
                        batch.clear()
            if batch:
                with connection:
                    connection.executemany("INSERT OR IGNORE INTO windows VALUES (?, ?, ?)", batch)
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge or export content-addressed inference windows")
    parser.add_argument("action", choices=["export", "import"])
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--snapshot-dir", required=True, type=Path)
    args = parser.parse_args()
    if args.action == "export":
        export_snapshot(args.cache_dir, args.snapshot_dir)
    else:
        import_snapshot(args.snapshot_dir, args.cache_dir)


if __name__ == "__main__":
    main()
