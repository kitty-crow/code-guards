# Cross-cutting review practices

Source: [`src/guards/review-practices.ts`](../../../src/guards/review-practices.ts)

`reviewPractices(project, includeTests = false)` returns `Finding[]` without rewriting the target project. The guard is enabled by default. Run it alone from the Code Guards checkout:

```sh
bun run guards:bun review-practices --path ../my-project
bun run guards:strict:bun review-practices --path ../my-project
```

## Checks and evidence

- `CG319`: comment immediately before a loop, return or assignment uses formulaic narration. Rephrase as a reason or invariant if useful; otherwise remove it.
- `CG320`: TypeScript semantic diagnostics confirm an unavailable property or method, bad import or invalid call. Consult the installed dependency types, not generated assumptions.
- `CG321`: a local snake_case or camelCase declaration conflicts with at least three consistently styled peer declarations. External protocols may require exceptions.
- `CG322`: three consecutive nontrivial statements have the same implementation in separate modules. Extract common behaviour only if the contracts agree.
- `CG323`: a catch block only rethrows the captured error. Remove redundant ceremony without losing finally cleanup.
- `CG324`: test assertions compare literal constants with themselves or assert unconditional truth. Assert the observable behaviour instead.
- `CG325`: a class contains one stateless method, no state and no inheritance. Consider a function if class identity is not part of a contract.
- `CG326`: the module uses both `Intl.DateTimeFormat` and `toLocaleDateString`. Consider a shared locale/time-zone policy.

The purpose is code quality and reviewability, independent of authorship. The rules do not estimate who or what produced the code. `CG320` is backed by TypeScript diagnostics; the other checks are intentionally conservative and may warrant human review. Test files are scanned for weak assertions by default, while other checks skip test declarations unless `--include-tests` is set.
