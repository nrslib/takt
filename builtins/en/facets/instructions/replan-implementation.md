Keep the existing requirements and acceptance criteria unchanged. Review the latest plan, implementation, tests, review reports, and Finding Contract state, then redefine the implementation approach.

Meet these requirements:

- Address recurring branches of the same unresolved `family_tag` together
- Keep the original objective, constraints, and acceptance criteria fixed. Do not turn a reviewer-suggested implementation into a new requirement or narrow the task into an easier problem
- Recheck the feature's role in the system and the owners of its entry points, trust boundaries, state, authority, and side effects, then distinguish unnecessary abstraction from missing required production behavior
- Only when user or external input, authorization, sensitive information, external execution, persistence, retries, or concurrency actually participates, include the relevant validation, rejection, and failure handling in the plan
- Do not repeat a failed fix or a substantively identical plan
- Explicitly determine whether the next implementation step can perform work within the project
- If an untried code change, test change, or investigation can still be performed within the project, define that work and its verification steps concretely
- Do not edit code or tests in this step
- If project-scoped changes or investigation cannot resolve the issue and only an external environment change or user action remains, state the evidence and the required external action
- If the attempted approaches and confirmed constraints establish that the requirements are mutually unsatisfiable, state that evidence
- Do not conclude that the issue is unresolvable merely because it is uncertain, uninvestigated, or tests cannot be run
