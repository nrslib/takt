# Fix Plan

## Result: finalized

## Root Cause
Override handling is incomplete across the resolution seams, and the reporting surface does not describe the run that actually happens. The interactive session ignores env overrides entirely, the run summary and its renderer report the raw resolved config instead of the effective provider and model, default-origin values surface as a caller-supplied placeholder label, provider-name validation accepts empty names, and the CLI entry does not wire the override sources through to the summary it prints.

## Fix Units
| Fix Unit | Findings | Source of Truth | Required Behavior | Preserved Contracts | Verification |
|----------|----------|-----------------|-------------------|---------------------|--------------|
| FU-1 | VALID-001 | `validateProviderName` in `src/core/validate.js` | An empty or whitespace-only provider name must be rejected with the reason `provider must be a non-empty string`. A non-string provider keeps its current reason | Accepting plain names and the `{ ok, reason }` result shape are unchanged | Regression tests for empty and whitespace-only names |
| FU-2 | SESSION-001 | Override semantics documented in `src/app/override.js` | `initSession(config, cliArgv, env)` must honor env overrides (`env.provider` / `env.model`, already-normalized values) with precedence cli > env > config. Whenever the effective provider differs from `config.provider`, the configured model must be discarded unless the winning override source names a model | `applyCliOverride(config, cliArgv)` keeps its signature and behavior including blank-flag normalization; `initSession` keeps its signature and the `resumable` field | Regression tests: env-only override applies; cli beats env; provider switch via env discards the configured model |
| FU-3 | SUMMARY-001 | `src/core/summary.js` | Change `buildRunSummary(config, entries)` to `buildRunSummary(config, overrides, entries)` where `overrides` is `{ env, cli }` holding already-normalized values (either may be empty). The summary must report the effective provider and model after overrides, using the same precedence and model-discard semantics as FU-2 | The `sources` array shape (`{ key, label }`) is unchanged | Regression tests: summary reports effective provider/model for env-only, cli-only, and combined overrides |
| FU-4 | RENDER-001 | `src/app/render.js` and `formatProviderLine` in `src/core/format.js` | Change `renderSummary(config, entries)` to `renderSummary(config, overrides, entries)`, pass the overrides through to the summary, and format the first line with `formatProviderLine` (`provider: {provider}` or `provider: {provider} (model: {model})`) instead of the legacy joined line | The per-source lines keep the `formatSourceLine` format | Regression tests: rendered output starts with the `formatProviderLine` format for the effective provider/model |
| FU-5 | LABEL-001 | `sourceLabel` usage in `src/core/summary.js` | A config entry whose origin is `default` must be labeled `default` in the run summary, not the placeholder `unknown` | Labels for `env`, `cli`, `local`, `global` origins and the unrecognized-origin error are unchanged | Regression test that a `default`-origin entry yields the label `default` |
| FU-6 | CLI-001 | `src/cli/main.js` | `runCli(config, argv, entries, env)` must pass the parsed flags and env through as the same override set to both the session and the rendered summary, so the printed summary describes the session that was opened | The returned `{ session, summaryText, diagnostics }` shape is unchanged | Regression test: a provider flag in `argv` changes both `session.provider` and the first summary line |

## Dependency Order
1. Implement FU-1 in the validation module.
2. Implement FU-2 in the session seam.
3. Implement FU-3 in the run summary, reusing the same override semantics as FU-2.
4. Implement FU-4 in the renderer on top of FU-3.
5. Implement FU-5 in the summary labeling path.
6. Implement FU-6 in the CLI entry on top of FU-2 and FU-4.
7. Update or add regression tests for each unit, then run the project test suite as the quality gate.
