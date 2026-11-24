/** Git-backed, opt-in inference cache exchange. Never invokes a source scan. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRANCH = "inference-cache";
const PYTHON = process.env.CODE_GUARDS_WEBGPU_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");

function command(exe: string, args: string[], cwd: string, mayFail = false): boolean {
  const run = spawnSync(exe, args, {
    cwd, encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024
  });
  const error = run.error ?? null;
  if (error) throw new Error(exe + " could not run: " + error.message);
  if (run.status === 0) return true;
  if (mayFail && (run.status === 1 || run.status === 2)) return false;
  throw new Error(exe + " " + (args[0] ?? "") + " failed (exit " + String(run.status) +
    "): " + (run.stderr || run.stdout || "no diagnostics").trim());
}

function cacheScript(): string {
  const src = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(src, "..", "scripts", "inference_cache_store.py"),
    path.resolve(src, "..", "..", "scripts", "inference_cache_store.py")
  ];
  const script = candidates.find(item => existsSync(item)) ?? null;
  if (!script) throw new Error("Inference cache snapshot script is missing.");
  return script;
}

/**
 * Pull remote results before inference and merge completed results back after.
 * Only the dedicated inference-cache branch is written. It does not trigger
 * regular CI on the source branch. No Git worktree changes are made to the
 * user's project or to the Code Guards checkout.
 */
export function synchroniseInferenceCache(
  action: "pull" | "push", cacheDir: string, remote: string,
  log: (message: string) => void = () => {}
): void {
  const dir = path.resolve(cacheDir);
  if (!remote.trim()) throw new Error("--cache-remote requires a repository URL.");
  if (action === "push" && !existsSync(path.join(dir, "windows.sqlite3"))) {
    log("[Code Guards] No completed inference windows to publish.");
    return;
  }
  mkdirSync(dir, { recursive: true });
  const temp = mkdtempSync(path.join(tmpdir(), "code-guards-inference-"));
  try {
    command("git", ["init", "--quiet"], temp);
    command("git", ["remote", "add", "origin", remote], temp);
    const present = command(
      "git", ["ls-remote", "--exit-code", "--heads", "origin", "refs/heads/" + BRANCH],
      temp, true
    );
    if (!present && action === "pull") {
      log("[Code Guards] No remote inference cache yet.");
      return;
    }
    if (present) {
      command("git", ["fetch", "--quiet", "--depth=1", "origin", "refs/heads/" + BRANCH], temp);
      command("git", ["checkout", "--quiet", "-b", BRANCH, "FETCH_HEAD"], temp);
    } else {
      command("git", ["checkout", "--quiet", "--orphan", BRANCH], temp);
    }
    const snapshot = path.join(temp, "inference");
    if (present && existsSync(path.join(snapshot, "manifest.json"))) {
      command(PYTHON, [cacheScript(), "import", "--cache-dir", dir,
        "--snapshot-dir", snapshot], temp);
      log("[Code Guards] Merged existing GitHub inference windows.");
    }
    if (action === "pull") return;
    // Publish an entire deterministic snapshot of the union. Never force-push.
    rmSync(snapshot, { recursive: true, force: true });
    mkdirSync(snapshot, { recursive: true });
    command(PYTHON, [cacheScript(), "export", "--cache-dir", dir,
      "--snapshot-dir", snapshot], temp);
    command("git", ["add", "-A", "inference"], temp);
    if (command("git", ["diff", "--cached", "--quiet"], temp, true)) {
      log("[Code Guards] GitHub inference cache already up to date.");
      return;
    }
    command("git", ["-c", "user.name=Code Guards Cache",
      "-c", "user.email=code-guards-cache@users.noreply.github.com",
      "commit", "--quiet", "-m", "Update completed content-addressed inference windows"], temp);
    command("git", ["push", "--quiet", "origin", "HEAD:refs/heads/" + BRANCH], temp);
    log("[Code Guards] Published inference windows to " + BRANCH + ":inference/.");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
