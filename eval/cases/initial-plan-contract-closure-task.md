Plan the implementation of provider-independent control nodes and resumable nested job execution.

Control nodes delegate to child jobs without becoming executable worker tasks, and every externally visible representation must preserve that distinction. Nested job names are user supplied and may contain delimiter characters. Every reachable branch and representation of a saved execution must identify the same logical execution without collisions before and after restart. Existing executable-task behavior must remain intact. Backward compatibility is not required.

Inspect the current project and produce an implementation plan. Discover participating paths from definitions, references, callers, and data flow rather than names. Include the affected contracts, path classifications, plausible incorrect implementations that verification must reject, and the evidence needed before implementation can be called complete.
