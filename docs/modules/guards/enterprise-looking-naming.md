# Enterprise-looking naming

`src/guards/enterprise-looking-naming.ts` exports `enterpriseLookingNaming(project, includeTests = false)` and returns advisory `Finding[]`. It inspects TypeScript declaration identifiers and file/directory names. It does not rename source files or symbols.

## What it detects

- `CG316` finds long multiword identifiers in functions, variables, classes, methods, parameters, types, members and local import aliases. For example, `veryLongNamesThatAreVerySpecificAndMightNeedShortening` is flagged; `lngNms` is acceptable.
- `CG317` finds names with filler words or stacked role suffixes, such as `CustomerDataManagerServiceHandlerImplementation`. This is independent of length and can overlap `CG316`.
- `CG318` finds overdescriptive `.ts`/`.tsx`/`.mts`/`.cts` file or directory segments. Each directory is reported once, even when many files share its path.

## Scope and suggested changes

| Area | Behaviour |
| --- | --- |
| Suggestions | Abbreviations to review before changing source |
| Public APIs | Check callers, imports and compatibility before renaming |
| Exclusions | Generated and vendor sources |
| Tests | Excluded unless `--include-tests` is passed |
| Locations | Reports declarations without repeating warnings at references |

## Usage

```sh
bun run guards:bun enterprise-looking-naming --path ../my-project
bun run guards:strict:bun enterprise-looking-naming --path ../my-project
bun run guards:bun --path ../my-project --disable enterprise-looking-naming
```

The default is advisory (exit 0); `--strict` exits 1 when a warning is present. This guard uses TypeScript syntax without downloading MobileBERT. False positives are possible for established domain terminology, protocol names and necessary public API identifiers.
