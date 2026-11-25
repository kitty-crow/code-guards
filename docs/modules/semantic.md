# Local entailment scoring

Source: [`src/semantic.ts`](../../src/semantic.ts)

`MODEL` is `Xenova/mobilebert-uncased-mnli`. `MAX_MODEL_TOKENS` is 512, the limit for its positional embeddings. `zeroShot` accepts a `SemanticQuestion` with a premise, supporting hypothesis and opposing hypothesis; it returns a `SimilarityVerdict`. `supportsReuse` requires a minimum entailment score and a margin over the opposing score. `SemanticScorer` allows deterministic test doubles.

`Classifier` is the callable model interface used by `assessWindows`: it accepts a premise and hypothesis labels and returns their scores. It carries a tokenizer and a batch callback (or `null` for single-input runtimes).

## Evidence windows

`premiseWindows` tokenises the input with the **actual model tokenizer** and calculates the remaining token budget after reserving both hypothesis lengths, BERT pair separators and a safety margin. Long premises are divided into overlapping windows without dropping the tail. `assessWindows` runs actual NLI inference on each passage and retains the maximum supporting and opposing scores across windows, plus the window indices where those scores arose. The maximum opposing score deliberately prevents an unqualified positive warning when another passage strongly disagrees. It is a conservative evidence aggregation, not a synthesis of long-range relationships or a proof of correctness.

## Behaviour and boundaries

The Transformers.js pipeline runs locally, using CPU/q8 by default or an explicitly requested accelerator. Model weights are downloaded on first use and cached.

| Option or condition | Behaviour |
| --- | --- |
| `CODE_GUARDS_OFFLINE=1` | Disable remote model retrieval |
| `CODE_GUARDS_MODEL_CACHE` | Set the model cache location |
| Hypothesis beyond token budget | Return an error |
| Premise exceeding context length | Split into overlapping token windows |
| Unit tests | Cover windowing with 695-token premises |
| Real inference | Optional integration check on the executing machine |

Model scores express semantic support; they do not prove that a refactor preserves behaviour.

## Progress observation

`observeSemanticProgress(observer)` registers a process-local callback for `SemanticProgressEvent` values `loading`, `ready` and `inference`. It returns a restoration function for the preceding observer. A loading event occurs when the MobileBERT runtime is initialised; every completed inference window emits an inference event, including windows generated from long premises. This interface reports activity without modifying classification scores, order or acceptance thresholds.


## Optional inference profiling

`observeSemanticTimings(observer)` registers a process-local callback that reports completed
`model-load`, `windowing` and `inference` phases with elapsed milliseconds from a
monotonic clock. Inference events contain the current, one-based window index and
the number of windows. The restoration callback reinstates the prior observer.
Timings do not change the classifier, evidence aggregation, thresholds or execution order.

Run `bun run benchmark:inference` for two repeated, identical semantic questions,
so the first sample includes model startup and the second captures warm inference.
The optional `CODE_GUARDS_BENCHMARK_ITERATIONS` environment variable accepts 1 to 20.
Set `CODE_GUARDS_BENCHMARK_LONG=1` to exercise overlapping evidence windows.
Use `CODE_GUARDS_OFFLINE=1` only after model weights have been cached.
The script reports JSON with model startup, window preparation, inference and
remaining overhead times for every run, plus memory use and warm-run mean.

This benchmark executes real MobileBERT inference and is deliberately excluded
from routine unit tests and hosted CI. Timing data is platform-dependent and is
not a claim that GPU execution or WASM would be faster.

## Acceleration flags

The scanner and real-model benchmark accept `--accelerate` with comma-separated
features, or repeated flags. Valid choices are `none`, `cache`, `batch`,
`cuda` and `webgpu`. Default `none` preserves CPU/q8 inference. The `none`
value is exclusive.

`cache` stores up to 512 identical semantic verdicts per scan in memory and
deduplicates concurrent calls. `batch` groups multiple inference windows,
preserving their individual positive and opposing evidence and progress events.
Use `--batch-size 2..16` only when batching is enabled; the default is 4.

CUDA and WebGPU are selected through Transformers.js 4 with FP32 weights.
They depend on actual runtime and hardware support and may give scores
different from CPU/q8. If both GPU backends are selected, their flag order
determines fallback priority. They are alternatives, not simultaneous
model sharding. There is **no implicit CPU fallback** when a GPU is requested.

