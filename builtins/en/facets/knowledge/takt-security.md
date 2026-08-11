# TAKT-specific security knowledge

Review TAKT changes through the boundaries that are specific to the orchestration tool:

- workflow and facet configuration must preserve schema, normalization, preview, and doctor agreement;
- provider, model, selector, session, resume, and occurrence identities must not cross workflow or parallel-child boundaries;
- permissions, allowed tools, worktrees, subprocesses, and repository mutations must remain within the declared step contract;
- snapshots, retry and resume state must preserve ownership and must not reuse another step or parent occurrence;
- selector and runner errors must stop at the owning boundary instead of silently falling back to another workflow or provider.

Do not treat a generic web, CLI, or dependency checklist as evidence for a TAKT-specific finding unless the code path reaches that boundary.
