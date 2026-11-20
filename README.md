# Code Guards

Code Guards checks local TypeScript projects for code quality and documentation problems. Findings include source locations and suggested corrections.

| CLI mode | Result |
| --- | --- |
| Default | Exit 1 for errors, exit 0 for warnings alone |
| `--strict` | Exit 1 for errors or warnings |
| Invalid options or target | Exit 2 |

The scan does not modify the target project or change TypeScript's compiler behaviour. CG305 reports non-deterministic types in advisory mode and rejects them in strict mode when the type-assertions guard is enabled.

## Get started

From a Code Guards checkout, use Bun on Linux, macOS or Windows, or Node.js 20+ with npm:

```sh
bun install
bun run ci:bun
bun run demo:bun
bun run demo:strict:bun
bun run demo:coverage:bun
```

`ci:bun` type-checks, builds, runs core tests and scans Code Guards itself in strict mode. The warning-heavy showcase tests are optional: `bun run test:showcase:bun` runs them separately, while `bun run ci:full:bun` includes them alongside the normal checks. The demo uses intentionally bad TypeScript. The strict demo exits 1 by design. Use a Linux-native toolchain in WSL; Windows npm cannot run reliably from a WSL UNC working directory.

## Scan any local TypeScript project without installing Code Guards there

Run the command **from Code Guards** after cloning and building it. The target path can be absolute or relative to the current working directory:

```sh
bun run guards:bun --path ../tracker-viewer
bun run guards:strict:bun --path ../tracker-viewer
bun run guards:bun --path /home/javier/projects/my-app --format json
bun run guards:bun no-nested-if --path ../tracker-viewer/src/main.ts
```

`--path` accepts a directory, an individual `.ts`/`.tsx`/`.mts`/`.cts` file, or a `tsconfig*.json` file. A directory with `tsconfig.json` uses its compiler configuration; without one, Code Guards recursively discovers TypeScript source files while excluding `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.cache` and `out`. Scans are read-only.

The existing `--project ../tracker-viewer/tsconfig.json` flag remains available for explicit TypeScript configurations. `--project` and `--path` cannot be used together. From any working directory you can instead call `bun /absolute/path/to/code-guards/dist/src/cli.js --path /absolute/path/to/project` after building the CLI. The model weights, if needed, are cached where Code Guards runs, not installed into the target project.

All 23 guards run by default. Pass a guard name to select it, or use `--disable` to exclude it:

```sh
bun run guards:bun --path ../tracker-viewer --disable documentation
```

| Option | Behaviour |
| --- | --- |
| `--strict` | Fail on warnings |
| `--format json\|github\|text` | Select report format |
| `--colour auto\|always\|never` | Set terminal colour |
| `--include-tests` | Include test files in type/function analysis |
| `--offline` | Use cached model weights only |

## Line-level exceptions

| Directive | If the next line has a finding | If no finding occurs |
| --- | --- | --- |
| `//@cg-ignore` | Suppress | No diagnostic |
| `//@cg-expect-error` | Suppress | CG327 error, exit 1 |
| `//@cg-expect-warning` | Suppress | CG327 warning, exit 1 only with strict mode |

Expectations use warnings or errors from the selected guards in either mode. Blank lines count. TypeScript compiler errors are unaffected.

```ts
// Fixed external ABI: six scalar inputs and a memory handle.
//@cg-ignore
export function externalAbi(memory: number, a: number, b: number, c: number, d: number, e: number, f: number): number {
  return memory + a + b + c + d + e + f;
}
```

## Reproducible coverage demonstrations

`bun run demo:coverage:bun` prints **one formatted warning for each active code** using deliberate faults in `examples/coverage/codebase` and `examples/coverage/documentation`. `bun run demo:coverage:bun --code CG413` focuses on a single rule. `bun run demo:coverage:bun --strict` prints the same warnings and exits 1; `--json` returns machine-readable diagnostics. Node users can run `npm run demo:coverage` or `node dist/examples/coverage/run.mjs` after building the project. The test suite verifies that every code listed in the table below appears in the demonstration.

