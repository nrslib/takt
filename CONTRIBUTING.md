# Contributing to TAKT

🇯🇵 [日本語版](./docs/CONTRIBUTING.ja.md)

Thank you for your interest in contributing to TAKT! This project uses TAKT's review piece to verify PR quality before merging.

## Development Setup

```bash
git clone https://github.com/your-username/takt.git
cd takt
npm install
npm run build
npm test
npm run lint
```

## How to Contribute

1. **Open an issue** to discuss the change before starting work
2. **Keep changes small and focused** — bug fixes, documentation improvements, typo corrections are welcome
3. **Include tests** for new behavior
4. **Run the review** before submitting (see below)

Large refactoring or feature additions without prior discussion are difficult to review and may be declined.

## Before Submitting a PR

All PRs must pass the TAKT review process. PRs without a review summary or with unresolved REJECT findings will not be merged.

### 1. Pass CI checks

```bash
npm run build
npm run lint
npm test
```

### 2. Run TAKT review

The review piece auto-detects the review mode based on the input:

```bash
# PR mode — review a pull request by number
takt -t "#<PR-number>" -w review

# Branch mode — review a branch diff against main
takt -t "<branch-name>" -w review

# Current diff mode — review uncommitted or recent changes
takt -t "review current changes" -w review
```

### 3. Confirm APPROVE

Check the review summary in `.takt/runs/*/reports/review-summary.md`. If the result is **REJECT**, fix the reported issues and re-run the review until you get **APPROVE**.

If a REJECT finding cannot be resolved (e.g., false positive, intentional design decision), leave a comment on the PR explaining why it remains unresolved.

### 4. Include the review summary in your PR

Post the contents of `review-summary.md` as a comment on your PR. This is **required** — it lets maintainers verify that the review was run and passed.

## Code Style

- TypeScript strict mode
- ESLint for linting
- Prefer simple, readable code over clever solutions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
