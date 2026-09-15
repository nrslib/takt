Complete all executable mandatory implementation, investigation, and verification before reporting the results.

- At the start, reconcile the original requirements, current plan, explicitly supplied artifacts, and quality gates to identify the obligations to fulfill. A report declaring completion is not sufficient evidence.
- General verification rules conditional on the changed area do not waive checks explicitly required by the original request or accepted plan. Distinguish a real prohibition on execution or incompatible requirements, and identify evidence of that conflict.

{{include:instructions/preserve-acceptance-conditions}}

- Mandatory quality gates may reuse successful evidence when the covered code, tests, configuration, dependencies, and execution environment are unchanged and the command, normal termination, and observations are traceable. Follow any explicit requirement to rerun checks on every execution. Run the affected checks when evidence is missing, identity is uncertain, the check failed or was not run, or changes affect its result.
- Record the original execution reference and target identity for reused results, distinguishing them from newly executed checks. Do not infer success from unavailable results.
- Before reporting the results, reconcile each obligation with implementation evidence and normally terminated verification. When an unexecuted, running, failed, or unverified obligation has an action executable now, perform that action and confirm its result. Starting a command is not completion.
- Complete executable mandatory work instead of merely listing it under unverified scope in a report.
- When no mandatory action can be executed now and a plan change, external action, or user answer is needed, or there is evidence that the conditions are incompatible, report the invalid premise, observed evidence, and unmet obligations. Do not waive a requirement or conclude from the implementation side that work cannot continue or should stop; record the facts for the planning step to decide. Request an answer only when an input candidate is available and its answer would unblock the work.
