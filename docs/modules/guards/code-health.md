# Compiler-backed local code health

Source: [`src/guards/code-health.ts`](../../../src/guards/code-health.ts)

`codeHealth` scans the parsed TypeScript project. It issues CG301–CG303 and CG305–CG308, plus CG310–CG315, for unreachable statements, simplification opportunities, ignored Promises, assertions, state handling, misplaced responsibilities, wrappers, names, dependency coupling, function contracts, mutable bindings, ineffective tests and placeholder implementations.

CG305 uses [deterministic type analysis](types.md) in addition to checking non-null assertions. It reports both explicit and inferred prohibited types.

## Behaviour and boundaries

These are candidate warnings, not automatic refactors. Test assertions are scanned even when other checks exclude test implementation code. No external model is needed for this module.

CG314 traverses executable assertion call sites instead of searching test text. It follows resolved local helpers with cycle protection, recognises imported assertion aliases and matcher calls, and checks callbacks passed to known array iteration methods. Comments, unused function bodies, bare expectations and spy registration do not constitute behavioural assertions. CG324 separately checks tautologies.

CG314 stops searching an executable block after an unconditional exit and excludes literal unreachable branches. A return expression containing a real assertion remains eligible.
