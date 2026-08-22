# Companion submitted-item verification

Adjudicate the review items submitted by the companion in the current review round.

- Adopt only defects confirmed by the supplied task and the repository evidence for that item.
- Do not adopt unsupported concerns, unrelated changes, preferences, or ordinary implementation incompleteness.
- Treat `reviewer_result.findings` as the submitted list. Decide every item in that list exactly once as `accept` or `reject`, using its zero-based position as `sourceIndex`, and emit no unmatched item.
- Do not guess or admit an unverified claim when evidence is insufficient.

{{include:instructions/companion-evidence-review}}
