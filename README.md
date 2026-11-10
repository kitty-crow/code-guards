# Code Guards

Code Guards checks local TypeScript projects for code quality and documentation problems. Findings include source locations and suggested corrections.

| CLI mode | Result |
| --- | --- |
| Default | Warnings, exit 0 |
| `--strict` | Exit 1 if any warning is reported |
| Invalid options or target | Exit 2 |

The scan does not modify the target project or change TypeScript's compiler behaviour.

## Get started

From a Code Guards checkout, use Bun on Linux, macOS or Windows, or Node.js 20+ with npm:

```sh
bun install
bun run ci:bun
bun run demo:bun
bun run demo:strict:bun
bun run demo:coverage:bun
```

`ci:bun` type-checks, builds, runs core tests and scans Code Guards itself in strict mode. The warning-heavy showcase tests are optional: `bun run test:showcase:bun` runs them separately, while `bun run ci:full:bun` includes them alongside the normal checks. The demo uses intentionally bad TypeScript. The strict demo exits 1 by design. Use a Linux-native toolchain in WSL; Windows npm cannot run reliably from a WSL UNC working directory.

## Scan any local TypeScript project without installing Code Guards there

Run the command **from Code Guards** after cloning and building it. The target path can be absolute or relative to the current working directory:

```sh
bun run guards:bun --path ../tracker-viewer
bun run guards:strict:bun --path ../tracker-viewer
bun run guards:bun --path /home/javier/projects/my-app --format json
bun run guards:bun no-nested-if --path ../tracker-viewer/src/main.ts
```

`--path` accepts a directory, an individual `.ts`/`.tsx`/`.mts`/`.cts` file, or a `tsconfig*.json` file. A directory with `tsconfig.json` uses its compiler configuration; without one, Code Guards recursively discovers TypeScript source files while excluding `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.cache` and `out`. No files are copied or written to the target repository.

The existing `--project ../tracker-viewer/tsconfig.json` flag remains available for explicit TypeScript configurations. `--project` and `--path` cannot be used together. From any working directory you can instead call `bun /absolute/path/to/code-guards/dist/src/cli.js --path /absolute/path/to/project` after building the CLI. The model weights, if needed, are cached where Code Guards runs, not installed into the target project.

All 21 guards run by default. Pass a guard name to select it, or use `--disable` to exclude it:

```sh
bun run guards:bun --path ../tracker-viewer --disable documentation
```

| Option | Behaviour |
| --- | --- |
| `--strict` | Fail on warnings |
| `--format json\|github\|text` | Select report format |
| `--colour auto\|always\|never` | Set terminal colour |
| `--include-tests` | Include test files in type/function analysis |
| `--offline` | Use cached model weights only |

## Reproducible coverage demonstrations

`bun run demo:coverage:bun` prints **one formatted warning for each active code** using deliberate faults in `examples/coverage/codebase` and `examples/coverage/documentation`. `bun run demo:coverage:bun --code CG413` focuses on a single rule. `bun run demo:coverage:bun --strict` prints the same warnings and exits 1; `--json` returns machine-readable diagnostics. Node users can run `npm run demo:coverage` or `node examples/coverage/run.mjs` after building the project. The test suite verifies that every code listed in the table below appears in the demonstration.

**Inference disclosure:** This coverage showcase injects fixed, labelled zero-shot verdicts for reproducibility. It validates guard integration and reporting, but is not evidence of real MobileBERT quality. `bun run demo:semantic:bun` uses the actual model. To smoke-test the ONNX model itself with a deliberately overlong premise, run `bun run demo:model:bun` (or `npm run demo:model` under native Node). It downloads and executes real MobileBERT inference; it is deliberately **not** run as part of the routine unit tests. Long NLI inputs are tokenised and split into overlapping passages respecting MobileBERT's 512-token limit; evidence from all passages is combined conservatively.

The `enterprise-looking-naming` guard checks functions, classes, methods, types, variables, parameters, members, aliases, filenames and directories. It identifies very long descriptive names and stacked generic suffixes. For instance, a function called `veryLongNamesThatAreVerySpecificAndMightNeedShortening` can be shortened to an abbreviation such as `lngNms` if that is clear in context. It never applies renames automatically.

The `review-practices` guard checks code and test maintainability:

- Comments that narrate individual statements
- Unresolved APIs and inconsistent conventions
- Repeated logic, redundant catches and weak assertions
- Unnecessary abstractions

`CG404` flags development history presented as current functionality. `CG405` flags instructions addressed to AI agents instead of software users.

Release history belongs in `CHANGELOG.md` or a migration guide.

## Warning reference

### Control flow and type reuse

| Code | What it detects |
| --- | --- |
| `CG001` | Nested `if` or `else if`; offers a control-flow-preserving refactor where possible |
| `CG101` | Identical type structures declared in separate modules |
| `CG102` | Different types with overlapping fields, potentially reusable |
| `CG103` | Types possibly describing the same concept, based on zero-shot analysis |

