```markdown
# Implementation Completion Evidence

## Completion Contracts
| Contract ID / Source | Origin | Upstream Completion Obligation | Implementation Result | Implementation Location | Counterexample and Observed Result | Evidence | Status |
|-------------|--------|-------------------------------|-----------------------|-------------------------|------------------------------------|----------|--------|
| {existing ID, or source and relevant location} | Plan / Newly discovered (discovery stage) | {target conditions and expected result} | {implemented behavior or preservation obligation} | `file:line` / unknown / not implemented | {incorrect implementation and actual observation; reason if not run} | {verification sources, path results, assertion, command} | Verified / Incomplete / Environment-limited |

Record the following details in the columns above:

- **Contract ID, source, and upstream obligation:** Preserve the existing ID. When no ID exists, give the source and relevant location. For the same ID or source, retain the applicable states, operation, evaluation time, observation target, and expected result.
- **Implementation result and location:** State the implemented behavior or preservation obligation and its `file:line`. Use "unknown" when implementation status or location is unconfirmed; use "not implemented" only when absence has been confirmed.
- **Counterexample and observed result:** Identify the rejected incorrect implementation and the concrete observed value, effect, record, field, argument, or event. Do not infer rejection from string absence alone. Give the reason when verification was not run.
- **Evidence:** Retain every supplied test name, file location, and other evidence source; mark missing source information "not supplied". Record the valid-path result, the failure-path and boundary-state results or a reasoned N/A for each, the assertion's observation, and the execution command.

## Impact-Path Verification (only for applicable contracts)
| Contract ID / Source | Producers / Equivalent Branches / Auxiliary Entry Points / Consumers Checked | Migrated / Preserved / Obsolete Paths | Applicable Invariants and Continuous Scenario |
|-------------|--------------------------------------------------------------------------------|-----------------------------------------|-----------------------------------------------|
| {same ID or source and relevant location as in Completion Contracts} | {searched and inspected scope} | {change, preservation, and obsolete-path handling} | {separate named evidence for each applicable axis among State, Ownership, Identity, Authorization/Allow-Deny, Failure/Re-entry/Terminal, Retry/Re-execution, and Concurrency/Interleaving; then Scenario and Command; omit non-applicable axes} |

## Quality Gates
| Type | Execution | Result | Effect on This Task’s Completion and Evidence |
|------|-----------|--------|-----------------------------------------------|
| Build / Test / Static Check | `{execution; run this time / reused, original execution reference, identity of target code, configuration, dependencies, and environment}` | Pass / Fail / Not run | {mandatory condition and causal relationship to the change; blocking / non-blocking / undetermined, with evidence} |

## Attempted Verification and Investigation Still Unverified (if applicable)
| Obligation | Attempted Method and Execution Conditions | Result and Evidence | Confirmed Constraint | Prior Proposals, Condition Differences, Reasons Results Cannot Change, and Sources | Next Executable Work and Difference from Prior Attempts |
|------------|-------------------------------------------|---------------------|----------------------|------------------------------------------------------|----------------------------------------------------------|
| {original requirement or accepted contract} | {inputs, environment, and method that affect the result} | {observed result and record location without inferring success} | {blocking condition, who confirmed it, confirmation status, and evidence} | {for each previously assessed ineffective proposal, retain its specific changed condition, why the result cannot change, and source; do not replace supplied proposals with a general statement about unchanged constraints; distinguish direct evidence from reported assessments; "not supplied" if absent} | {necessary executable work, result-affecting difference, and basis for removing or bypassing the constraint; otherwise "none"} |

## Unverified Scope
| Item | Reason | Deterministic Alternative Verification | Remaining Risk and Effect on This Task’s Completion |
|------|--------|----------------------------------------|-----------------------------------------------------|
| {unverified item, or "none"} | {incomplete implementation, failed verification, environmental limitation, etc.; state whether it is executable within the current plan (yes / no) and the concrete basis} | {alternative verification performed, or "none"} | {remaining risk, whether required for this task or out of scope, evidence, and next action; when identifying a plan defect, state why the current plan cannot execute or verify it, which premise, scope, method, or verification capability must change, and what concrete work becomes possible after the change} |

```
