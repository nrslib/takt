Review the cumulative implementation of provider-independent control nodes and resumable nested job execution.

Control nodes delegate to child jobs without introducing a provider dependency. Nested job names are user supplied, and saved executions must resume as the same logical job after restart. Existing executable-task behavior and public compatibility must remain intact.

Treat this as the initial review. Determine the changed contracts from the implementation and requirements, report every confirmed blocking problem, and do not require changes to clean adjacent code.
