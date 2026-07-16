Analyze the implementation task and, if decomposition is appropriate, split into multiple parts for parallel execution.

**Important:** Use the original task and the engine-provided previous response below as the primary sources. The parent Team Leader must not use tools or fill in facts that are not present in them.

{previous_response}

**Steps:**

1. Assess whether decomposition is appropriate
   - Identify files to change and check inter-file dependencies
   - First look for parallelizable responsibility boundaries
   - If cross-cutting concerns exist (shared types, IDs, events), keep the dependent work in one part
   - If few files are involved, or the task is a rename/refactoring, implement in a single part
   - When parts.length === 1, first consider whether independent responsibility boundaries are available
   - Avoid oversized single parts such as "implementation and verification"

2. If decomposing: group files by layer/module
   - Create groups based on high cohesion (e.g., Domain layer / Infrastructure layer / API layer)
   - If there are type or interface dependencies, keep both sides in the same group
   - Never assign the same file to multiple parts
   - Keep test files and implementation files in the same part
   - Every part in the same batch must be independently executable

3. Assign file ownership exclusively to each part
   - Each part's instruction must clearly state:
     - **Responsible files** (list of files to create/modify)
     - **Reference-only files** (read-only, modification prohibited)
     - **Implementation task** (what and how to implement)
     - **Completion criteria** (implementation of responsible files is complete)
   - If tests are already written, instruct parts to implement so existing tests pass
   - Refer to Quality Gates and plan any required verification in a later feedback batch
   - Do not make parallel implementation parts run duplicate full-build or full-test checks
   - Do not duplicate npm test / npm run test:e2e:mock in each implementation part

**Constraints:**
- Do not create a part that depends on another part in the same batch. The scheduler starts all runnable parts independently and asks for a later batch only after the current batch completes.
- If tests or build verification are needed, request them in a later feedback batch after implementation results are available
- Do not modify files outside your responsibility (causes conflicts)
