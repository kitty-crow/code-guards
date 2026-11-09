# Code Guards

TypeScript quality checks for local builds, tests and agent-generated changes. Each guard reports the source line, a reason and a suggested fix. Without `--strict` the warnings are advisory; `--strict` returns exit code 1 for any warning. Code Guards does not replace `tsc` and does not run GitHub Actions.

## Run it

Use Bun on Linux, macOS or Windows, or Node.js 20+ with npm. The CLI compiles to ordinary JavaScript. After cloning:

```sh
bun install
bun run ci:bun
bun run demo:bun
bun run demo:strict:bun
```

`ci:bun` type-checks, builds, runs tests and scans Code Guards itself with `--strict`. The demo intentionally contains four warnings. `demo:strict:bun` exits 1; that failure is expected. To run the real model on deliberately ambiguous code, use `bun run demo:semantic:bun` after the model runtime has been installed.

For Node.js users, `npm install` and `npm run ci` run the corresponding Node scripts. Do not invoke Windows npm against a WSL filesystem path; use a package manager installed in that Linux environment.

To scan another project, first build the CLI, then pass the project's tsconfig:

```sh
bun run build
bun dist/src/cli.js --project ../my-project/tsconfig.json
bun dist/src/cli.js --project ../my-project/tsconfig.json --strict
```

The default scan enables all guards. Disable a specific rule with `--disable name`, repeated as needed, or select one by its name. `--format json` produces machine-readable findings; `--format github` produces annotations; `--colour always|auto|never` controls terminal colour. `--include-tests` includes tests in optional source scans. `--offline` requires a previously cached model.

## What is checked

The initial rules cover conditional nesting, duplicate types and functions, unused or risky code paths, unsafe asynchronous operations, misleading type assertions, questionable abstractions, repeated configuration, test/script duplication and documentation housekeeping. The [module index](docs/index.md) describes each rule family and its limits.

`type-reuse`, `function-quality` and `documentation` use `Xenova/mobilebert-uncased-mnli` via `@huggingface/transformers` for shortlisted ambiguous comparisons. Inference runs locally on CPU with cached weights. The model can make mistakes; confidence scores do not prove that two implementations are equivalent or that a document is factually wrong. Compiler-backed checks verify narrower facts such as missing exports, unavailable scripts or broken links. Download failures are reported instead of silently substituting a fake model.

## Test the guard output

```sh
bun run demo:bun
bun run demo:strict:bun
bun run demo:semantic:bun
```

The example sources live in `examples/` and are excluded from the library's strict self-check. The tests use controlled inference responses to exercise NLP decision paths without needing a download. Each new rule should include a positive fixture, a clean counterexample and an exit-status test. The [documentation index](docs/index.md) maps the code to its module pages.

MIT licence. This repository is not published to npm; install it from the Git repository using HTTPS when dependency integration is required.
