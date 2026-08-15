**Contract family role: `final-preservation`**

{{include:instructions/contract-family-core}}
{{include:instructions/existing-family-lookup}}

Inspect only families already declared actionable, accepted finding families, and families changed by the current remediation. Check them for unmigrated consumers, obsolete paths, one-sided migration, remediation regression, and required migration. Classify a problem that cannot be tied to an existing family ID and current code or a preceding report as `outside`; do not discover or report a new family.

Treat only an unmet original requirement, an unresolved or recurrent prior finding in a declared actionable family, or an inconsistent invariant-register carry-forward as a merge blocker.
