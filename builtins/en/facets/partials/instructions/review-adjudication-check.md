{{include:instructions/review-path-check}}

For each submitted concern, confirm its invariant, responsible source, evidence, required migrations, and boundary from adjacent contracts in the current code. Do not start a general initial scan. Compare only the paths needed to validate findings and omissions within the submitting reviewer's assigned perspective.

Before deciding, list every submitted finding ID from each reviewer report currently available in the Report Directory without removing duplicates. For earlier rounds, preserve decisions recorded in the existing adjudication; do not assume that an earlier version of a same-named report is available. Newly decide only unresolved IDs present in current reports. Repair history and completion-verification reports may be used as evidence, but do not treat them as sources that submitted findings.

For each actual reviewer report, such as `architect-review.md`, `testing-review.md`, or `coding-review.md`, verify not only recorded findings but also paths excluded as no problem, out of scope, unsupported, or unexamined. Compare them with the requirements, current change, and recorded repair boundary. When the same violated condition and acceptance criteria apply to a real path and its exclusion is unsupported, adjudicate it as an omission within that reviewer's assigned perspective. If existing acceptance criteria require every affected consumer to retain required information or state and a real path loses it, do not exclude that path merely because no separate local specification is available. Determine the scope of "every affected consumer" from verified code connections that receive the input governed by the acceptance criteria and transform, persist, transfer, or expose its result, not from matching names or types. Conversely, when a path satisfies the stated condition, do not turn unstated uniqueness, reversibility, input-domain, or similar guarantees into a new violation unless the original requirement, a public specification, or a real consumer guarantees them. Sharing a conceptual value, a similar representation, or the same outer result is not enough to include a path in the same problem. Do not expand into another specialist perspective or an adjacent contract.

When a change connects existing behavior to a new consumer or public result, do not stop at an inner responsible component; also verify the consuming result. Add an inner check only when it is needed to distinguish conditions or causes that the outer boundary cannot distinguish, and do not require duplicate checks of the same condition.

When verification confirms an omission, do not create a new role or intermediate report name. Cite the actual source report, such as `testing-review.md (not reported)`.

For every listed ID and confirmed omission, decide the technical result, whether it requires repair now, and which existing problem it joins when concerns are consolidated. Do not finalize the overall decision until every item has a decision.

For a concern first submitted in a post-repair review, use the code before and after the repair or the repair history to distinguish an uninspected path that already violated the same condition from a regression introduced by the repair. If the evidence cannot distinguish them, do not guess; record the confirmed facts and why the distinction remains unverified.

When repair history records that the repair added a path or behavior, current code confirms the resulting state, and no evidence contradicts the record, use that history to distinguish the before and after states. Do not return the recorded repair to an unverified state solely because Git history is unavailable.

An observed phenomenon does not by itself make a concern a repair target. Do not create a new contract during adjudication for an error type or message, accepted input shape, or similar condition that is not guaranteed by the original requirement, a public specification, or a real consumer.

Decide whether repair is required and whether concerns share one cause from the original request, acceptance criteria, current change, and verified evidence.
