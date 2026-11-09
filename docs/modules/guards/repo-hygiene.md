# Repository script and workflow checks

Source: [`src/guards/repo-hygiene.ts`](../../../src/guards/repo-hygiene.ts)

`repoHygiene` inspects package.json for repeated commands inside CI/test scripts, identical test scripts, and a source/dist Bun test-discovery mistake. It also compares test commands across GitHub workflow files if a repository contains them. Warnings are CG501–CG504.

## Behaviour and boundaries

This guard only analyses scripts that exist; it does not create or run GitHub Actions. Some duplicate commands can be intentional for distinct targets, and should be assessed before removal.
