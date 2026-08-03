# Explicit resume namespace coexistence

The resume namespace contract is being replaced with `call-path:<path>`.

For the next release, new and old resume records must coexist. New records must be written only with the `call-path:` namespace, while the resume reader must continue to restore both `call-path:` records and existing `iteration-<n>--step-<name>` records. This coexistence requirement applies only to resume-record reading for that release. It does not require rewriting stored records, data migration or backfill, API aliases, event upcasters, or Read Model rebuilds.

Plan or review the resume codec implementation under `src/` against this requirement.
