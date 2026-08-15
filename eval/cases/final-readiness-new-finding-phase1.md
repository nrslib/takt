The cumulative change is not ready to merge. The CLI path normalizes the supported mode before storing it, but `fromProjectConfig()` in `src/mode.js` stores the raw configuration value. This directly violates the acceptance criterion shared by both entries and requires migration of the project-configuration consumer to the existing normalization boundary.

The initial reviewer evidence reported no open finding and did not inspect the project-configuration caller, so this consumer was absent from the initial round. The old README request remains adjudicated non-actionable.
