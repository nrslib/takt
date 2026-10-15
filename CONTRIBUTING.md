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
npm run test:e2e:smoke
```

`npm install` applies the repository's Ink patch automatically. If you need to reapply it after changing dependencies, run `npm run patch:dependencies`.

If you use Nix flakes, `nix develop` opens a shell with the project Node.js runtime and Bun available:

```bash
nix develop
```

Before a release, run `npm run check:release` and commit any updates to `package-lock.json` and `flake.nix`. The first step, `sync:nix-deps`, updates the lock with npm 10.9.4, installs it with `npm ci`, and recomputes `npmDepsHash` (requires Nix). This keeps the Nix build and release checks on the same dependencies.

## How to Contribute

PRs that accompany an issue are especially welcome. For bug fixes and small improvements, feel free to submit a PR without waiting for a maintainer response or for discussion to conclude.

1. **Open an issue** describing the problem or proposed change, and reference it in your PR — use an existing issue if one already covers the change
2. **Keep changes small and focused** — bug fixes, documentation improvements, typo corrections are welcome
3. **Include tests** for new behavior
4. **Run a TAKT review** before submitting — recommended, not required (see below)

For large refactoring or features that affect the project's design or compatibility, we recommend discussing the approach in an issue before implementation to avoid rework.

## Before Submitting a PR

### 1. Pass CI checks (required)

```bash
npm run build
npm run lint
npm test
npm run test:it
npm run test:opencode-probe
npm run test:e2e:smoke
```

`npm test` runs the fast unit tests. After implementation, run `npm run test:it` for light integration coverage. If you add or change an integration test, run `npm test -- src/__tests__/releaseVerificationWiring.test.ts` separately. For a changed heavy integration test, also run its file with `npm test -- <test-file>` before submitting the PR. `npm run test:opencode-probe` checks the OpenCode prompts. For a release, `npm run check:release` runs dependency sync, build, a packed global install check with npm 10 and 11, a `takt install` check of every managed provider against the real npm registry, lint, unit, integration, and E2E checks.

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

Comment commands consume paid AI API credits, so access is limited. `/review` responds to comments from the repository owner, organization members, and collaborators; `/resolve`, `/ci`, and `@takt` respond to the owner. Regular CI runs on every PR. If an extra run would help, ask in a comment.

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
