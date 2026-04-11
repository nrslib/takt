# Repository Guidelines

## Project Structure & Module Organization

- `src/`: main TypeScript source. CLI entrypoints live in `src/app/cli/`, core workflow execution in `src/core/`, shared helpers in `src/shared/`, and feature modules in `src/features/`.
- `src/__tests__/`: unit and integration tests, typically named `*.test.ts`.
- `e2e/`: end-to-end specs, fixtures, and helpers.
- `builtins/`: builtin workflows, facets, templates, and config assets shipped with the CLI.
- `docs/`: user and design documentation.
- `bin/`: executable wrappers. `dist/` is generated output and should not be edited by hand.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run build`: compile TypeScript and copy prompts, i18n files, and runtime presets into `dist/`.
- `npm run watch`: incremental TypeScript build during development.
- `npm run lint`: run ESLint on `src/`.
- `npm test`: run the Vitest suite.
- `npm run test:e2e:mock`: run E2E tests against the mock provider.
- `npm run check:release`: full pre-release verification (`build`, `lint`, `test`, `test:e2e:all`).

## Coding Style & Naming Conventions

- Language: TypeScript with ESM, Node 18+.
- Indentation: 2 spaces; follow existing file style.
- Prefer clear, simple code over defensive fallback-heavy logic.
- File names use existing project conventions, mostly `kebab-case` and focused module names such as `workflowLoader.ts`.
- Linting uses ESLint with `@typescript-eslint`; avoid `any`, and prefix intentionally unused parameters with `_`.

## Testing Guidelines

- Framework: Vitest for unit, integration, and E2E coverage.
- Add or update tests with every behavior change.
- Run `npm test` for normal changes; run `npm run test:e2e:mock` when touching execution flow, CLI behavior, workflows, or config loading.
- Keep test names explicit, for example `should reject removed legacy workflow alias`.

## Commit & Pull Request Guidelines

- Prefer small, single-purpose commits.
- Recent history uses concise Conventional Commit style such as `fix:` plus occasional issue references like `(#597)`.
- PRs should describe purpose, major changes, test results, and linked issues.
- Include screenshots or terminal output only when behavior or UX changed.

## Security & Configuration Tips

- Never commit API keys or tokens.
- Use `~/.takt/config.yaml`, project `.takt/config.yaml`, or environment variables for configuration.
- When changing provider or sandbox behavior, review related docs before merging.
