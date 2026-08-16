When reporting a finding, follow these rules.

- Report each problem separately; do not combine different causes or contracts into one finding.
- Include the fields required by the output contract or policy for the finding's state. For `new`, include severity, evidence, the violated requirement, contract, or invariant, the concrete impact and failure condition, and a proposed fix, and identify the location as `file:line` in principle. For `persists`, keep the same `finding_id` and include previous evidence, current evidence, the issue, and a proposed fix. For `resolved`, keep the same `finding_id` and include resolution evidence. Do not impose fields that are specific to `new` on other states.
- When a policy permits a locationless issue because required implementation or wiring is missing after all paths have been searched, follow that policy and do not supply an invented or inferred location.
- When the output contract or policy defines `finding_id`, give every finding an ID in that format.
- When reporting an existing finding again, reuse the same `finding_id`; do not assign a different ID.
- When the output contract or policy defines `new` / `persists` / `resolved`, assign the applicable state to each finding.
- Keep the original ID for `persists`, and cite concrete verification evidence for `resolved`.
- For raw findings whose output contract or policy prohibits assigning final IDs or lifecycle states, follow that prohibition.
- Do not invent a finding when the evidence does not establish a problem.

When performing a review, also follow these scope rules. These scope rules apply only to review work; implementation, planning, and repair steps should keep their own task boundary.

- Treat the following changed-target scope as authoritative and inspect every file listed there, even when your own `git diff` is empty:
{review_scope}
- Add targets through your own investigation only when the scope section explicitly says the range is limited, incomplete, or unavailable.
- When `{var:review_mode}` is `initial`, inspect every presented target and complete the applicable criteria and same problem family in the same round. When it is `follow_up`, inspect unresolved concerns, their repairs, and directly affected paths without restarting general discovery in untouched areas. Only for `unspecified`, treat a directly executed reviewer step at `{step_iteration}` 1 as `initial` and later iterations as `follow_up`.
- Immediately before approving a follow-up review, regression-check the presented changed targets and confirm that the repairs did not break changed contracts. Record the checked scope and evidence in the fields defined by the output contract.
- When PR Context is present, use the cumulative base-to-head diff as primary evidence and treat `review-target.md` and earlier reports as snapshots. Base resolution on the original requirement, acceptance criteria, and current diff, and evaluate schema changes introduced in the PR by their final form.
