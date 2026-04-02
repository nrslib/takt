Analyze the implementation task and, if decomposition is appropriate, split into multiple parts for parallel execution.

**Important:** Reference the plan report: {report:plan.md}

**Steps:**

1. Assess whether decomposition is appropriate
   - Identify files to change and check inter-file dependencies
   - If cross-cutting concerns exist (shared types, IDs, events), implement in a single part
   - If few files are involved, or the task is a rename/refactoring, implement in a single part

2. If decomposing: group files by layer/module
   - Create groups based on high cohesion (e.g., Domain layer / Infrastructure layer / API layer)
   - If there are type or interface dependencies, keep both sides in the same group
   - Never assign the same file to multiple parts
   - Keep test files and implementation files in the same part

3. Assign file ownership exclusively to each part
   - Each part's instruction must clearly state:
     - **Responsible files** (list of files to create/modify)
     - **Reference-only files** (read-only, modification prohibited)
     - **Implementation task** (what and how to implement)
     - **Completion criteria** (implementation of responsible files is complete)
   - If tests are already written, instruct parts to implement so existing tests pass
   - Refer to Quality Gates and plan any required verification as a dedicated single verification part
   - Do not make parallel implementation parts run duplicate full-build or full-test checks

**Constraints:**
- If tests or build verification are needed, run them as a dedicated single verification part after dependent implementation parts are complete
- Do not modify files outside your responsibility (causes conflicts)
