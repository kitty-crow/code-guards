# Module documentation

Code Guards runs locally; the source entry point is `src/cli.ts`. These pages describe the behaviour and public interfaces of individual modules. Build and demo commands are in the [README](../README.md).

## Core

- [Command-line interface](modules/cli.md)
- [Selectable inference acceleration](modules/acceleration.md)
- [Terminal and machine-readable reporting](modules/diagnostics.md)
- [Guard orchestration](modules/engine.md)
- [Shared diagnostics contract](modules/model.md)
- [TypeScript project loader](modules/project.md)
- [Package commands](modules/scripts.md)
- [Local entailment scoring](modules/semantic.md)

## Guards

- [Shared guard emitter](modules/guards/issue.md)
- [Compiler-backed local code health](modules/guards/code-health.md)
- [Deterministic type contracts](modules/guards/types.md)
- [Cross-module conventions and configuration](modules/guards/cross-module.md)
- [Documentation coverage and accuracy checks](modules/guards/documentation.md)
- [Excessively long or enterprise-style names](modules/guards/enterprise-looking-naming.md)
- [Cross-cutting review practices](modules/guards/review-practices.md)
- [Guard exports](modules/guards/index.md)
- [Function and method quality checks](modules/guards/function-quality.md)
- [Module responsibility and cohesion](modules/guards/module-cohesion.md)
- [Nested conditional detection](modules/guards/no-nested-if.md)
- [Repository script and workflow checks](modules/guards/repo-hygiene.md)
- [Cross-module type reuse](modules/guards/type-reuse.md)

The scripts in `package.json` are the authoritative build, test and demonstration commands. Individual script files do not require separate documentation pages.
