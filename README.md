# Code Guards

Local, engine-agnostic TypeScript quality checks. **All guards are enabled by default** and can be individually disabled. Findings are advisory unless you pass `--strict`, in which case warnings produce a non-zero exit code, suitable for npm/Bun build and test scripts. No GitHub Actions workflows are included or required.

## Available guards

| Guard | Warnings | How it works |
| --- | --- | --- |
| `no-nested-if` | `CG001` | TypeScript AST detects nested `if` and `else if` within the same function. Provides context-sensitive advice about guard clauses, early returns and safe flattening. |
| `type-reuse` | `CG101`, `CG102`, `CG103` | TypeScript compiler identifies identical or overlapping declaration shapes; **actual zero-shot NLI** checks non-exact candidates for conceptual equivalence. |
| `function-quality` | `CG201` to `CG205` | AST metrics propose candidates for decomposition, comments, module ownership, helper/arrow conversion and duplicated functions. **Actual zero-shot NLI** assesses the ambiguous cases; exact duplicate bodies are deterministic. |

`no-nested-if` remains independent of NLP because its AST check and guidance are deterministic. Type reuse and function quality use **`@huggingface/transformers@3.8.1` with `Xenova/mobilebert-uncased-mnli`** on the local CPU/ONNX backend, not a predefined synonym table pretending to be NLP. Lexical/structural rules only **shortlist candidates** to keep model inference affordable. There is no online inference service; the model weights are downloaded on first use, then cached locally.

An ML prediction is **not proof** of semantic equivalence. In particular, two structurally identical types can be intentionally distinct, a scalar is not an array, and a class can carry runtime semantics beyond its fields. All reports ask for a human review. No code is rewritten automatically.

## Local installation and execution

Use Node.js 20+ (npm) or Bun. The package compiles to standard JavaScript, with a `code-guards` executable; the CLI itself contains no Bun-specific APIs.

```sh
npm install
npm run ci                 # local typecheck, tests, build and strict self-check
npm run guards            # all guards, advisory
npm run guards:strict     # all guards, non-zero exit on warnings
npm run guards -- type-reuse --project tsconfig.json
npm run guards -- --disable function-quality
npm run guards -- --offline
```

On Bun, the same package scripts work with `bun run build`, `bun run test` and `bun run guards -- --strict`. For direct execution after building: `node dist/src/cli.js --strict` or `bun dist/src/cli.js --strict`.

To add it to another private project, install from the Git repository (with appropriate GitHub access):

```sh
npm install --save-dev git+ssh://git@github.com/kitty-crow/code-guards.git
```

Then add to **that project's** `package.json`:

```json
{
  "scripts": {
    "guard": "code-guards --strict --project tsconfig.json",
    "build": "tsc --noEmit && code-guards --strict",
    "test": "node --test && code-guards --strict"
  }
}
```

Equivalent `bun run build`, `bun run test`, `npm run build` and `npm test` will fail on guard findings because the **guard command** returns exit code 1. It does not modify TypeScript's compiler or literally inject diagnostics into `tsc`.

### Options

- `--strict`: warnings exit with code 1. Without this flag, findings are printed but exit code is 0.
- `--disable no-nested-if|type-reuse|function-quality`: opt out of one guard; repeat as needed.
- `no-nested-if`, `type-reuse`, `function-quality`, `all`: optionally run just one guard, or all.
- `--project path/to/tsconfig.json`: choose a TypeScript project.
- `--include-tests`: include test declarations in type-reuse/function-quality checks.
- `--format text|json|github`: plain diagnostics, machine-readable JSON or annotations.
- `--offline`: require locally cached model weights; never fetch remote files. Equivalent to `CODE_GUARDS_OFFLINE=1`.

`CODE_GUARDS_MODEL_CACHE` overrides the model cache directory. Model loading failures are **reported as errors (exit 2)**, never silently replaced by heuristic decisions. The first semantic scan requires model weights to be downloaded if not already cached.

## Bootstrap and tests

`npm run ci` invokes Code Guards against **its own source** after building it. Unit tests inject deterministic fake scorer responses to verify NLI integration and rejection logic without the very large model download. The full local self-check runs the real model when installed and cached.

## Limitations

This is an early implementation. Semantic candidate generation is conservative, complex recursive/generic type shapes are approximated, and code-quality signals are recommendations rather than correctness proofs. A local incremental inference-results cache, per-rule suppression comments and an opt-in model integration test would improve performance and reproducibility for large repositories.

MIT licence.
