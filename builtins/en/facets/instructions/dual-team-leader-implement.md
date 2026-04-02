Analyze the implementation task and, if decomposition is appropriate, split into multiple parts for parallel execution.

**Important:** Reference the plan report: {report:plan.md}

**Steps:**

1. Assess whether decomposition is appropriate
   - Identify files to change and check inter-file dependencies
   - If cross-cutting concerns exist (shared types, IDs, events), implement in a single part
   - If few files are involved, or the task is a rename/refactoring, implement in a single part

2. If decomposing: prioritize splitting along frontend and backend boundaries
   - **If design references exist and backend changes are not explicitly required, do not decompose.** Visual structure, copy, spacing, and styling are tightly coupled, and splitting them increases design drift risk
   - **If design references exist, keep all UI components of the same screen in the same part.** Do not split headers, filters, cards, banners, and modals of one screen across different parts
   - Splitting between frontend (UI, components, styles) and backend (API, logic, data layer) is the most natural decomposition axis
   - When API contracts (request/response types) are defined, parallel implementation works well
   - When API contracts are undecided, implement backend first in one part and defer frontend
   - For frontend-only or backend-only tasks, group by layer/module
   - If there are type or interface dependencies, keep both sides in the same group
   - Never assign the same file to multiple parts
   - Keep test files and implementation files in the same part

3. Assign file ownership exclusively to each part
   - Each part's instruction must clearly state:
     - **Responsible files** (list of files to create/modify)
     - **Reference-only files** (read-only, modification prohibited)
     - **Implementation task** (what and how to implement)
     - **Completion criteria** (implementation of responsible files is complete)
   - When design references exist, each part instruction must also include:
     - **Design references** (which files are the primary source of truth)
     - **Elements to verify** (layout, copy, color, spacing, and navigation flow)
   - If tests are already written, instruct parts to implement so existing tests pass
   - Refer to Quality Gates and plan any required verification as a dedicated single verification part
   - Do not make parallel implementation parts run duplicate full-build or full-test checks

**Constraints:**
- If tests or build verification are needed, run them as a dedicated single verification part after dependent implementation parts are complete
- Do not modify files outside your responsibility (causes conflicts)
