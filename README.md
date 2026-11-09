# Code Guards

Local TypeScript quality checks for builds, tests and agent-generated changes. The CLI reports the offending line, why it matters and a suggested correction. With no `--strict`, findings are warnings and the command exits 0; `--strict` exits 1 if a warning is found. Code Guards does not change the `tsc` compiler, install itself into a scanned repository or require GitHub Actions.

## Get started

From a Code Guards checkout, use Bun on Linux, macOS or Windows, or Node.js 20+ with npm:

```sh
bun install
bun run ci:bun
bun run demo:bun
bun run demo:strict:bun
```

`ci:bun` type-checks, builds, runs tests and scans Code Guards itself in strict mode. The demo uses intentionally bad TypeScript. The strict demo exits 1 by design. Use a Linux-native toolchain in WSL; Windows npm cannot run reliably from a WSL UNC working directory.

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

All 20 guards are enabled unless selected individually or disabled by name. For example, `bun run guards:bun --path ../tracker-viewer --disable documentation`. `--strict` fails on a warning; `--format json|github|text` chooses output, and `--colour auto|always|never` controls terminal colour. `--include-tests` includes test files in the optional type/function analyses. `--offline` requires a cached model. An invalid or empty path exits 2 with an explanation.

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

### README and documentation

| Code | What it detects |
| --- | --- |
| `CG400` | Missing top-level README |
| `CG401` | Promotional wording without verifiable behaviour |
| `CG402` | README without runnable installation, build or usage commands |
| `CG403` | Substantially repeated documentation paragraphs |
| `CG405` | AI prompt-style instructions appearing as user documentation |
| `CG406` | Documented `npm run`/`bun run` command not present in package scripts |
| `CG407` | Missing `docs/index.md`, module link or README index reference |
| `CG408` | Source module lacking its own documentation page |
| `CG409` | Module documentation too brief or missing public exports |
| `CG410` | Ambiguous/vague prose endorsed by local zero-shot inference |
| `CG412` | Broken relative Markdown link |
| `CG413` | Documented completion claim conflicts with a source placeholder |

### Repository housekeeping

| Code | What it detects |
| --- | --- |
| `CG501` | Build or test script executes the same step redundantly |
| `CG502` | Two scripts perform the identical test or CI command |
| `CG503` | Source and compiled Bun tests may be executed twice |
| `CG504` | Duplicate commands across GitHub workflow definitions |

The currently unused identifiers `CG404` and `CG411` are intentionally unassigned; they are not active rules. For implementation detail and each module's exports, consult [docs/index.md](docs/index.md).

## Semantic analysis and limitations

The `type-reuse`, `function-quality` and `documentation` guards use `Xenova/mobilebert-uncased-mnli` through `@huggingface/transformers` for *shortlisted* ambiguous comparisons. Model inference is local on CPU and downloads weights on first use unless `--offline` is set. Semantic warnings express a likelihood, **not proof** of equivalence, an unsafe change, or factual inaccuracy. TypeScript AST checks can verify narrower issues such as duplicate structures, missing exports, undefined package scripts and broken local links. Model loading failures exit 2 rather than silently substituting a heuristic decision.

To inspect the output on deliberately problematic source, run `bun run demo:bun` and `bun run demo:housekeeping:bun`. To test actual model judgement on ambiguity, run `bun run demo:semantic:bun`. Unit tests inject controlled scorer responses for repeatable tests; a passing mocked unit test is not evidence that actual MNLI inference has succeeded on your machine.

## Development

```sh
bun run ci:bun
bun run guards:strict:bun
bun run test:bun
```

Code Guards scans itself in local strict CI. New guards should include failing and passing fixtures plus a strict-mode exit-code test. No GitHub-hosted CI is configured. This private repository is not published to npm; if dependency integration is desired, install it over HTTPS from the Git repository instead of copying source files.

MIT licence.
