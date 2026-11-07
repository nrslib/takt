## Specification Notation

- First determine whether the task is a development or implementation task whose deliverables create or change code, configuration, infrastructure, or tests.
- For development or implementation tasks, use Gherkin only for important observable behavior where a misunderstanding would materially change the implementation result, and do not duplicate the same acceptance clause in Markdown and Gherkin.
- Always write the Gherkin `Feature`, `Rule`, `Background`, `Scenario`, `Scenario Outline`, `Examples`, `Given`, `When`, `Then`, `And`, and `But` keywords in English, even when the conversation or instruction uses another language; do not use a localized `# language` directive. Descriptions after the keywords may use the instruction language.
- For research, analysis, review, planning, documentation, operations, decision support, or any other task whose deliverable is not an implementation, do not use Gherkin.
{{#if formalSpec}}
- Express the requirements in both Quint and Alloy. Quint and Alloy may overlap with other notations, but keep the prohibition on duplicating acceptance clauses between Markdown and Gherkin. Do not add Gherkin to non-development tasks.
- Always include both Quint and Alloy for this goal.
- Use actual valid Quint and Alloy syntax instead of inventing pseudo-notation.
{{formalSpecVerifierConstraints}}
- Preserve the precise semantics of each requirement in both notations rather than replacing it with a weaker property. For example, "X eventually becomes Y unless Z happens first" must retain the no-Z condition and the required Y outcome; "X eventually becomes Y or Z" is not equivalent.
- Within each notation, make the model internally consistent: every action or transition must preserve its invariants, and every required eventual outcome must be reachable through the modeled transitions. Do not merely declare a property that the same model can violate or cannot realize.
- In Quint, use one valid mode qualifier per definition, such as `action Name = ...` or `temporal Name = ...`; never write `temporal val` or `temporal def`. Initialize every state variable in the init action with a primed assignment such as `x' = initialValue`, without reading an uninitialized current value.
- In Alloy, a mutable lifecycle must include the transition predicates and trace constraints needed to realize every transition referenced by its temporal requirements. Do not state a temporal fact whose required transition is absent or unconstrained in the same Alloy model.
- During conversation, use a small ASCII diagram only when it helps explain a state machine, violation trace, or relation instance.
{{/if}}
{{#if formalSpecCommentsEnabled}}
- Within each Quint and Alloy code block, immediately precede every requirement-level formal construct—such as the state model, a state transition, a temporal property, an invariant, an ownership rule, or a cardinality rule—with natural-language comments that fully explain its domain meaning. A construct that covers multiple requirements must have adjacent comments that explain every one of them; multiple comment lines are allowed.
- Treat declarations that introduce requirement-specific states or domain values as requirement-level constructs too. Immediately before each such declaration, name every value in a comment and explain what each value means in the domain; do not leave an enum, union, signature, or equivalent state declaration to be understood from syntax alone.
- Make each notation independently understandable. By reading only the comments inside the Quint block, and separately only the comments inside the Alloy block, a developer unfamiliar with that notation must be able to recover every requirement, including its conditions and required outcome. Do not refer to the other notation or rely on Markdown, Gherkin, or prose outside the block.
- Explain what each construct guarantees, prohibits, permits, or eventually requires. Name every domain state and other requirement-specific value in the comments instead of replacing them with a count or category such as "the four states." Do not merely paraphrase identifiers, operators, quantifiers, or other syntax, and do not use vague comments such as "validates the lifecycle."
- Comments supplement the formal specification; they do not replace any Quint or Alloy expression required above.
- Before completing the instruction, inspect each formal code block independently and verify that every requested requirement is present both as formal syntax and as a complete adjacent meaning comment, and that the block's transitions preserve its stated requirements.
{{/if}}
