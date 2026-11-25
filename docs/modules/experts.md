# Inference experts

Source: [src/experts.ts](../../src/experts.ts)

`guardCapabilities` identifies which guards require compiler facts, a final semantic judgement or prose retrieval. `FINAL_JUDGE` describes the existing MobileBERT pathway. `Capability` names the tasks, `ExpertProfile` records the model revision, licence, context, provider, precision and cache namespace.

`PROSE_EXPERT` identifies [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/5356e92506bd45bf15c2295d5c8e19b5bc7abf94), an Apache-2.0 sentence embedding model with FP32 ONNX weights of approximately 90.4 MB. Its 256-token context is reserved for complete paragraphs and special tokens. It runs on CPU, not the physical GPU pool.

`SourceEvidence` records text and location. `ProseMatch` records both passages and cosine relevance. `RetrievalResult` separates candidate pairs from passages exceeding the token budget. `EmbeddingRuntime` defines batch encoding and disposal. `ExpertMetrics` reports loads, batches, cache hits, loading time, sampled peak RSS and RSS after disposal.

`ProseExpert` accepts an injectable runtime and process RSS budget. It loads only when requested, processes at most eight paragraphs per batch, retains up to 1,024 content-addressed embeddings in memory and drains accepted work before closing. Incompatible checkpoint revisions, precision and preprocessing have separate cache identities. Embeddings are not published to Git.

`configuredProseExpert` enables the specialist only with `CODE_GUARDS_EXPERIMENTAL_PROSE=1`. Set `CODE_GUARDS_EXPERT_RAM_MIB` to specify the absolute process RSS limit in MiB (default 2048). RSS samples before loading and after each model operation are not a hard native-memory allocator limit. The model respects the existing offline and model-cache environment settings. An explicitly requested expert failure terminates the scan.

The documentation guard sends proposed pairs to MobileBERT. Cosine relevance ranks evidence, not finding confidence. Long paragraphs are identified in stderr rather than silently truncated. Existing lexical comparisons still run. Real-model accuracy, resource release, throughput and an ablation study are required before enabling this experiment by default.

`EmbeddingExpert` is the common retrieval runtime. `RetrievalFilter` restricts comparisons to eligible source pairs before ranking. `CODE_EXPERT` describes [Jina code embeddings](https://huggingface.co/jinaai/jina-embeddings-v2-base-code/tree/9d61b434b354511c603038133a8c1ce2190e4d98): Apache-2.0, 768 dimensions, 8192-token model context, FP32 ONNX weights of approximately 642 MB. `CodeExpert` caps inputs at 1024 tokens and batches at two inputs to bound experimental CPU memory use. `configuredCodeExpert` requires `CODE_GUARDS_EXPERIMENTAL_CODE=1`. The function-quality guard releases this model after retrieval, before asking MobileBERT to judge the additional pairs. No extra model is allocated on a GPU by this pathway.
