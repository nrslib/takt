Decompose the implementation task into subtasks by file ownership and execute them in parallel. Assign files exclusively to each part to prevent conflicts.

**Important:** Reference the plan report: {report:plan.md}

**Steps:**

1. Identify files to create/modify
   - Reference the plan report and test scope to list all files to change
   - Review the actual codebase to fill in any missing information

2. Group files by layer/module
   - Create groups based on high cohesion (e.g., Domain layer / Infrastructure layer / API layer)
   - If there are type or interface dependencies, keep both sides in the same group
   - Never assign the same file to multiple parts

3. Assign file ownership exclusively to each part
   - Each part's instruction must clearly state:
     - **Responsible files** (list of files to create/modify)
     - **Reference-only files** (read-only, modification prohibited)
     - **Implementation task** (what and how to implement)
     - **Completion criteria** (implementation of responsible files is complete)
   - If tests are already written, instruct parts to implement so existing tests pass
   - Do not include build checks (all parts complete first, then build is verified together)

**Constraints:**
- Parts do not run tests (handled by subsequent movements)
- Do not modify files outside your responsibility (causes conflicts)
