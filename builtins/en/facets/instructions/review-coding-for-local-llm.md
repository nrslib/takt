Review actual bugs, entry-specific tests, and resource-contract tests.

- Check the task intent, diff, execution evidence, and supplied Policy; report only evidence-backed issues that require correction.
- Check public entries or execution modes, their success/failure cases, and corresponding tests. Choose state-transition and side-effect equivalence classes, not a Cartesian product.
- For APIs that return resources or cleanup, check success, failure, interruption, cleanup, and residual artifacts.
- Trace shared changes through equivalent branches. Include location, impact, and fix direction; do not report speculation, preference, or unrelated existing issues.
- From the second review round onward, re-scan all chapters and the cumulative diff from the base, and record the results according to the active output contract.
