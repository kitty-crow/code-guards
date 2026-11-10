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

Place module pages under docs/modules using the same relative path as src and ending in .md, then link them from docs/index.md. This is a consistency and evidence check, not a model-provided guarantee that every prose claim is factually true.
