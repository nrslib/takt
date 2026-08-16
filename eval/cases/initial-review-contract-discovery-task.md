Review the cumulative implementation of provider-independent control nodes and resumable nested job execution.

Control nodes delegate to child jobs without introducing a provider dependency, and every externally visible representation must preserve that distinction. Nested job names are user supplied, and every reachable branch of a saved execution must identify and resume the same logical job after restart. Existing executable-task behavior and public compatibility must remain intact.

Treat this as the initial review. Determine the changed contracts and their consumer boundaries from actual references, calls, and data flow. Report every confirmed blocking problem, classify examined clean or adjacent paths, and do not require changes to a neighboring contract.
