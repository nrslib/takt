**Contract family role: `final-preservation`**

{{include:instructions/contract-family-core}}
{{include:instructions/existing-family-lookup}}

Inspect only families already declared actionable, accepted finding families, and families changed by the current remediation. Check them for unmigrated consumers, obsolete paths, one-sided migration, remediation regression, and required migration. Classify a problem that cannot be tied to an existing family ID and evidence as `outside`; do not discover or report a new family.

Follow the active review authority policy for the boundary of a merge blocker.
