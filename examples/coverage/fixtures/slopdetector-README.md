# Slopdetector

**Slopdetector is a fork of [Vibector](https://github.com/anisimov-anthony/vibector), remade entirely in strict TypeScript instead of Go.** It is maintained as an independent repository rather than a GitHub fork.

Like the original, it analyses local Git commit history for commit size, additions and deletions per minute, and unusually short intervals between commits. It produces a text or JSON report of commits exceeding configured thresholds.

The remake is based on upstream `master` revision `e42a31935201cd0ff25ed449341349d5ea11201f`, inspected on 9 November 2026. It uses the local Git executable instead of go-git, and retains the original CLI name, configuration options and report formats. The original is MIT-licensed; the licence and original attribution are retained.

## Requirements

- Node.js 20 or later
- Git available on `PATH`
- TypeScript 5.8 and Node type definitions for building (installed as dev dependencies)

Git and Node execute locally. Vibector does not make network requests or alter the analysed repository.

## Install and build

```sh
npm install
npm run typecheck
npm run build
npm test
```

Run from the repository checkout:

```sh
node dist/src/cli.js config init
node dist/src/cli.js analyze /path/to/repository --output report.txt --suspicious-additions 500 --max-additions-pm 100
node dist/src/cli.js analyze . -o report.json --suspicious-deletions 1000 --max-deletions-pm 500
```

Bun can execute the TypeScript entrypoint directly:

```sh
bun src/cli.ts analyze . --output report.json --suspicious-additions 500
```

## Options

The `analyze` command requires a repository path and `--output` (or `-o`). A configured positive threshold is also required. Each threshold set to zero is disabled. Output formats are `.json`, `.txt`, `.text`, or a filename without an extension (text). Other extensions are rejected.

| Flag | Meaning |
| --- | --- |
| `--config <path>` | Explicit YAML, JSON or TOML configuration file |
| `--suspicious-additions <n>` | Flag more than n filtered added lines |
| `--suspicious-deletions <n>` | Flag more than n filtered deleted lines |
| `--max-additions-pm <n>` | Flag more than n added lines per minute |
| `--max-deletions-pm <n>` | Flag more than n deleted lines per minute |
| `--min-time-delta <seconds>` | Flag an interval shorter than the given value |
| `--branch <name>` | Select a local branch instead of HEAD |
| `--exclude-files <patterns>` | Exclude matching basenames or repository-relative paths; comma-separated and repeatable |

`--config` may appear before or after the command. Explicit command-line thresholds override configuration and environment settings, including a threshold explicitly set to zero.

## Configuration

`config init` writes `.vibector.yaml` into the current directory. It does not overwrite an existing file.

```yaml
thresholds:
  suspicious_additions: 500
  suspicious_deletions: 1000
  max_additions_per_min: 100
  max_deletions_per_min: 500
  min_time_delta_seconds: 60
exclude_files: ["*.log", "*.tmp", "package-lock.json"]
```

Configuration files are loaded only when explicitly specified with `--config`. Environment variables use `VIBECTOR_THRESHOLDS_SUSPICIOUS_ADDITIONS`, `VIBECTOR_THRESHOLDS_SUSPICIOUS_DELETIONS`, `VIBECTOR_THRESHOLDS_MAX_ADDITIONS_PER_MIN`, `VIBECTOR_THRESHOLDS_MAX_DELETIONS_PER_MIN`, `VIBECTOR_THRESHOLDS_MIN_TIME_DELTA_SECONDS` and `VIBECTOR_EXCLUDE_FILES`. Command-line overrides have the highest priority.

## Matching upstream detection behaviour

Commits are read from HEAD or a local branch. The comparison is between adjacent commits in retrieved history, not necessarily a commit and its first parent. Merge commits, non-positive time intervals and diff failures do not produce pairs. The initial commit has no earlier commit to compare. Excluded files still count towards unfiltered totals.

The patch counter skips blank added and deleted lines. Addition velocity drives repository-wide percentiles; deletion velocity is evaluated separately for detection. Percentiles use linear interpolation between sorted samples. A threshold is triggered only when exceeded, not when equalled. Text reports and JSON keys follow the upstream report structure.

The heuristic identifies commits to inspect. It does not determine whether code was authored by a person or an AI model.

## Code Guards

The private [kitty-crow/code-guards](https://github.com/kitty-crow/code-guards) checkout must be placed as a sibling directory. Its CLI is not copied into this project.

```sh
cd ..
git clone https://github.com/kitty-crow/code-guards.git code-guards
cd code-guards
npm install
npm run build
cd ../slopdetector
npm run guards
```

`npm run guards` runs Code Guards with `--strict --path .`. It fails on warnings and also fails if the sibling checkout is absent or Code Guards cannot load. `npm run ci` runs typechecking, tests and that strict guard. Some Code Guards semantic rules require a locally cached model, or network access on first execution. The included GitHub Actions workflow also checks out Code Guards from its private repository. Configure the `CODE_GUARDS_READ_TOKEN` repository secret with read access to `kitty-crow/code-guards` before enabling that workflow; the guard step is not optional.

The compiler and test suite were run during preparation of this source bundle. Running the private Code Guards executable from this environment was not possible, so the guard is configured but has **not** been certified as passing.

## Internal modules

See [the module index](docs/index.md). See [parity notes](docs/parity.md) for scope and validation details.

## Licence

MIT. See [LICENSE](LICENSE).