### Functions and methods

| Code | What it detects |
| --- | --- |
| `CG201` | Function may need decomposition into smaller responsibilities |
| `CG202` | Complex function may need explanatory comments |
| `CG203` | Function depends on many other source modules |
| `CG204` | Short, stateless class method may be better as a helper |
| `CG205` | Duplicate or highly similar function implementations |

### Code integrity and maintainability

| Code | What it detects |
| --- | --- |
| `CG301` | Unreachable code after unconditional exits |
| `CG302` | Redundant boolean conditional returning its own test |
| `CG303` | Ignored promises or empty catch clauses |
| `CG304` | Duplicated configuration strings across modules |
| `CG305` | Non-null assertions or `any` casts that bypass type safety |
| `CG306` | Missing string-union cases in a switch statement |
| `CG307` | Class method that may not use or belong to instance state |
| `CG308` | Stateless forwarding method that may be unnecessary |
| `CG309` | Direct `fetch` call that bypasses a central API client |
| `CG310` | Generic, uninformative function names |
| `CG311` | Large number of direct local module imports |
| `CG312` | Too many function arguments, optional values or boolean flags |
| `CG313` | `let` binding never reassigned, potentially a `const` |
| `CG314` | Test callback with no recognisable assertion |
| `CG315` | Placeholder marker in an apparently unfinished function |
| `CG316` | Excessively long or overdescriptive identifiers across declarations and members |
| `CG317` | Filler-heavy identifiers and stacked enterprise-style suffixes such as `ManagerServiceImplementation` |
| `CG318` | Overdescriptive TypeScript filenames or directory names |
| `CG319` | Obvious narration comments that restate a loop, conditional or statement |
| `CG320` | Unresolved methods, exports or call signatures verified against TypeScript diagnostics |
| `CG321` | Local identifier naming style diverging from an established convention |
| `CG322` | Three consecutive nontrivial statements repeated in separate modules |
| `CG323` | Redundant catch handlers that only rethrow the original error |
| `CG324` | Tautological test assertions such as `assert.ok(true)` or `expect(1).toBe(1)` |
| `CG325` | Stateless class shells with one trivial method and no instance contract |
| `CG326` | Multiple date-formatting mechanisms in one module requiring consistency review |

### README and documentation

| Code | What it detects |
| --- | --- |
| `CG400` | Missing top-level README |
| `CG401` | Promotional wording without verifiable behaviour |
| `CG402` | README without runnable installation, build or usage commands |
| `CG403` | Substantially repeated documentation paragraphs |
| `CG404` | Development or release-note narratives disguised as features in README/module documentation |
| `CG405` | AI prompt-style instructions appearing as user documentation |
| `CG406` | Documented `npm run`/`bun run` command not present in package scripts |
| `CG407` | Missing `docs/index.md`, module link or README index reference |
| `CG408` | Source module lacking its own documentation page |
| `CG409` | Module documentation too brief or missing public exports |
| `CG410` | Ambiguous/vague prose endorsed by local zero-shot inference |
| `CG411` | NLP-classified development handover or implementation-status narration in user documentation |
| `CG412` | Broken relative Markdown link |
| `CG413` | Documented completion claim conflicts with a source placeholder |

### Repository housekeeping

| Code | What it detects |
| --- | --- |
| `CG501` | Build or test script executes the same step redundantly |
| `CG502` | Two scripts perform the identical test or CI command |
| `CG503` | Source and compiled Bun tests may be executed twice |
| `CG504` | Duplicate commands across GitHub workflow definitions |

For implementation detail and each module's exports, consult [docs/index.md](docs/index.md).

## Semantic analysis and limitations

The `type-reuse`, `function-quality` and `documentation` guards use `Xenova/mobilebert-uncased-mnli` through `@huggingface/transformers` for *shortlisted* ambiguous comparisons. Model inference is local on CPU and downloads weights on first use unless `--offline` is set. Semantic warnings express a likelihood, **not proof** of equivalence, an unsafe change, or factual inaccuracy. TypeScript AST checks can verify narrower issues such as duplicate structures, missing exports, undefined package scripts and broken local links. Model loading failures exit 2 rather than silently substituting a heuristic decision.

The demonstration commands use different evidence sources:

| Command | Evidence |
| --- | --- |
| `bun run demo:bun` | Deliberately faulty TypeScript |
| `bun run demo:housekeeping:bun` | Housekeeping violations |
| `bun run demo:semantic:bun` | Real MobileBERT inference |
| `bun run test:bun` | Unit tests, including injected semantic scores |

## Development

```sh
bun run ci:bun
bun run guards:strict:bun
bun run test:bun
```

`bun run ci:bun` includes the strict Code Guards self-scan. New guard tests should cover passing and failing cases plus the strict-mode exit code.

Package status: private repository, not published to npm. GitHub-hosted CI is not configured.

MIT licence.
