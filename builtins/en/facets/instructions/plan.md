Analyze the task and formulate an implementation plan including design decisions.

**Note:** If a Previous Response exists, this is a replan due to rejection.
Revise the plan taking that feedback into account.

**Criteria for small tasks:**
- Only 1-2 file changes
- No design decisions needed
- No technology selection needed

For small tasks, skip the design section.

**Actions:**
1. **Read reference materials (required; do this first)**
   - Actually open and inspect the files or directories listed in the "Reference Materials" section of the task instructions using Read/Glob
   - If a directory is specified, list its contents, identify the relevant files, and then read them
   - If reference materials do not exist or cannot be found, report that and do not substitute guesses
   - **Do not use files that are not explicitly listed in the instructions as substitutes for reference materials**
2. **Review Knowledge / Policy when provided**
   - If Knowledge / Policy Source Paths are provided, open them with the Read tool and check the `##` sections that affect design decisions for this task
   - Reflect the applied constraints and anti-patterns to avoid in the implementation approach and coder implementation guidelines
3. Understand the task requirements
   - Compare the reference materials with the current implementation and identify the differences
   - **When reference material points to an external implementation, determine whether it is a "bug fix clue" or a "design approach to adopt". If narrowing scope beyond the reference material's intent, include the rationale in the plan report**
   - **For each requirement, determine "change needed / not needed". If "not needed", cite the relevant current code location (file:line) as evidence. Claiming "already correct" without evidence is prohibited**
   - **Limit requirements to explicit requirements and implicit requirements that follow directly from them. Do not turn general best practices or future extensions into requirements**
   - **When decomposing requirements, split only as far as needed to make them independently verifiable. Do not jump from decomposition into new requirements**
   - **When adding an implicit requirement, state which explicit requirement it is derived from in the plan report**
4. Investigate code to resolve unknowns
5. Identify the impact area
6. Determine file structure and design patterns (if needed)
7. Decide on the implementation approach
   - Verify the implementation approach does not violate knowledge/policy constraints
   - When adding or changing a user-facing feature, fix the conditions, entry points, and reachability by which users arrive at it
8. Include the following in coder implementation guidelines:
   - Existing implementation patterns to reference (file:line). Always cite when similar processing already exists
   - Impact area of changes. Especially when adding new parameters, enumerate all call sites that need wiring
   - Anti-patterns to watch for in this specific task (if applicable)
   - When adding or changing a user-facing feature, all affected reachability, callers, and launch conditions
