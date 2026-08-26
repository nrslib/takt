<!-- markdownlint-disable MD041 -->
<!--
  template: score_summary_formal_spec_instructions
  role: conditional Alloy and Quint rules for conversation-to-task summarization
  vars: none
  caller: features/interactive
-->
## Formal Specification Notation

- In addition to Markdown, express the requirements in both Quint and Alloy. Quint and Alloy may overlap with other notations, but keep the prohibition on duplicating acceptance clauses between Markdown and Gherkin. Do not add Gherkin to non-development tasks.
- Omit a notation only when the task genuinely cannot be expressed in that notation.
- Use actual valid Quint and Alloy syntax instead of inventing pseudo-notation.
- Within each Quint and Alloy code block, immediately precede every requirement-level formal construct—such as the state model, a state transition, a temporal property, an invariant, an ownership rule, or a cardinality rule—with natural-language comments that fully explain its domain meaning. A construct that covers multiple requirements must have adjacent comments that explain every one of them; multiple comment lines are allowed.
- Make each notation independently understandable. By reading only the comments inside the Quint block, and separately only the comments inside the Alloy block, a developer unfamiliar with that notation must be able to recover every requirement, including its conditions and required outcome. Do not refer to the other notation or rely on Markdown, Gherkin, or prose outside the block.
- Explain what each construct guarantees, prohibits, permits, or eventually requires. Name every domain state and other requirement-specific value in the comments instead of replacing them with a count or category such as "the four states." Do not merely paraphrase identifiers, operators, quantifiers, or other syntax, and do not use vague comments such as "validates the lifecycle."
- Comments supplement the formal specification; they do not replace any Quint or Alloy expression required above.
- Preserve the precise semantics of each requirement in both notations rather than replacing it with a weaker property. For example, "X eventually becomes Y unless Z happens first" must retain the no-Z condition and the required Y outcome; "X eventually becomes Y or Z" is not equivalent.
- Within each notation, make the model internally consistent: every action or transition must preserve its invariants, and every required eventual outcome must be reachable through the modeled transitions. Do not merely declare a property that the same model can violate or cannot realize.
- In Quint, use one valid mode qualifier per definition, such as `action Name = ...` or `temporal Name = ...`; never write `temporal val` or `temporal def`. Initialize every state variable in the init action with a primed assignment such as `x' = initialValue`, without reading an uninitialized current value. A temporal progress property must account for stuttering or fairness so that an always-enabled no-op trace cannot violate the claimed eventual outcome.
- In Alloy, a mutable lifecycle must include the transition predicates and trace constraints needed to realize every transition referenced by its temporal requirements. Do not state a temporal fact whose required transition is absent or unconstrained in the same Alloy model.
- Before completing the instruction, inspect each formal code block independently and verify that every requested requirement is present both as formal syntax and as a complete adjacent meaning comment, and that the block's transitions preserve its stated requirements.
