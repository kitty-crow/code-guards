# Git-backed persistent inference cache

Source: [src/inference-cache-git.ts](../../src/inference-cache-git.ts)

The public `synchroniseInferenceCache(action, cacheDir, remote, log?)` export merges remote scores before scanning and publishes completed results afterwards. It creates a temporary isolated Git worktree and invokes the standalone SQLite snapshot tool; it never modifies source code, the target project, or source-branch history.

## Usage and limitations



Code Guards retains its project-wide candidate index, cross-file type comparisons,
and ordered parallel semantic scheduler. The explicit \`--gpu-ids 0,1\` setting
uses two independent native WebGPU workers, one on each RTX 2080 Ti.

The native workers can now reuse **individual completed evidence-window scores**
across runs, even when an earlier question was interrupted. A shared SQLite database
uses WAL locking for concurrent GPU workers, with completed model batches committed
immediately. Cached scores reproduce the same question verdict, including evidence
window indexes. Changed questions reuse unchanged windows, while new or modified
window text produces new content hashes. The cache key includes a fingerprint of the
ONNX weights, tokenizer and scoring ABI, preventing incompatible reuse.

## Run on KittyWin

From a Code Guards checkout with a working native WebGPU Python environment:

\`\`\`powershell
$env:CODE_GUARDS_WEBGPU_PYTHON = "$env:TEMP\code-guards-webgpu\Scripts\python.exe"
bun src/cli.ts all --project "$env:TEMP\tensorflow-ts-benchmark\tsconfig.code-guards.json" --strict --include-tests --progress --accelerate batch,parallel,webgpu --gpu-ids 0,1 --concurrency 4 --batch-size 4 --inference-cache-dir "$env:TEMP\code-guards-inference" --cache-remote https://github.com/kitty-crow/tensorflow-ts.git --sync-inference-cache --format json > "$env:TEMP\tensorflow-ts-findings.json"
\`\`\`

The opt-in \`--sync-inference-cache\` flag downloads existing completed window
scores from the \`inference-cache\` branch before inference and publishes a merged
snapshot afterwards. Git authentication must already work on this machine. The
remote branch contains \`inference/*.jsonl.gz\` compressed deterministic hash-score
shards without source text. These remote writes never touch the project's source
branch, Git submodule pin or tracked working files, and do not launch GitHub scans.

If the process is interrupted, completed batches remain in the local database.
Resume with the same options; remote upload occurs on normal exit. To avoid
GitHub sync, omit \`--cache-remote\` and \`--sync-inference-cache\`, while retaining
\`--inference-cache-dir\`. If upload credentials are missing or the remote branch
advances during publication, the tool fails the upload without force-pushing or
deleting the local cache; retry to merge and publish the completed results.

The initial scan still costs real GPU work; persistent reuse makes incremental
iterations inexpensive. Existing physical-adapter scheduling remains the primary
parallel execution mechanism. The repository's deterministic guards still read
the complete TypeScript project and regenerate findings on each scan.
