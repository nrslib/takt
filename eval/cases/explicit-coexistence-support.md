# Explicit resume namespace coexistence

The resume namespace contract is being replaced with `call-path:<path>`.

For the next release, two independent requirements apply:

1. Writers emit new records only with the `call-path:` namespace.
2. Readers restore both `call-path:` records and existing `iteration-<n>--step-<name>` records.

Only the reading requirement has a one-release coexistence scope. It does not authorize legacy writes, rewriting stored records, data migration or backfill, API aliases, event upcasters, or Read Model rebuilds.

Plan or review the resume codec implementation under `src/` against this requirement.
