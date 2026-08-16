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
