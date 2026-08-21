# Repository Guidelines

## Project Structure & Module Organization

- `src/`: main TypeScript source. CLI entrypoints live in `src/app/cli/`, core workflow execution in `src/core/`, shared helpers in `src/shared/`, and feature modules in `src/features/`.
- `src/__tests__/`: Vitest unit and integration tests, typically named `*.test.ts`.
- `e2e/`: end-to-end specs, helpers, fixtures, mock workflows, and provider scenarios.
- `builtins/`: builtin workflows, facets, templates, prompts, and runtime config assets shipped with the CLI.
- `docs/`: user and design documentation. `bin/` contains executable wrappers. `dist/` is generated output and should not be edited by hand.

## Build, Test, and Development Commands

- `npm install`: install project dependencies.
- `npm run build`: compile TypeScript and copy runtime prompts, i18n files, and presets into `dist/`.
- `npm run watch`: run the TypeScript compiler in incremental watch mode.
- `npm run lint`: run ESLint on `src/`.
- `npm test`: run the fast unit gate in four concurrent shards during development. Integration tests are excluded; targeted source tests are routed to their classified runner.
- `npm run test:it`: run the light integration gate after implementation. It covers real filesystem, bounded storage, and multi-component contracts.
- `npm run test:it:heavy`: run all child-process, Git, full-engine, and measured resource-heavy integration tests locally with one worker. Pull-request CI splits it across isolated runners; do not run it routinely during development.
- `npm test -- <test-file>`: run a classified test through its unit, light-IT, or heavy-IT runner. When adding or changing an IT, also run `npm test -- src/__tests__/releaseVerificationWiring.test.ts` by itself. Always run an added or changed heavy IT before handoff; the PR-wide heavy gate is not its first execution.
- `npm run test:e2e:mock`: run E2E tests against the mock provider.
- `npm run check:release`: run the full release verification path: build, lint, fast unit (four shards), light IT, heavy IT, and all E2E suites.

## Coding Style & Naming Conventions

This project uses TypeScript ESM on Node `>=22.22.0`. Use 2-space indentation and follow nearby file style. Prefer simple, readable code over clever abstractions. Avoid `any`; prefix intentionally unused parameters with `_`. File names follow existing conventions, mostly focused `kebab-case` or established module names such as `workflowLoader.ts`. Use ESLint and TypeScript compiler feedback before submitting changes.

## Testing Guidelines

Use Vitest for unit, integration, and E2E coverage. Add or update tests for behavior changes. Keep test names explicit, for example `should reject removed legacy workflow alias`. Run `npm test` during development and `npm run test:it` when implementation is complete. Run the classification contract by itself after adding or changing an IT, and run every added or changed heavy IT as a targeted test. Run `npm run test:e2e:mock` when touching CLI behavior, workflow execution, provider selection, config loading, or sandbox/runtime flows.

## Commit & Pull Request Guidelines

Recent history uses concise Conventional Commit-style messages such as `fix: ...`, `docs: ...`, and scoped variants like `chore(ci): ...`; PR merge commits may include issue numbers like `(#726)`. Keep commits small and focused. PRs should describe purpose, major changes, test results, and linked issues. Before submitting, run `npm run build`, `npm run lint`, and `npm test`, then include the TAKT review summary when required by `CONTRIBUTING.md`.

## Security & Configuration Tips

Never commit API keys or tokens. Use `~/.takt/config.yaml`, project `.takt/config.yaml`, or environment variables for configuration. Review docs before changing provider, sandbox, credential, or runtime behavior.

## Fact Verification and Uncertainty

- Investigate the relevant source, runtime artifact, log, or authoritative documentation before making factual claims that affect decisions.
- Do not present inference as fact. Except for stable, self-evident facts, verify the claim directly before stating it.
- When direct verification is unavailable, clearly distinguish confirmed facts from assumptions and state that the result is unknown.
- Prefer the artifact that records the behavior actually executed over indirect signals such as names, hashes, counters, or expected configuration.
