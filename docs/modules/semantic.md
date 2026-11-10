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
