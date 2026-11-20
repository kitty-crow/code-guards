# Local entailment scoring

Source: [`src/semantic.ts`](../../src/semantic.ts)

`MODEL` is `Xenova/mobilebert-uncased-mnli`. `MAX_MODEL_TOKENS` is 512, the limit for its positional embeddings. `zeroShot` accepts a `SemanticQuestion` with a premise, supporting hypothesis and opposing hypothesis; it returns a `SimilarityVerdict`. `supportsReuse` requires a minimum entailment score and a margin over the opposing score. `SemanticScorer` allows deterministic test doubles.

## Evidence windows

`premiseWindows` tokenises the input with the **actual model tokenizer** and calculates the remaining token budget after reserving both hypothesis lengths, BERT pair separators and a safety margin. Long premises are divided into overlapping windows without dropping the tail. `assessWindows` runs actual NLI inference on each passage and retains the maximum supporting and opposing scores across windows, plus the window indices where those scores arose. The maximum opposing score deliberately prevents an unqualified positive warning when another passage strongly disagrees. It is a conservative evidence aggregation, not a synthesis of long-range relationships or a proof of correctness.

## Behaviour and boundaries

The Transformers.js pipeline runs locally on CPU. Model weights are downloaded on first use and cached.

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
