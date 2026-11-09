# Documentation coverage and accuracy checks

Source: [`src/guards/documentation.ts`](../../../src/guards/documentation.ts)

`documentation` checks for README.md, docs/index.md, a per-source-module documentation page, coverage of exported symbol names, local Markdown links and package scripts used in command examples. It also flags repeated paragraphs, generic marketing claims and leaked prompt text, and can ask `SemanticScorer` to assess candidate vague prose using local zero-shot entailment.

`CG411` uses two independent MobileBERT entailment judgements on prose paragraphs without a lexical shortlist. It reports development-session handover narratives only when both support that interpretation and neither has substantial contrary evidence. Mentioning a guard, an API, a test or a limitation is not enough. It reports the paragraph location and actionable rewrite suggestion. Tests cover both temporary handover prose and ordinary technical reference passages using controlled semantic verdicts. The strict self-scan uses the actual local model.

## Behaviour and boundaries

Place module pages under docs/modules using the same relative path as src and ending in .md, then link them from docs/index.md. This is a consistency and evidence check, not a model-provided guarantee that every prose claim is factually true.
