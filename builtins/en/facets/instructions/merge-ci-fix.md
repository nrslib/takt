Fix only the root cause established in the current investigation, in this PR clone.
Investigation: {structured:investigate_ci.summary}
Investigation report: {report:ci-investigation.md}
Failure evidence:
{context:collect_ci_failure.failure}

Read the cumulative diff and related code before editing. Fix product or test defects, including flaky tests and defects also failing on main. Preserve unrelated contracts and gates. Add or update meaningful regression tests and run the relevant whole test files and build/type checks. Record changes, causal justification, commands, results and any remaining uncertainty in ci-fix.md. If the cause cannot be safely fixed or verified, report that outcome. Do not commit, push or rerun CI.
