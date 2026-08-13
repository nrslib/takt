Analyze the task as maintenance work for an existing feature and produce a causal-diff implementation plan that includes necessary design decisions.

**Note:** If Previous Response exists, treat it as a rework request and compare it with the current files before revising the plan.

**Small-task criteria:**
- Only 1-2 files change
- No design decision is needed
- No technology choice is needed

For small tasks, omit the design section. In maintenance work, do not omit existing-contract and unnecessary-change checks even for small tasks.

{{include:instructions/contract-family-plan-replan}}
{{include:instructions/change-contract-traceability}}

{{include:instructions/requirement-source-discipline}}

**Do:**
1. **Read reference materials first (required)**
   - Actually open files or directories listed in the task's reference-materials section with Read/Glob
   - If a directory is listed, enumerate it and identify the relevant files before reading
   - If reference materials do not exist or cannot be found, report that and do not substitute guesses
   - **Do not use files not listed in the task as substitutes for reference materials**
2. **Reflect applicable criteria**
   - Reflect constraints and anti-patterns classified as `applicable` by the shared procedure in the implementation approach and coder implementation guidelines
3. Understand the task requirements
   - Compare reference materials with the current implementation to identify the delta
   - **For each requirement, decide whether a change is needed. If no change is needed, cite the current code location (file:line). Do not say "already correct" without evidence**
4. Inspect code to resolve unknowns
5. Identify existing contracts outside the requested change scope that must be preserved
   - Check existing structure, type names, hook return values, UI copy, accessible names, comments, and test expectations
   - For a contract targeted for replacement, document the reason and impact scope, and trace current-consumer migration separately from each support target explicitly required by the requirement source
6. Classify candidate changes as required, related, or unnecessary
   - Same file, nearby responsibility, or common style is not enough to make a change related
   - Do not assign unnecessary changes to the Coder
7. Decide file structure and design patterns when needed
   - Where the request is not causally related, keep the existing structure even if it is not ideal
8. Decide the implementation approach
   - When judgment criteria or supporting material are provided, compare only those classified as `applicable` by the shared procedure
   - For user-facing additions or changes, fix the reachability condition, entry point, and activation path
9. Include the following in the Coder guidance:
   - Existing implementation patterns to follow (file:line). Always cite same-kind existing code when available
   - Impact scope. Especially when adding a new parameter, list every call path that must be wired
   - Relevant anti-patterns for this task, if any
   - Existing contracts outside the requested change scope that must not change
   - Candidate changes explicitly excluded as unnecessary

**Required output (include headings)**
## Work Results
- {Plan summary}
## Change Classification
- {Required, related, and unnecessary changes}
## Existing Contracts
- {Existing contracts outside the requested change scope to preserve; distinguish old contracts targeted for replacement}
## Implementation Plan
- {Causal-diff plan}