**Inference disclosure:** This coverage showcase injects fixed, labelled zero-shot verdicts for reproducibility. It validates guard integration and reporting, but is not evidence of real MobileBERT quality. `bun run demo:semantic:bun` uses the actual model. To smoke-test the ONNX model itself with a deliberately overlong premise, run `bun run demo:model:bun` (or `npm run demo:model` under native Node). It downloads and executes real MobileBERT inference; it is deliberately **not** run as part of the routine unit tests. Long NLI inputs are tokenised and split into overlapping passages respecting MobileBERT's 512-token limit; evidence from all passages is combined conservatively.

### Local inference performance baseline

`bun run benchmark:inference` runs the real CPU/q8 MobileBERT pipeline twice
with identical evidence, separating model startup, tokenisation/window preparation,
inference and remaining overhead. It reports JSON timings and memory use.
A warm sample makes model-loading overhead distinguishable from inference speed.

```sh
bun run benchmark:inference
CODE_GUARDS_BENCHMARK_LONG=1 CODE_GUARDS_BENCHMARK_ITERATIONS=3 bun run benchmark:inference
CODE_GUARDS_OFFLINE=1 bun run benchmark:inference
```

The long run measures overlapping inference windows. It is optional, downloads
weights if absent, and may take substantially longer than ordinary unit tests.
The benchmark is not part of CI and does not change semantic decisions.

The `enterprise-looking-naming` guard checks functions, classes, methods, types, variables, parameters, members, aliases, filenames and directories. It identifies very long descriptive names and stacked generic suffixes. For instance, a function called `veryLongNamesThatAreVerySpecificAndMightNeedShortening` can be shortened to an abbreviation such as `lngNms` if that is clear in context. It never applies renames automatically.

The `review-practices` guard checks code and test maintainability:

- Comments that narrate individual statements
- Unresolved APIs and inconsistent conventions
- Repeated logic, redundant catches and weak assertions
- Unnecessary abstractions

`CG404` flags development history presented as current functionality. `CG405` flags instructions addressed to AI agents instead of software users.

Release history belongs in `CHANGELOG.md` or a migration guide.

## Warning reference

### Control flow and type reuse

| Code | What it detects |
| --- | --- |
| `CG001` | Nested `if` or `else if`; offers a control-flow-preserving refactor where possible |
| `CG101` | Identical type structures declared in separate modules |
| `CG102` | Different types with overlapping fields, potentially reusable |
| `CG103` | Types possibly describing the same concept, based on zero-shot analysis |

### Functions and methods

| Code | What it detects |
| --- | --- |
| `CG201` | Function may need decomposition into smaller responsibilities |
| `CG202` | Complex function may need explanatory comments |
| `CG203` | Function depends on many other source modules |
| `CG204` | Short, stateless class method may be better as a helper |
| `CG205` | Duplicate or highly similar function implementations |
| `CG206` | Semantically independent responsibilities implemented in one module |

### Code integrity and maintainability

