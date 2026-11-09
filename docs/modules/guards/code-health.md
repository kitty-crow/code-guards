# Compiler-backed local code health

Source: [`src/guards/code-health.ts`](../../../src/guards/code-health.ts)

`codeHealth` scans the parsed TypeScript project. It issues CG301–CG303 and CG305–CG308, plus CG310–CG315, for unreachable statements, simplification opportunities, ignored Promises, assertions, state handling, misplaced responsibilities, wrappers, names, dependency coupling, function contracts, mutable bindings, ineffective tests and placeholder implementations.

## Behaviour and boundaries

These are candidate warnings, not automatic refactors. Test assertions are scanned even when other checks exclude test implementation code. No external model is needed for this module.
