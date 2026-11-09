# Documentation coverage and accuracy checks

Source: [`src/guards/documentation.ts`](../../../src/guards/documentation.ts)

`documentation` checks for README.md, docs/index.md, a per-source-module documentation page, coverage of exported symbol names, local Markdown links and package scripts used in command examples. It also flags repeated paragraphs, generic marketing claims and leaked prompt text, and can ask `SemanticScorer` to assess candidate vague prose using local zero-shot entailment.

## Behaviour and boundaries

Place module pages under docs/modules using the same relative path as src and ending in .md, then link them from docs/index.md. This is a consistency and evidence check, not a model-provided guarantee that every prose claim is factually true.
