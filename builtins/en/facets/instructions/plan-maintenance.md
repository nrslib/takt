Analyze the task as maintenance work for an existing feature and produce a causal-diff implementation plan that includes necessary design decisions.

**Note:** If Previous Response exists, treat it as a rework request and compare it with the current files before revising the plan.

**Small-task criteria:**
- Only 1-2 files change
- No design decision is needed
- No technology choice is needed

For small tasks, omit the design section. In maintenance work, do not omit existing-contract and unnecessary-change checks even for small tasks.

**Do:**
1. **Read reference materials first (required)**
   - Actually open files or directories listed in the task's reference-materials section with Read/Glob
   - If a directory is listed, enumerate it and identify the relevant files before reading
   - If reference materials do not exist or cannot be found, report that and do not substitute guesses
   - **Do not use files not listed in the task as substitutes for reference materials**
2. **Review Knowledge / Policy when provided**
   - If Knowledge / Policy Source Paths are provided, open them with the Read tool and check the `##` sections that affect design decisions for this task
   - Reflect the applied constraints and anti-patterns to avoid in the implementation approach and coder implementation guidelines
3. Understand the task requirements
   - Compare reference materials with the current implementation to identify the delta
   - **For each requirement, decide whether a change is needed. If no change is needed, cite the current code location (file:line). Do not say "already correct" without evidence**
   - **Limit requirements to explicit requirements and directly implied requirements. Do not turn general best practices or future extensibility into requirements**
   - **Break requirements down only to make them verifiable. Do not let decomposition create new requirements**
   - **When using an implied requirement, identify the explicit requirement that supports it in the plan report**
4. Inspect code to resolve unknowns
5. Identify existing contracts that must be preserved
   - Check existing structure, type names, hook return values, UI copy, accessible names, comments, and test expectations
   - If an existing contract must change, document the reason and impact scope in the plan
6. Classify candidate changes as required, related, or unnecessary
   - Same file, nearby responsibility, or common style is not enough to make a change related
   - Do not assign unnecessary changes to the Coder
7. Decide file structure and design patterns when needed
   - Where the request is not causally related, keep the existing structure even if it is not ideal
8. Decide the implementation approach
   - Check that the approach does not violate Knowledge or Policy constraints
   - For user-facing additions or changes, fix the reachability condition, entry point, and activation path
9. Include the following in the Coder guidance:
   - Existing implementation patterns to follow (file:line). Always cite same-kind existing code when available
   - Impact scope. Especially when adding a new parameter, list every call path that must be wired
   - Relevant anti-patterns for this task, if any
   - Existing contracts that must not change
   - Candidate changes explicitly excluded as unnecessary

**Required output (include headings)**
## Work Results
- {Plan summary}
## Change Classification
- {Required, related, and unnecessary changes}
## Existing Contracts
- {Existing contracts to preserve}
## Implementation Plan
- {Causal-diff plan}
