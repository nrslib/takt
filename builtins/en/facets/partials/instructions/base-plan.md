Analyze the task and formulate an implementation plan including design decisions.

**Note:** If a Previous Response exists, this is a replan due to rejection.
Revise the plan taking that feedback into account.

**Criteria for small tasks:**
- Only 1-2 file changes
- No design decisions needed
- No technology selection needed

For small tasks, skip the design section.

{{include:instructions/planning-path-check}}
{{include:instructions/change-contract-traceability}}

{{include:instructions/requirement-source-discipline}}

**Actions:**
1. **Read reference materials (required; do this first)**
   - Actually open and inspect the files or directories listed in the "Reference Materials" section of the task instructions using Read/Glob
   - If a directory is specified, list its contents, identify the relevant files, and then read them
   - If reference materials do not exist or cannot be found, report that and do not substitute guesses
   - **Do not use files that are not explicitly listed in the instructions as substitutes for reference materials**
2. **Reflect applicable criteria**
   - Reflect constraints and anti-patterns classified as `applicable` by the shared procedure in the implementation approach and coder implementation guidelines
3. Understand the task requirements
   - **Keep the stated objective, constraints, and acceptance criteria fixed instead of reinterpreting them as an easier implementation problem. Distinguish whether an example method is required by the request or is only a candidate means of satisfying it**
   - Compare the reference materials with the current implementation and identify the differences
   - **When reference material points to an external implementation, determine whether it is a "bug fix clue" or a "design approach to adopt". If narrowing scope beyond the reference material's intent, include the rationale in the plan report**
   - **For each requirement, determine "change needed / not needed". If "not needed", cite the relevant current code location (file:line) as evidence. Claiming "already correct" without evidence is prohibited**
4. Investigate code to resolve unknowns
   - Write file references relative to the working directory. Do not include absolute home-directory or worktree paths in responses or reports
5. Identify the impact area
   - Identify implementation and verification locations for every contract ID. Only for contracts with impact paths, enumerate the relevant path from production to the final consumer
   - Identify the feature's role in the system and the owners of its entry points, trust boundaries, state, authority, and side effects
   - Only when user or external input, authorization, sensitive information, external execution, persistence, retries, or concurrency is actually involved, include the relevant validation, rejection, and failure handling. Do not add unrelated concerns mechanically
6. Determine file structure and design patterns (if needed)
7. Decide on the implementation approach
   - When judgment criteria or supporting material are provided, compare only those classified as `applicable` by the shared procedure
   - Do not confuse keeping the diff small with omitting required production behavior. Put validation, authorization, state updates, error handling, and cleanup into the participating execution paths when they are required for the acceptance criteria
   - When adding or changing a user-facing feature, fix the conditions, entry points, and reachability by which users arrive at it
8. Include the following in coder implementation guidelines:
   - Existing implementation patterns to reference (file:line). Always cite when similar processing already exists
   - Impact area of changes. Especially when adding new parameters, enumerate all call sites that need wiring
   - Anti-patterns to watch for in this specific task (if applicable)
   - When adding or changing a user-facing feature, all affected reachability, callers, and launch conditions
