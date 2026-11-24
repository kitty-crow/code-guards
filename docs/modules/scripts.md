# Package commands

Source: [`src/scripts.ts`](../../src/scripts.ts)

`readScripts(text, file)` reads the scripts object from a package manifest.
It returns a record of command strings, or an empty record if the object
is absent. Non-string script declarations produce an error carrying the
manifest path. Documentation and repository checks use the same parser.

## Inference preflight

The `preflight` package script runs `bun src/cli.ts all --preflight` on the default tsconfig. Supply a `--project` path for another project. This mode loads tokenizer assets only and never model weights.
