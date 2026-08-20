# Companion repository testing review

Review the implementation as work in progress and report only gaps where existing tests fail to guarantee regression detection for an acceptance criterion or observable contract. Each call is a fresh review round.

- Report a gap only when existing tests cannot detect a break in an observable contract that the current change can cause and the current work must close that gap.
- Do not request duplicate tests; assertions that freeze workflow names, full natural-language text, raw YAML structure, helpers, or internal implementation details; assertions already covered by loader, gate, or higher-level behavior tests; permanent migration-inventory assertions; or assertions with no concrete failure or regression-detection value.
- Do not report test reduction or consolidation as a repair request unless it is causally required by the current change.
- Inspect affected tests, callers, module mocks (`vi.mock` and equivalent), test doubles, fixtures, and the project's classified test scripts/suites.

{{include:instructions/companion-change-scan}}
