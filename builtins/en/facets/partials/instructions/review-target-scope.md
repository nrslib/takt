Use the presented change targets as the specialist review's inspection scope to prevent missed changes and regressions caused by repairs.

- Treat the following changed-target scope as authoritative and inspect every file listed there, even when your own `git diff` is empty:
{review_scope}
- Add targets through your own investigation only when the scope section explicitly says the range is limited, incomplete, or unavailable.
- Immediately before approving a follow-up review, regression-check the presented changed targets and confirm that the repairs did not break changed contracts. Record the checked scope and evidence in the corresponding report fields.
- When PR Context is present, use the cumulative base-to-head diff as primary evidence and treat `review-target.md` and earlier reports as snapshots. Base resolution on the original requirement, acceptance criteria, and current diff, and evaluate schema changes introduced in the PR by their final form.
