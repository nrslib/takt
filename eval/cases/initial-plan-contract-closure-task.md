Plan the implementation of provider-independent control nodes and resumable nested job execution.

Control nodes delegate to child jobs without becoming executable worker tasks. Every user-facing projection, including terminal and API output, must preserve that distinction. Nested job names are user supplied and may contain delimiter characters. Retry, fallback, parallel execution, storage, checkpoints, audit records, events, terminal output, and API output must identify the same logical execution without collisions after restart. Existing executable-task behavior must remain intact. Backward compatibility is not required.

Inspect the current project and produce an implementation plan. Include the affected contracts, all participating paths, plausible incorrect implementations that the verification must reject, and the evidence needed before implementation can be called complete.