| Code | What it detects |
| --- | --- |
| `CG301` | Unreachable code after unconditional exits |
| `CG302` | Redundant boolean conditional returning its own test |
| `CG303` | Ignored promises or empty catch clauses |
| `CG304` | Duplicated configuration strings across modules |
| `CG305` | Non-null or definite-assignment assertions, explicit or inferred `any`, `unknown` or `undefined`, and optional contracts |
| `CG306` | Missing string-union cases in a switch statement |
| `CG307` | Class method that may not use or belong to instance state |
| `CG308` | Stateless forwarding method that may be unnecessary |
| `CG309` | Direct `fetch` call that bypasses a central API client |
| `CG310` | Generic, uninformative function names |
| `CG311` | Large number of direct local module imports |
| `CG312` | Too many function arguments, optional values or boolean flags |
| `CG313` | `let` binding never reassigned, potentially a `const` |
| `CG314` | Test callback with no recognisable assertion |
| `CG315` | Placeholder marker in an apparently unfinished function |
| `CG316` | Excessively long or overdescriptive identifiers across declarations and members |
| `CG317` | Filler-heavy identifiers and stacked enterprise-style suffixes such as `ManagerServiceImplementation` |
| `CG318` | Overdescriptive TypeScript filenames or directory names |
| `CG319` | Obvious narration comments that restate a loop, conditional or statement |
| `CG320` | Unresolved methods, exports or call signatures verified against TypeScript diagnostics |
| `CG321` | Local identifier naming style diverging from an established convention |
| `CG322` | Three consecutive nontrivial statements repeated in separate modules |
| `CG323` | Redundant catch handlers that only rethrow the original error |
| `CG324` | Tautological test assertions such as `assert.ok(true)` or `expect(1).toBe(1)` |
| `CG325` | Stateless class shells with one trivial method and no instance contract |
| `CG326` | Multiple date-formatting mechanisms in one module requiring consistency review |
| `CG327` | Expected next-line finding did not occur |

### README and documentation

| Code | What it detects |
| --- | --- |
| `CG400` | Missing top-level README |
| `CG401` | Promotional wording without verifiable behaviour |
| `CG402` | README without runnable installation, build or usage commands |
| `CG403` | Substantially repeated documentation paragraphs |
| `CG404` | Development or release-note narratives disguised as features in README/module documentation |
| `CG405` | AI prompt-style instructions appearing as user documentation |
| `CG406` | Documented `npm run`/`bun run` command not present in package scripts |
| `CG407` | Missing `docs/index.md`, module link or README index reference |
| `CG408` | Source module lacking its own documentation page |
| `CG409` | Module documentation too brief or missing public exports |
| `CG410` | Ambiguous/vague prose endorsed by local zero-shot inference |
| `CG411` | Sentence-level wording quality, implementation-history narration and development handover assessed with local NLP |
| `CG412` | Broken relative Markdown link |
| `CG413` | Documented completion claim conflicts with a source placeholder |

### Repository housekeeping

| Code | What it detects |
| --- | --- |
| `CG501` | Build or test script executes the same step redundantly |
| `CG502` | Two scripts perform the identical test or CI command |
| `CG503` | Source and compiled Bun tests may be executed twice |
| `CG504` | Duplicate commands across GitHub workflow definitions |

For implementation detail and each module's exports, consult [docs/index.md](docs/index.md).

## Semantic analysis and limitations

The `type-reuse`, `function-quality` and `documentation` guards use `Xenova/mobilebert-uncased-mnli` through `@huggingface/transformers` for *shortlisted* ambiguous comparisons. Model inference is local, defaults to CPU/q8 and downloads weights on first use unless `--offline` is set. Semantic warnings express a likelihood, **not proof** of equivalence, an unsafe change, or factual inaccuracy. TypeScript AST checks can verify narrower issues such as duplicate structures, missing exports, undefined package scripts and broken local links. Model loading failures exit 2 rather than silently substituting a heuristic decision.

The demonstration commands use different evidence sources:

| Command | Evidence |
| --- | --- |
| `bun run demo:bun` | Deliberately faulty TypeScript |
| `bun run demo:housekeeping:bun` | Housekeeping violations |
| `bun run demo:semantic:bun` | Real MobileBERT inference |
| `bun run test:bun` | Unit tests, including injected semantic scores |

## Development

```sh
bun run ci:bun
bun run guards:strict:bun
bun run test:bun
```

`bun run ci:bun` includes the strict Code Guards self-scan. New guard tests should cover passing and failing cases plus the strict-mode exit code.

The package is marked private and is not published to npm. GitHub CI runs type checks, unit tests and the strict self-scan using Bun.

MIT licence.

## Progress reporting and vendor boundaries

Use `--progress` to see live progress on standard error without changing the normal findings output on standard output:

```sh
bun run guards:strict:bun --path ../my-project --progress
```

