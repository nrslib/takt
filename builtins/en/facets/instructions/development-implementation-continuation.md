Compare the current plan with implementation-report.md in Report Directory, if present, and resume the remaining mandatory work. A previous report is evidence to reconcile against current code, not proof merely because it declares completion.

{{include:instructions/preserve-acceptance-conditions}}

- Execute remaining work or checks while the plan remains valid. If a plan change is necessary, identify the invalid premise, scope, or method and the current evidence.
- Mandatory quality gates may reuse successful evidence when the covered code, tests, configuration, dependencies, and execution environment are unchanged and the command, normal termination, and observations are traceable. Follow any explicit requirement to rerun checks on every execution. Run the affected checks when evidence is missing, identity is uncertain, the check failed or was not run, or changes affect its result.
- Record the original execution reference and target identity for reused results, distinguishing them from checks executed this time. Preserve still-valid evidence in the next report. Do not infer success from missing results in a new report directory.
- When incomplete, record the code or evidence added this time, remaining obligations, and the concrete next action. Before repeating an action, identify what will change to distinguish causes. If no executable next action exists, record the evidence and required external action or incompatible conditions.
