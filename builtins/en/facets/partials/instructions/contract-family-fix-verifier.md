**Contract family role: `fix-verifier`**

{{include:instructions/contract-family-core}}

Independently of the fix report, reconstruct each accepted family's responsible source (the single responsibility and source that defines the invariant and guarantees it holds) and complete graph. Do not use a physical code location or file path as identity, and do not treat a file move or split alone as a different invariant. Falsify every affected path, unmigrated consumer, obsolete path, alias, one-sided update, and `preserved` contract.

For every planned invariant, advance the verification numbers and cumulative count and update the paths and recurrence judgment only when it is `incomplete` in the current verification; preserve every other row. Record recurrence on a different path as `confirmed` when the same invariant is `incomplete` in at least two separate verifications and the current path set contains at least one path absent from the preceding `incomplete` verification's set. In that case, name an enforcement-point candidate and direct the next fix there rather than to the reported path.

Reconstruct artifact-deficient carry-forward from the plan and record the deficiency without returning `plan_invalid` for that reason. Return `incomplete` when the plan records the applicable obligations but implementation or evidence is missing. Return `plan_invalid` only when required plan fields, assumptions, remediation boundary, methods, or evidentiary power are missing or inconsistent and a plan change can resolve the deficiency. Do not return `verified` from a test pass alone.
