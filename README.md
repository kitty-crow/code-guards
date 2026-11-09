# Code Guards

Reusable, AST-based checks for TypeScript repositories. Each guard is an independent module; the CLI can run them separately or together.

## Guards

| Guard | Rule | Default outcome |
| --- | --- | --- |
| `no-nested-if` (`CG001`) | Reject an `if` within another `if`, including `else if`. A new function scope resets the nesting count. | Error |
| `type-reuse` (`CG101`–`CG103`) | Find potentially redundant interfaces, type aliases and related class concepts across modules. | Warning or information |

Type reuse first resolves structural shapes with the TypeScript compiler. It also compares field names, field types and a small set of lexical synonyms to suggest conceptually related declarations. **This first version does not run a language model or claim semantic equivalence.** A local embedding model may be added as an optional second-stage scorer, once the deterministic candidate generation is established.

Two declarations that look alike can represent intentionally different domain concepts. Type-reuse findings are suggestions, never automatic edits. Classes are not treated as interchangeable simply because their fields match. Primitive aliases and single-field records are omitted to keep noise down. A scalar and an array of that scalar are not duplicates.

## Run in another repository

Install Bun and add TypeScript plus this repository as a development dependency, or run the source CLI directly from a checkout:

```sh
bun install
bun src/cli.ts all --project path/to/tsconfig.json
bun src/cli.ts no-nested-if --project path/to/tsconfig.json
bun src/cli.ts type-reuse --project path/to/tsconfig.json
```

For a project that depends on this package, invoke `bunx code-guards type-reuse --project tsconfig.json` or `bunx code-guards all`.

Options: `--format text|json|github`, `--fail-on error|warning|never`, `--include-tests` (type reuse only), and `--project`.

Default exit status is 1 for errors, 2 for configuration failures and 0 for warnings/information. Set `--fail-on warning` to make structural duplication block CI. GitHub format emits workflow annotations.

## Development

```sh
bun install
bun run ci
```

CI runs strict TypeScript type-checking, tests, and the independent guards. The project is MIT licensed.

## Current limitations

- Similarity is a heuristic: no ML-based inference yet, and synonyms are deliberately conservative.
- Type fingerprints cover common primitives, unions, arrays, tuples, object properties, index signatures and callable types; complex generic or recursive types may require manual review.
- Candidate generation deliberately skips extremely common field-name buckets to reduce quadratic comparisons in large projects.
- No cross-repository index, incremental PR baseline or suppression file yet.
