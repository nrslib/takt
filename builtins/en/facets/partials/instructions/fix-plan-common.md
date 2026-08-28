{{include:instructions/repair-plan-path-check}}
{{include:instructions/fix-root-cause-analysis}}
{{include:instructions/fix-plan-validity}}

**Tasks:**
1. Enumerate every remediation target and acceptance criterion, mapping each finding to one repair or follow-up verification without omissions
2. Separate independent problems, problems that share a cause, and items that cannot be demonstrated in the current environment. Exclude an item from implementation remediation as environmental only when the task states exclusion criteria and every condition is met
3. For each problem, confirm its cause, violated observable condition, acceptance criteria, the source that defines the condition, and the paths actually affected. Treat paths requiring change for the same cause as one repair and distinguish them from a neighboring contract
4. When the same problem remains after a repair, determine whether the earlier work missed a path, assumed the wrong cause, changed too narrow a location, or used insufficient verification. When code shows that a shared definition or validation point must change, plan to prevent the problem there rather than adding another location-specific patch
5. Define dependency order and completion criteria without separating source changes, consumer migration, and removal of obsolete paths midway through the repair
6. Preflight each repair method against the cause and acceptance criteria, and define targeted tests or reproducible verification that fails while the problem remains. Do not list quality-gate commands in the plan; follow the instructions supplied during implementation
7. Before finalizing a method, confirm the cause it assumes. Separate confirmed facts, possible causes, evidence for the selected cause, and causes that were checked and ruled out. For concurrency, shared-resource, or timing causes, use repeated equivalent conditions, one-variable comparisons, tracing of the failing operation, logs, or measurements. Neither success in isolation nor success after avoiding the problem establishes the cause by itself
8. Change concurrency, timeouts, retries, test selection, or a public contract only when its relationship to the cause and its necessity for the acceptance criteria are confirmed. Do not present a change that merely avoids the problem as the root fix
9. When the cause or a safe repair method cannot be confirmed, do not finalize the plan; state the additional investigation or decision required
