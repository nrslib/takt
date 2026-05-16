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
- `npm test`: run the main Vitest suite.
- `npm run test:e2e:mock`: run E2E tests against the mock provider.
- `npm run check:release`: run the full release verification path: build, lint, unit tests, and all E2E suites.

## Coding Style & Naming Conventions

This project uses TypeScript ESM on Node `>=18.19.0`. Use 2-space indentation and follow nearby file style. Prefer simple, readable code over clever abstractions. Avoid `any`; prefix intentionally unused parameters with `_`. File names follow existing conventions, mostly focused `kebab-case` or established module names such as `workflowLoader.ts`. Use ESLint and TypeScript compiler feedback before submitting changes.

## Testing Guidelines

Use Vitest for unit, integration, and E2E coverage. Add or update tests for behavior changes. Keep test names explicit, for example `should reject removed legacy workflow alias`. Run `npm test` for normal changes. Run `npm run test:e2e:mock` when touching CLI behavior, workflow execution, provider selection, config loading, or sandbox/runtime flows.

## Commit & Pull Request Guidelines

Recent history uses concise Conventional Commit-style messages such as `fix: ...`, `docs: ...`, and scoped variants like `chore(ci): ...`; PR merge commits may include issue numbers like `(#726)`. Keep commits small and focused. PRs should describe purpose, major changes, test results, and linked issues. Before submitting, run `npm run build`, `npm run lint`, and `npm test`, then include the TAKT review summary when required by `CONTRIBUTING.md`.

## Security & Configuration Tips

Never commit API keys or tokens. Use `~/.takt/config.yaml`, project `.takt/config.yaml`, or environment variables for configuration. Review docs before changing provider, sandbox, credential, or runtime behavior.
