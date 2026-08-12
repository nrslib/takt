**Contract family core**

A contract family is the set of paths that share this identity:

- observable invariant
- authoritative owner or source of truth
- reason to change from the same cause
- consequence visible to a user, external boundary, or terminal state

Describe paths that actually exist as `owner / definition -> producer -> transform / normalize / validate -> persist / transfer / restore -> consumer -> exception / retry / fallback / parallel -> terminal / API / observability`. Do not invent stages that do not apply.

Classify each inspected path as one of:

- `participates`: the path establishes the family invariant
- `preserved`: the path connects to the family but remains unchanged under the current contract
- `outside`: a separate family with a different identity, owner, or reason to change

This core grants no authority to search, report findings, edit, decide, or declare completion. Follow the role instruction that includes this core and the active policy for authority and procedure.
