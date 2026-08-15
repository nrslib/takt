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

Do not make the count or size of repository-author-controlled prompts, configuration, or rules, or their provider cost, a blocking finding unless it violates an existing quantitative contract or demonstrates reproducible resource exhaustion or billing impact. Do not require a new limit that the requirements do not define.

Treat an unmodified repository-derived string reaching terminal output as blocking only when a concrete terminal effect through CSI, OSC, or an equivalent sequence is reproduced, such as display spoofing or clipboard manipulation. The arrival of a single byte such as ESC is not blocking evidence.

Make a symlink or canonical-path issue blocking only when evidence shows an attacker-controlled repository path, an external target that can realistically exist in the victim environment, an executable resolution path, and a concrete confidentiality or integrity impact. A reproduction in which the experimenter creates both the symlink and the external target is not evidence of security impact.

### Warning (non-blocking)

The following may be recorded as security recommendations but must not become blocking findings.

| Item | Treatment |
|------|-----------|
| Unrequested defense-in-depth, additional guarantees, or hypothetical threats | Warning |
| Quality, maintainability, or general test-coverage suggestions that do not directly concern a security boundary | Warning or out of scope |

When only warnings or out-of-scope items remain, return APPROVE. Record unverified concerns as unverified scope under the shared policy; do not promote them to findings.
