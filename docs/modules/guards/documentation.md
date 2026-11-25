# Documentation coverage and accuracy checks

Source: [`src/guards/documentation.ts`](../../../src/guards/documentation.ts)

`documentation` checks for README.md, docs/index.md, a per-source-module documentation page, coverage of exported symbol names, local Markdown links and package scripts used in command examples. It also flags repeated paragraphs, generic marketing claims and leaked prompt text, and can ask `SemanticScorer` to assess candidate vague prose using local zero-shot entailment.

## Semantic documentation review

`CG411` uses local zero-shot inference to assess documentation quality.

| Scope | Assessment |
| --- | --- |
| README paragraphs | Development-session handover text |
| README introduction | Excessive focus on implementation history |
| Markdown prose | Formulaic, padded or unnecessary explanations |
| Evidence | Supporting and opposing NLI scores |
| Debug output | Set `CODE_GUARDS_SEMANTIC_TRACE=1` to print scores to stderr |

The introduction check reviews the first three prose paragraphs independently. Sentence-level checks use punctuation boundaries, including Markdown emphasis and semicolons.

Scoring uses semantic hypotheses, without keyword lists or repository-specific examples. Legitimate attribution, technical limitations and usage instructions remain relevant documentation.

The warnings concern writing quality, not authorship.

## Behaviour and boundaries

Command examples use the nearest enclosing package.json, including packages in submodules. A missing script is reported against the documentation file's own package.

Place module pages under docs/modules using the same relative path as src and ending in .md, then link them from docs/index.md. This is a consistency and evidence check, not a model-provided guarantee that every prose claim is factually true.

Set `CODE_GUARDS_EXPERIMENTAL_PROSE=1` to enable the optional prose retrieval expert for CG403. It proposes related paragraphs for MobileBERT to compare. Retrieval does not establish redundancy by itself. The [expert module](../experts.md) describes its resource limits and output.

`styleQuestion` and `handoverQuestion` are the semantic hypotheses also used by preflight to enumerate conditional work. CG411 separates wording and information-value scores, preserving useful technical facts even when wording receives a strong style signal. Unresolved information-value judgements are printed to stderr. `vagueQuestion` evaluates ordinary prose without a vocabulary gate. `informationQuestion` supplies the separate information-value assessment for both CG410 and CG411. Dependent semicolon alternatives retain the condition they qualify. Short sentences, list entries and table rows retain their Markdown role and section heading in the style assessment; fenced examples and quoted passages are excluded.

CG409 matches complete export identifiers rather than substrings. CG413 checks explicit inline TypeScript function signatures against compiler-resolved public overloads, including required parameter count, maximum arity and concrete primitive types. Contradictions identify the documentation line and related source declaration. Ordinary example calls and non-primitive type aliases are not treated as proven type contradictions.

Set `CODE_GUARDS_EXPERIMENTAL_CONTRACTS=1` to enable bidirectional semantic contract review. Compiler-resolved declarations and types are paired with passages mentioning their public identifiers, including headings and transitively linked in-scope Markdown pages. CG409 assesses the combined retrieved coverage; CG413 evaluates individual source-linked claims for contradiction. Both retain the original structural checks and report ambiguous or missing retrieval to stderr. Link traversal deduplicates pages and follows only local in-scope documentation. With `CODE_GUARDS_EXPERIMENTAL_CODE=1`, code-to-docstring embeddings add ranked passages even without an explicit identifier. Ambiguous coverage or claim scores trigger a narrower question with neighbouring section context. External library implementations are not verified. This opt-in path requires independent accuracy and workload evaluation before default activation.

`DocumentationExperts` groups the retrieval sessions and contract review selection. `documentationWithExperts` accepts these settings; the original `documentation` signature remains available for existing callers and injected scorers.

CG404 also detects temporary remediation counts and session-level progress statements outside release or migration sections. Adaptive prose review uses section context and separate wording and information-value inquiries.