Progress includes the number of files, each scan stage, elapsed time, findings and neural inference windows. TypeScript checks retain all 23 guards, with the related deterministic code-health rules grouped into one traversal. MobileBERT defaults to CPU/q8 but supports explicit accelerator selection, and each completed inference window is counted. CI can use `--format github --progress` to preserve GitHub annotations and emit readable progress logs.

Vendored dependencies are excluded from both TypeScript findings and documentation checks. This covers `vendor/`, `third_party/`, `third-party/` and all submodule paths declared in the target repository's `.gitmodules`, including submodules located outside those conventional directories. The target's own source and tests remain subject to the configured checks.

## Optional MobileBERT acceleration

By default Code Guards uses CPU/q8 inference, exactly as before. Use explicit,
composable flags for cache, batching and GPU inference:

```sh
bun run benchmark:inference --accelerate none
bun run benchmark:inference --accelerate cache
CODE_GUARDS_BENCHMARK_LONG=1 bun run benchmark:inference --accelerate batch --batch-size 4
bun run benchmark:inference --accelerate webgpu
bun run benchmark:inference --accelerate cuda
bun run benchmark:inference --accelerate cache,batch,webgpu --batch-size 4
bun run guards:bun --project ../tensorflow-ts/tsconfig.code-guards.json --accelerate cache,batch,cuda --batch-size 4
```

CUDA and WebGPU are explicit GPU requests; model compatibility, runtime
libraries and drivers determine availability. Use `--accelerate cuda,webgpu`
to try CUDA then WebGPU, or reverse the order. These are alternative
providers, not simultaneous multi-GPU execution. CPU is **not** silently
selected if both fail. GPU precision is FP32, and semantic scores may differ
from CPU/q8. All work remains local. The TensorFlow fork is a real-world
project-scan target, not an inference model.

## Sixty-second TensorFlow source throughput comparison

To compare actual Code Guards progress across CPU and GPU modes using
the TensorFlow TypeScript fork, start from a checkout of Code Guards
and an existing checkout of TensorFlow TypeScript:

```sh
bun run benchmark:throughput --project /absolute/path/to/tensorflow-ts/tsconfig.code-guards.json
```

The supervisor runs three independent real scans, each with a hard
60-second deadline: CPU/q8, WebGPU/FP32 and WebGPU/FP32 with batch size 4.
It measures completed semantic questions, real inference windows and fully
completed guard stages, including time spent loading the TypeScript project.
The loaded source-file count is *not* a processed-file count. Different
model precisions can affect semantic findings. Use `--mode` to select a
specific acceleration setting, `--guard type-reuse` to isolate the
semantic type-reuse guard, or `--seconds` for a different diagnostic
limit. A timed-out scan is forcibly stopped, not allowed to continue
in the background. The benchmark is local and is excluded from CI.

## Experimental bounded inference parallelism

Independent type-reuse comparisons can now execute concurrently without
reordering results. Opt in with `--accelerate parallel,webgpu --concurrency 4`.
Use the throughput benchmark with `--mode webgpu --mode parallel,webgpu`
to establish whether it actually improves full-project throughput. This
is one GPU backend per process, not verified dual-GPU or NVLink support.

## Experimental multi-GPU CUDA workers

For Linux/WSL2 hosts with two working CUDA-capable NVIDIA GPUs, select
`--accelerate parallel,cuda --concurrency 4 --gpu-ids 0,1`. Code Guards
runs two independent CUDA model processes with explicit
`CUDA_VISIBLE_DEVICES` affinity. Native Windows WebGPU GPU selection is
not implemented and these flags reject that platform. The two processes
replicate MobileBERT instead of using NVLink, so no cross-GPU transfer is
necessary. Use `benchmark:throughput --mode parallel,cuda --gpu-ids 0,1`
to verify actual per-GPU inference work. Do not assume two GPUs are active
without reviewing per-device counters and NVIDIA utilisation.

## Cross-question inference batching

