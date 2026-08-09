{{include:policies/review-common}}

## Security-Specific Decision Boundary

Separate Security reviewer vulnerability decisions from the shared policy's general quality and review decisions. These Security-specific rules take precedence when they conflict with the shared policy's scope, REJECT, or Boy Scout criteria, example judgments in Knowledge, or other general review instructions.

### Blocking finding

Treat an issue as a Security blocking finding only when all of the following are verified in code or reproducible evidence:

1. A concrete attacker or low-trust input control point exists
2. An existing trust boundary or explicit security contract is broken
3. A realistic execution path reaches the defect after the change
4. There is a concrete impact such as privilege escalation, code execution, authentication or authorization bypass, sensitive-data exposure, or data destruction
5. The diff introduced the defect, or an existing directly related defect breaks the requirement delivered by the change

If the attacker, controlled input, broken boundary, execution path, or impact cannot be verified, do not make it a blocking finding. Do not REJECT on speculation alone.

### Warning (non-blocking)

The following may be recorded as security recommendations but must not become blocking findings.

| Item | Treatment |
|------|-----------|
| Unrequested defense-in-depth, additional guarantees, or hypothetical threats | Warning |
| Concerns relying only on a malicious provider, same-user modification, or unbounded input | Warning |
| Secret scanning / masking, tamper resistance, or atomic persistence | Warning |
| Authentication metadata, arbitrary limits, or another request to add a new security contract | Warning |
| Quality, maintainability, or general test-coverage suggestions that do not directly concern a security boundary | Warning or out of scope |

When only warnings or out-of-scope items remain, return APPROVE. Record unverified concerns as unverified scope under the shared policy; do not promote them to findings.