When caching is enabled, repeated questions have zero new inference windows.
The benchmark separately reports the evidence-window count, actual inference
windows and whether a cached verdict was returned, preventing misleading
inference timing comparisons.

## Completed-question timing

The `verdict` event fires when all inference windows for one question
have completed, retaining the original evidence aggregation. It allows
the supervisor to count complete semantic questions separately from raw
inference windows, including the effects of batch size and cache hits.

## Cross-question batching

When both `parallel` and `batch` are enabled, `createQuestionBatcher`
interleaves windows from independent semantic questions. Windows are grouped
only when both candidate hypotheses are identical, preserving the actual
Transformers.js zero-shot classification contract. A single queue drains
batches serially on the selected model session rather than issuing competing
GPU calls in parallel. Each completed window and question is accounted for
independently, with the original maximum-positive and maximum-negative
evidence aggregation. Unlike per-question batching, this can fill batches
even when individual questions contain few evidence windows.

The ordinary `none`, `webgpu` and `batch,webgpu` paths are unchanged.

Cross-question timing includes the number of distinct semantic questions
represented in each underlying model invocation. The throughput supervisor
uses this to distinguish genuinely shared batches from batches containing
only windows belonging to one question.

The native Windows `dml` backend uses FP32, and, when a dedicated GPU worker
is selected, passes a DirectML adapter ID to ONNX Runtime via Transformers.js
session options. CPU, CUDA and WebGPU remain selectable independently.

## Scorer, worker and tokenizer contracts

`Tokenizer` provides token-ID encoding and text decoding for the model-specific vocabulary. `WindowVerdict` includes supporting and opposing entailment scores plus the evidence-window indices. `SemanticTimingEvent` identifies model-load, windowing, cache, inference, verdict and provider-proof timings.

`premiseWindowCount(question, tokenizer)` counts the exact windows from the same token plan as `premiseWindows` without decoding or running them, allowing preflight to avoid inference. `configureSemanticAcceleration(config)` scopes backend settings to a scan and returns a restoration callback; `semanticConcurrency()` reports its maximum independent pending comparisons. `semanticExecutionProvider()` reports the active device and precision.

`useRemoteSemanticScorer(scorer)` temporarily binds an external GPU pool to the ordinary semantic API. `relaySemanticWorkerEvent(event)` forwards real GPU worker timing and readiness events to observers. Preflight supplies a counting scorer directly to the guards.

`disposeLocalSemanticModel()` drains accepted local questions before releasing the Transformers.js session. The CLI awaits disposal before restoring scan settings. This does not establish that the native allocator releases physical GPU memory immediately.

`loadTransformers()` centralises offline and model-cache configuration for both tokenisers and neural models.

`NliLogits`, `RawNliWindow` and `NativeWindowVerdict` represent original native-worker entailment, neutral and contradiction logits for both hypotheses. A null window means only a legacy reduced score is available. The default Transformers.js pipeline does not expose three-class logits through its zero-shot API. `CODE_GUARDS_REQUIRE_RAW_NLI=1` requires a native CPU or WebGPU worker and rejects the reduced-score local pathway. These logits are not calibrated probabilities; the existing decision thresholds remain unchanged.

`ComparisonSide`, `ComparisonQuestion` and `comparisonQuestion` retain both entities in a long relational question. Each paired window includes both labels and a fragment from each side, with overlapping fragments covering all pair combinations. The ordinary short premise is preserved. Large comparisons retain all combinations and submit them in bounded inference batches. `semanticQuestionKey` includes the paired plan, and `premiseWindowCount` accounts for the same plan used by local and native inference. The original per-window score cache remains keyed by effective window text and hypotheses.

`semanticAccelerationConfig` exposes the active selection to the specialist scheduler so it can reject overlapping or ambiguous GPU assignments.

`investigateComparison` accepts `InvestigationOptions` with a narrower evidence-backed question. `adaptiveComparisonEnabled` selects additional investigation of ambiguous type, function, cohesion and documentation assessments via `CODE_GUARDS_EXPERIMENTAL_ADAPTIVE=1`. Decisive initial scores are retained. Ambiguous refinements identify their source context and opposing scores on stderr.
