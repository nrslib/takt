# Contributing to TAKT

🇯🇵 [日本語版](./docs/CONTRIBUTING.ja.md)

Thank you for your interest in contributing to TAKT! This project uses TAKT's review workflow to verify PR quality before merging.

## Development Setup

```bash
git clone https://github.com/your-username/takt.git
cd takt
npm install
npm run build
npm run lint
npm test
npm run test:it
npm run test:e2e:mock
```

If you use Nix flakes, `nix develop` opens a shell with the project Node.js runtime and Bun available:

```bash
nix develop
```

## How to Contribute

1. **Open an issue** to discuss the change before starting work
2. **Keep changes small and focused** — bug fixes, documentation improvements, typo corrections are welcome
3. **Include tests** for new behavior
4. **Run a TAKT review** before submitting — recommended, not required (see below)

Large refactoring or feature additions without prior discussion are difficult to review and may be declined.

## Before Submitting a PR

### 1. Pass CI checks (required)

```bash
npm run build
npm run lint
npm test
npm run test:it
npm run test:e2e:mock
```

### 2. Run a TAKT review (recommended)

A TAKT review pass is **optional but encouraged** — it catches issues early, and pasting the summary helps reviewers. We recommend `review-takt-default`, the read-only review that does not auto-modify your code. It auto-detects the review mode from the input:

```bash
# PR mode — review a pull request by number
takt -t "#<PR-number>" -w review-takt-default

# Branch mode — review a branch diff against main
takt -t "<branch-name>" -w review-takt-default

# Current diff mode — review uncommitted or recent changes
takt -t "review current changes" -w review-takt-default
```

Check the summary in `.takt/runs/*/reports/review-summary.md`. If the result is **REJECT**, address the findings; if a finding is a false positive or an intentional decision, note why it stays. Posting the summary on your PR is welcome but not required.

### 3. Handle CodeRabbit comments

If CodeRabbit reviews your PR, go through each comment, decide whether it should be addressed, and act on the ones that should be. **Resolve every thread** — whether you applied a change or consciously decided not to (in which case leave a short note explaining why). Don't leave comments unaddressed and unresolved.

## Code Style

- TypeScript strict mode
- ESLint for linting
- Prefer simple, readable code over clever solutions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
