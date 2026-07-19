# CLI startup benchmark

Measured on 2026-07-17 after the CLI lazy-loading change.

## Results

Each command was run once for the first-run value, then 10 more times per variant in alternating baseline/current order. The median uses those 10 subsequent runs.

| Command | Baseline first | Current first | Baseline median | Current median | Improvement |
|---------|---------------:|--------------:|----------------:|---------------:|------------:|
| `--help` | 198.50 ms | 32.37 ms | 195.88 ms | 31.57 ms | 83.9% |
| `--version` | 196.65 ms | 31.54 ms | 194.57 ms | 31.20 ms | 84.0% |
| `telemetry status` | 414.89 ms | 379.25 ms | 425.31 ms | 379.02 ms | 10.9% |

The baseline and current commands produced identical stdout for every measured command.

## Conditions

- Baseline: `main` at `bd60bda9d721cc751a4c908315faf81b153c2d6b`, built from a clean archive.
- Current: the same revision plus the uncommitted CLI lazy-loading change, built with `npm run build`.
- Runtime: Node.js `v25.7.0`, macOS `darwin-arm64`, Apple M5.
- Dependencies: the same `node_modules` and `package-lock.json` (`sha256:9555f6e4dbcb6d1f108f454350c829817650ae3aa216eb80ec93ba6ff78be6e3`).
- Working directory: the current repository worktree root for both variants.
- Configuration: the same isolated `TAKT_CONFIG_DIR`, populated from `builtins/en/config.yaml`.
- Environment: inherited from the same parent process with `NO_COLOR=1`; each measurement spawned a fresh Node.js process synchronously.
