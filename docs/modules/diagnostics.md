# Terminal and machine-readable reporting

Source: [`src/diagnostics.ts`](../../src/diagnostics.ts)

`renderFindings` takes findings plus a `ReportOptions` object containing a repository root, `Format` (`text`, `json` or `github`) and `ColourMode` (`auto`, `always` or `never`). `Finding` locations are rendered with source excerpts, a clause pointer and remediation text.

## Behaviour and boundaries

`NO_COLOR` disables colour. JSON output is uncoloured and retains structured fields; missing source files do not prevent a warning from being printed.

Errors use a red terminal label and GitHub error annotations. The summary includes an error count when nonzero.
