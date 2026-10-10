# Review Finding Decisions

Decide separately whether a submitted finding is technically correct and whether the current change must repair it. Select only necessary repairs.

## Decision Order

Assess external confirmation last.

1. When external failure results arrive, compare the same input and expected result with current code. If current code demonstrably violates the acceptance criterion, return it to repair targets under the existing problem ID. External failures where the request never reaches the application are not code-caused.
2. Next, if necessary in-environment verification is missing, failed, or for older code, retain that verification or cause investigation as remaining work. Missing verification alone does not establish a code defect.
3. Only when neither applies, necessary in-environment verification has succeeded on current code, and a grounded unmet criterion can only be observed externally, treat it as awaiting external confirmation.

## Decision Criteria

For findings about threats explicitly excluded from protection and the part of a reported failure that occurs in a secondary environment, check the corresponding rows in the table first. If they do not apply, use the normal rows, including violations of the original requirement or acceptance criteria and regressions.

| Situation | Treatment |
|-----------|-----------|
| For a repaired problem, repairs to current code and in-environment verification needed to close its acceptance criteria are complete; the only unmet criteria are confirmations grounded in the requirements or existing project contracts that cannot be observed in this execution environment (another execution environment, an external service, a physical device, human confirmation, etc.) | Awaiting external confirmation (not a repair target) |
| Direct violation of the original requirement or acceptance criteria | Repair |
| Regression introduced by the current diff or repair | Repair |
| Current consumers must migrate for a changed contract to work | Repair |
| An unvisited consumer has the same cause, condition, and acceptance criteria as a problem already selected for repair | Merge into the same problem and repair |
| A real separate problem whose necessity cannot be derived from the current request or repair | Outside this task |
| No requirement makes the current behavior defective and the finding asks only for a stronger mechanism or guarantee | Unnecessary expansion |
| The finding seeks only protection against a threat that pre-change documentation or knowledge explicitly placed outside the scope of protection, with the actor and method identified. The requirement does not call for a change to that contract. The actor, conditions for initiation or consent, scope of inputs, processing that interprets or executes inputs, effective permissions and credentials, and reachable protected assets have not changed, and no existing defense is bypassed or omitted | Unnecessary expansion |
| Part of the reported failure is caused by an environment that project documentation or knowledge treats as secondary (such as an OS, browser, or CPU architecture). Neither the requirement nor the pre-change user-facing support contract requires support or confirmation there, and the current change has not broken a path that previously worked there | Outside this task |
| Current code or evidence contradicts the finding | Unsupported, or no issue after verification |
| A required external environment is unavailable and the implementation claim can be neither confirmed nor disproved | Cannot verify in this environment |

{{include:policies/finding-validity}}

## Principles

- Separate the judgment that a finding was valid (its ID and history) from whether current code still needs changes. Even for a previously accepted repair, once repairs to current code and necessary in-environment verification are complete, preserve the finding decision while removing it from repair targets and carry forward only the remaining confirmation as Awaiting external confirmation. This is not readjudication of a decided finding
- Awaiting external confirmation is allowed only when all of the following hold
  - The remaining criterion is grounded in requirements or existing project contracts. A verification method or the mere existence of a corresponding CI job does not elevate it to an acceptance criterion. Treat ungrounded criteria as Outside this task, neither awaiting external confirmation nor requiring repair
  - Verification required by the request or directly necessary to close this problem's acceptance criteria, which can be executed or consulted in this environment, has succeeded against current code (the commit or code state at that point). Missing, failed, or older-version results remain execution or repair targets instead of awaiting external confirmation. Missing verification alone does not establish a code defect. Remaining checks unrelated to the acceptance criteria (such as optional CI jobs) do not prevent awaiting external confirmation
  - A specific reason explains why the remaining confirmation can only be observed externally
- Return an item to repair targets only when external results confirm that a violation of its acceptance criteria is caused by current code (handle as reopened). Failures caused by external service outages, confirmation equipment or CI infrastructure, rather than code, are not repair targets
- When only external confirmation remains, no problems require repair

- Judge a failure reported in a secondary environment separately for each environment. If the same cause also breaks a primary environment, select its repair as usual. If a new feature fails only in a secondary environment because of that environment, neither the requirement nor the pre-change user-facing support contract calls for support or confirmation there, and the current change has not caused a regression, record it as Outside this task, with the reason. Do not require an error before processing or user documentation
- Even when neither the requirement nor the pre-change user-facing support contract calls for support or confirmation there, select a repair if the current change breaks a path that previously worked in a secondary environment. Repair what can be implemented here based on official specifications and verified with tests runnable here (such as mocks or reproductions of specified inputs). If implementation for that environment cannot be done here, require a clear error before processing starts there and documentation of the limitation for users as acceptance criteria. Record full support in this case as Outside this task, with the reason
- Do not make confirmation in a secondary environment an acceptance criterion without a basis in the requirement or pre-change user-facing support contract; record it as Outside this task, with the reason. If an earlier decision included it, remove it while preserving the original criterion and recording why it was removed. Do not treat it as a repair target or awaiting external confirmation, or restore it to the acceptance criteria in later rounds without a basis
- For support in a secondary environment, follow any support-contract change explicitly required by the request; otherwise, judge the pre-change version. Secondary status, a CI job for that environment, or partial support in existing code does not by itself establish a support contract
- Apply the normal criteria when the requirement or pre-change user-facing support contract calls for support or confirmation in a secondary environment, or when the cause is not environmental, such as rejection of a configured default or dependency

- Base decisions on facts confirmed by current code, requirements, reports, or execution evidence
- Do not select a repair solely because of severity, a REJECT label, a suggested fix, or discovery timing
- When a finding combines a real defect with an excessive repair proposal, judge them separately and retain only the minimum necessary repair
- Group findings when their cause, violated observable condition, and acceptance criteria are the same. Keep problems separate when their conditions differ even if they share a responsible location
- For each problem selected for repair, inspect actual paths affected by the same cause from the defining source through consumers to externally observable results
- Do not add atomicity, transactions, rollback, resource limits, compatibility paths, or similar requirements when they are unnecessary to resolve the verified defect
- Do not dismiss a defect established by the requirements, changed boundary, and applicable design criteria solely because numeric targets or measured outages are absent. Judge correct final results separately from whether intermediate processing satisfies design conditions. If applicability or the impact path is unknown, identify the missing evidence rather than asserting a defect
- Do not dismiss an undecidable concern by assumption; record the information needed as an unresolved premise
- Decide every submitted finding ID once and do not omit the remainder after finding the first repair target

## Selecting Verification Requirements

- Before selecting a test gap for repair, identify which original requirement, behavior changed in this task, or confirmed defect establishes the verification obligation, the concrete failure to detect, and why existing verification is insufficient. Set the minimum necessary verification boundary. Correct current implementation alone does not waive explicitly required verification or regression tests for changed behavior
- Do not derive an obligation to use a reviewer's proposed automated decision mechanism or stronger guarantee from a request to update an artifact or add general regression tests. Judge separately whether descriptive text is a public result and whether a classifier for arbitrary paraphrases, negations, or contradictions is necessary
- When a verification helper defect or additional counterexample is used to keep a finding open, also check whether that gap prevents verification of the original mandatory condition. Do not promote optional verification strengthening into accepted criteria; separate the required verification obligation from an excessive proposed mechanism
