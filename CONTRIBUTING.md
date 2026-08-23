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
npm run test:opencode-probe
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
npm run test:opencode-probe
npm run test:e2e:mock
```

`npm test` is the fast unit gate for the development loop. Local unit runs use an adaptive shard count based on `availableParallelism()` (capped at 8), while the main pull-request CI workflow keeps 8 isolated unit runners. CI prioritizes wall-clock time over runner minutes, so each runner repeats the fixed `npm ci` and `npm run build` cost. Run `npm run test:it` after implementation for light integration coverage of real filesystem, bounded storage, and multi-component contracts. Heavy integration uses one worker locally; pull-request CI shards it across isolated runners for real child processes, Git, complete engines, integration/regression/performance suites, and measured resource-heavy serial groups. If you add or change an IT, run `npm test -- src/__tests__/releaseVerificationWiring.test.ts` by itself. If it is a heavy IT, also run that file yourself with `npm test -- <test-file>` before submitting; PR-wide execution must not be its first run. The deterministic OpenCode prompt smoke suite runs through `npm run test:opencode-probe`. Release maintainers can run `npm run check:release` for the complete local path: adaptive local fast unit, light IT, heavy IT, and all provider E2E suites. The 8-runner unit matrix belongs to the separate main pull-request CI workflow; local `check:release` does not run that matrix.

See the [E2E testing overview](./docs/testing/e2e.md) for how to run the E2E suites and their prerequisites.

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

## PR Comment Commands (permission-gated)

Comment commands consume paid AI API credits, so they are permission-gated: `/review` responds to the repository owner, org members, and collaborators; `/resolve`, `/ci`, and `@takt` respond to the owner only. On PRs from external contributors these commands do not respond (the workflow simply does not start) — that's expected, not a bug. Regular CI runs automatically on every PR; if you think an extra run would help, just ask in a comment.

## Code Style

- TypeScript strict mode
- ESLint for linting
- Prefer simple, readable code over clever solutions

## Canary runs for instruction / facet changes

Changes that affect prompt assembly — `InstructionBuilder`, `builtins/{lang}/facets/instructions`, and the like — can destabilize tool calling on weaker models in ways unit tests do not catch (real example: injecting objection-filing guidance while the ledger was still empty caused consecutive `implement` failures). For such changes, a canary run against a real provider is recommended.

```bash
npm run build
npm run canary:coder -- --provider opencode --model ollama-cloud/qwen3-coder-next
```

This runs one small `implement` pass with the current instruction assembly and checks that it completes, along with the tool error count. It is not a required PR gate (real-provider runs cost money).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
