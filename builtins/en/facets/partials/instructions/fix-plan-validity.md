{{include:policies/finding-validity}}

{{include:policies/applicable-inputs}}

{{include:policies/evidence-based-judgment}}

**Cleanup of files outside the project without an approver:**
- In the fix plan, exclude this cleanup from product repair completion criteria and approval-waiting work, and report the affected files and remaining state
- Even if an existing fix plan includes this cleanup, when all product repairs and required verification are complete, do not select plan revision or inability to proceed solely because cleanup remains. Treat the repair as complete and proceed to independent verification; apply the same distinction there
- Do not treat incomplete product repairs, required verification, or its evidence as complete under this exception. Do not falsely report that external cleanup was performed, or add a new approval procedure or wait for human confirmation

**Fix plan validity:**
- Preserve each finding's ID and source-backed problem, acceptance criteria, and remediation boundary, and recheck its evidence against current code. Treat reviewer-proposed methods as candidates that do not override requirements, specifications, schemas, or public contracts
- Plan findings with the same cause, violated observable condition, and acceptance criteria as one repair rather than splitting them by reported location. Do not merge findings merely because names, types, or files are close, and keep problems separate when their cause or acceptance criteria differ
- Use code and data flow to inspect every existing path needed for the acceptance criteria, from definitions through production, transformation, validation, persistence, restoration, consumers, and externally observable results. Do not stop at a representative location or expand into an unrelated neighboring contract
- When an enum, state transition, input format, candidate order, result limit, or other bounded state affects the problem, make concrete only the values and boundaries within the scope specified in “Scope of inputs used for counterexamples” above. Do not add unsupported values or combinations as coverage requirements
- For each path, state whether it must be edited, migrated or removed, or only verified. When a shared change is sufficient, verify already-correct consumers instead of editing them for symmetry
- When language, runtime, standard-library, or dependency behavior supports the cause or verification, confirm the actual input and result from target code, a type or API specification, or provided recorded results
- Do not expose private definitions, change a public schema or field name, or add a production enumeration API solely to simplify tests or improve naming
- Reconcile repair methods, verification methods, and completion criteria with the requirements, current code, and public contracts. Apply relevant judgment criteria or reference material supplied by the task, and make completion externally observable
- Verification must traverse the affected contract path and observe a point that fails while the problem remains. Verify static conditions by comparing the current code, types, and schemas
- Revise a plan when changing it can resolve a missing or contradictory cause, remediation boundary, affected path, method, acceptance criterion, or verification method. Distinguish such plan defects from implementation or evidence that is merely incomplete against an otherwise valid plan
