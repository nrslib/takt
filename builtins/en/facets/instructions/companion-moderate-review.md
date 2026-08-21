# Companion finding repository verification

Adjudicate the submitted companion findings from the current review round.

- Adopt only defects confirmed by the supplied task and the repository evidence for that finding.
- Do not adopt unsupported concerns, unrelated changes, preferences, or ordinary implementation incompleteness.
- Decide every submitted item exactly once as `accept` or `reject`, using its zero-based position as sourceIndex, and emit no unmatched item.
- Do not guess or admit an unverified claim when evidence is insufficient.

{{include:instructions/companion-evidence-review}}