The `parallel,batch` combination now implements actual model-call
batching across different semantic questions with identical candidate
hypotheses. A single GPU inference dispatcher interleaves evidence windows
and serialises the underlying model calls to avoid contention observed when
multiple calls targeted the same WebGPU session concurrently.

Compare it directly against the previous WebGPU baseline:

```powershell
bun run benchmark:throughput --project "$env:TEMP\\tensorflow-ts-benchmark\\tsconfig.code-guards.json" --mode webgpu --mode batch,webgpu --mode batch,parallel,webgpu --concurrency 4
```

This optimisation is experimental and its throughput improvement needs to
be measured. It neither activates the second graphics card nor uses NVLink.

## Windows dual-GPU DirectML benchmark

Native Windows can use two separate DirectML GPU adapters with independent
MobileBERT worker processes. Use `--accelerate parallel,dml --gpu-ids 0,1
--concurrency 4` and compare `--mode dml` against `--mode parallel,dml`
in the 60-second throughput benchmark. Windows DirectML adapter IDs need not
match `nvidia-smi` ordering. This path is independent of WebGPU and does not
use NVLink; each worker has its own full model and reports its own inference
window counter. On unsupported DirectML installations the scan fails rather
than claiming to have used both GPUs.

## Experimental native dual-WebGPU adapters (Windows)

To select **two physical WebGPU adapters** rather than two instances of the
same default GPU, Code Guards can use ONNX Runtime's newer native WebGPU
plugin and its `adapterIndex` option. The scanner remains Bun/TypeScript;
only the explicitly selected inference engine uses isolated Python plugin
workers. The stock ONNX Runtime Node binding does **not** expose this
physical-adapter selector.

Install a separate Python environment with the matched pair
`onnxruntime==1.31.0` and `onnxruntime-ep-webgpu==0.5.0`, plus
`huggingface-hub`, `tokenizers` and `numpy`. For example on KittyWin:

```powershell
py -3.12 -m venv "$env:TEMP\\code-guards-webgpu"
& "$env:TEMP\\code-guards-webgpu\\Scripts\\python.exe" -m pip install "onnxruntime==1.31.0" "onnxruntime-ep-webgpu==0.5.0" "huggingface-hub>=0.26,<2" "tokenizers>=0.20,<1" "numpy>=1.26,<3"
$env:CODE_GUARDS_WEBGPU_PYTHON = "$env:TEMP\\code-guards-webgpu\\Scripts\\python.exe"
```

Then run:

```powershell
bun run benchmark:throughput --project "$env:TEMP\\tensorflow-ts-benchmark\\tsconfig.code-guards.json" --mode webgpu --mode parallel,webgpu --gpu-ids 0,1 --concurrency 4
```

This is experimental and must be hardware-validated; compare both per-adapter
counters and semantic scores before adopting it. It does not use NVLink.

Before running the full native dual-WebGPU benchmark, run
`bun run probe:dual-webgpu`. The probe initialises adapter 0 and 1,
runs an inference on each and prints either their scores or the concrete
failure. No TensorFlow project scan is needed for this smoke test.

## Fair native WebGPU scaling comparison

The `--gpu-ids` flag accepts one adapter (`0`) or several (`0,1`).
Unlike the default `webgpu` mode, both of the following use the **same
native ONNX WebGPU plugin** and model format:

```powershell
bun run benchmark:throughput --project "$env:TEMP\\tensorflow-ts-benchmark\\tsconfig.code-guards.json" --mode batch,parallel,webgpu --gpu-ids 0 --concurrency 4 --batch-size 4
bun run benchmark:throughput --project "$env:TEMP\\tensorflow-ts-benchmark\\tsconfig.code-guards.json" --mode batch,parallel,webgpu --gpu-ids 0,1 --concurrency 4 --batch-size 4
```

Question assignment across workers now favours the least-queued adapter and
rotates equal-depth assignments. This is experimental scheduling and should
be evaluated on real hardware before claiming a throughput improvement.
