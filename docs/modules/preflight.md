# Read-only inference preflight

Source: [src/preflight.ts](../../src/preflight.ts)

The `--preflight` CLI option estimates semantic questions and token-bounded evidence windows without running MobileBERT inference. It parses the genuine TypeScript project and calls the production type-reuse, function-quality and documentation guards with an accounting-only scorer. Guards without semantic inference have no neural workload to enumerate.

## Usage

```sh
bun src/cli.ts all --project ../example-project/tsconfig.code-guards.json --preflight --include-tests --accelerate batch,parallel,webgpu --gpu-ids 0,1 --concurrency 4 --batch-size 4 --format json
```

No model weights, ONNX sessions or GPU workers are loaded. Only the Xenova/mobilebert-uncased-mnli tokenizer is initialised. On the first run it may download tokenizer assets, but never model weights. `--offline` requires an existing tokenizer cache. `CODE_GUARDS_MODEL_CACHE` selects the cache location.

## Reusing deterministic candidate selection

Both production and preflight run the same type-reuse candidate-pair index, fingerprint comparisons, exact-match exclusions, structural/semantic field thresholds and same-file exclusions. Exact matches do not submit semantic questions. Function quality reuses the existing complexity/design triggers and deterministic near-duplicate shortlist. Documentation reuses README introduction, handover and style checks and the threshold for potentially vague prose.

## Token counts and model calls

`premiseWindowCount` and `premiseWindows` share one MobileBERT token-budget function. It uses the production 512-token context, both hypothesis lengths, special pair tokens, the safety margin and 48-token overlap. Counting does not decode the windows. The result lists question counts, evidence windows and estimated model invocations by guard and in total.

Without cross-question batching, calls equal the sum of the window batches for each question. The in-process `parallel,batch` scheduler can merge windows only when both hypotheses match, so the lower bound groups compatible windows and the upper bound batches questions separately. Explicit physical GPU workers process each question independently. The optional `cache` feature uses the same 512-entry, first-in-first-out question cache; real parallel completion timing may affect cache eviction.

## What preflight cannot know without inference

Documentation has adaptive selection: a strong README handover verdict can suppress the style questions for that paragraph. Preflight runs the unchanged documentation guard with two opposing synthetic verdicts to calculate possible minimum and maximum workloads. The real question count depends on the model verdicts.

The only available reference duration estimates use measured native WebGPU throughput of 1,569 windows per 60 seconds on one RTX 2080 Ti and 3,372 windows per 60 seconds on two. They are warm inference-only calibration estimates, not forecasts of total wall-clock time, and exclude model preparation, tokenisation, downloads, GPU contention and scheduling. Other configurations report work counts without unsupported timing estimates.

Preflight does not write to the target project and does not emit ordinary findings. `--format json` returns machine-readable bounds and limitations; otherwise it prints a short text report. `--strict` has no effect on preflight because it never produces inferred violations.

## Public preflight API

`loadPreflightTokenizer()` loads the named MobileBERT tokenizer/configuration without initialising an inference session or downloading model weights. `estimateInference(config, acceleration, tokenizer?, progress?)` accepts ordinary `AnalysisOptions`, shares the production candidate selection and returns an `InferencePreflight` JSON-compatible result. Tests can inject a deterministic tokenizer rather than using the network.

`InferenceCounter` implements the no-inference semantic scoring observer and exposes `reject`, `accept` and `snapshot()`. It returns an `InferenceWork` measurement with question, window and model-call bounds. Each `PreflightStage` records those bounds per guard. `formatInferencePreflight(result)` renders the full result for a human-readable CLI output without creating guard findings. The `InferencePreflight` result also contains optional calibration metadata, configuration and limitations.

Module-cohesion preflight counts the initial module questions and the conditional pair comparisons. Deterministic-only preflight does not load a tokenizer. Experimental prose retrieval requires embeddings, so its additional questions are excluded from the estimate.
