## Applying Domain-Specific Security Knowledge

- Always apply `security` as the common trust-boundary Knowledge
- Evaluate only the assigned `security-web`, `security-api`, `security-local`, `security-data`, and `security-dependencies` facets, and compare each assigned facet's `## Applicability` section with real code, configuration, and execution paths
- Do not infer applicability from a technology name, file extension, or installed dependency alone
- Do not apply a domain Knowledge facet that is not assigned to the step, or use its checklist as finding evidence or required coverage
- Apply every assigned Knowledge facet whose system surface participates in the change
- When a team leader divides an audit, state the assigned domain Knowledge facets and rationale in each part instruction
