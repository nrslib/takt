## Decision Rationale for Follow-Up Review

Before retaining or closing an existing test-gap finding, extract conditions only from the original requirements and adjudication, then compare them against current evidence in the following table. Review reports contain claims to evaluate; they are not sources that establish requirements. Keep conditions appearing only in review reports out of this table and assess them as added requirements below. Check that each cited source actually specifies the row's subject, input, evaluation point, and expected result.

**Condition comparison worksheet:**
```markdown
| Original requirement or adjudication source | Operation or state being checked and its owner | Input or precondition | Evaluation point and expected result | Current test and implementation-path evidence | Fulfilled or unmet, with reason |
|---|---|---|---|---|---|
```

To retain a finding, identify which original condition in this table remains unmet. When an original condition is fulfilled, do not mix an additional observation method into that row's unmet reason; assess it separately as an added requirement below.

**Basis for an added requirement:** If a review report asks for another observation or operation, identify what it adds to the original conditions. Establish whether that addition is an explicit verification obligation, a representative untested condition of behavior changed in this task, or regression prevention for a confirmed defect. Use requirements, diffs, or current code independent of the review report's own claim.

Even when declining an added requirement, check whether the alleged inconsistency occurs in the current implementation. Record, with code citations, the conditions under which the relevant operation executes and whether the target input and path meet those conditions. Do not treat an unverified condition as evidence that no inconsistency exists.

Require repairs only for mandatory gaps remaining after this comparison. Do not substitute an explanation that existing tests would miss a hypothetical mutation for the mandatory basis of an added requirement. If the original obligation is fulfilled and the addition has no mandatory basis, close the existing finding for that reason.
