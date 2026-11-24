import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { synchroniseInferenceCache } from "../src/inference-cache-git.ts";

function command(exe: string, args: string[]): string {
  const run = spawnSync(exe, args, {encoding: "utf8", windowsHide: true, timeout: 60_000});
  if (run.status !== 0) {
    throw new Error(exe + " failed: " + (run.stderr || ((run.error ?? null) instanceof Error ? (run.error ?? new Error("Git command failed")).message : String(run.status))));
  }
  return run.stdout.trim();
}

const python = process.env.CODE_GUARDS_WEBGPU_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");

test("git cache sync roundtrips results without changing project branches", () => {
  const root = mkdtempSync(path.join(tmpdir(), "code-guards-git-cache-test-"));
  try {
    const remote = path.join(root, "cache.git");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    command("git", ["init", "--bare", "--quiet", remote]);
    const key = "a".repeat(64);
    command(python, ["-c", [
      "import sqlite3,sys",
      "db=sqlite3.connect(sys.argv[1])",
      "db.execute('CREATE TABLE windows (key TEXT PRIMARY KEY, same REAL NOT NULL, different REAL NOT NULL) WITHOUT ROWID')",
      "db.execute('INSERT INTO windows VALUES (?, ?, ?)', ('a'*64, 0.875, 0.125))",
      "db.commit()"
    ].join("\n"), path.join(first, "windows.sqlite3")]);
    synchroniseInferenceCache("push", first, remote);
    assert.ok(command("git", ["--git-dir", remote, "rev-parse", "refs/heads/inference-cache"]));
    synchroniseInferenceCache("pull", second, remote);
    const result = command(python, ["-c", [
      "import sqlite3,sys",
      "db=sqlite3.connect(sys.argv[1])",
      "print(db.execute('SELECT same, different FROM windows WHERE key=?', ('a'*64,)).fetchone())"
    ].join("\n"), path.join(second, "windows.sqlite3")]);
    assert.equal(result, "(0.875, 0.125)");
    synchroniseInferenceCache("push", second, remote);
    assert.equal(key.length, 64);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
