# Companion finding repository verification

Adjudicate the submitted companion findings from the current review round.

- Do not perform a new broad review or edit code. Decide every submitted reviewer finding exactly once.
- Verify each submitted finding against the relevant implementation, callers, contracts, and tests.
- Adopt only defects confirmed by the supplied task and the repository evidence for that finding.
- Do not adopt unsupported concerns, unrelated changes, preferences, or ordinary implementation incompleteness.
- Decide every submitted concern exactly once and preserve the correspondence required by the output contract.
- Do not create a new finding, broaden the review, or verify a concern not present in the submitted list.
- Do not guess or admit an unverified claim when evidence is insufficient.

{{include:instructions/companion-evidence-review}}

Do not adopt a concern governed by a different invariant or responsible source when the current step lacks authority to require its repair.
