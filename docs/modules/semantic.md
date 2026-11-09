# Local entailment scoring

Source: [`src/semantic.ts`](../../src/semantic.ts)

`MODEL` identifies Xenova/mobilebert-uncased-mnli. `zeroShot` accepts a `SemanticQuestion` with a premise, supporting hypothesis and opposing hypothesis and returns a `SimilarityVerdict`. `supportsReuse` requires an entailment threshold and a margin over the opposing score. `SemanticScorer` permits controlled inference injection in tests.

## Behaviour and boundaries

The Transformers.js pipeline runs on CPU and loads weights lazily. `CODE_GUARDS_OFFLINE=1` disables remote model retrieval and `CODE_GUARDS_MODEL_CACHE` overrides the cache. A model score cannot establish that a proposed refactor is behaviour-preserving.
