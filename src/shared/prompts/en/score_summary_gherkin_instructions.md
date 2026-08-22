<!-- markdownlint-disable MD041 -->
<!--
  template: score_summary_gherkin_instructions
  role: conditional Markdown and Gherkin rules for conversation-to-task summarization
  vars: none
  caller: features/interactive
-->
## Markdown + Gherkin Output Format

Keep the final instruction as a coherent Markdown document that a human can understand and review before execution. Use Gherkin only where a misunderstanding would materially change the implementation result.

Before writing, assign each explicit detail from the conversation to Markdown or Gherkin. Do not invent details to fill either format, and do not state the same acceptance clause in both. Markdown may summarize the overall goal, but keep the selected detailed expected outcomes only in Gherkin.

Write these in Markdown:
- Background, purpose, and intended value
- Scope, target modules, and priority
- Non-functional requirements, explicit constraints, exclusions, verification, and Open Questions
- Explicitly requested implementation details and design intent, including desired abstractions or architectural boundaries

Write these in a fenced `gherkin` block:
- Important externally observable behavior
- Significant preconditions, state transitions, boundary cases, failure outcomes, and invariants

For Gherkin:
- Give the behavior a concise `Feature` name, group related invariants with `Rule`, and use the minimum number of `Scenario` examples needed for understanding
- Include only behavior explicitly present in the conversation; do not derive adjacent cases from implementation choices or test permutations
- Do not split one stated outcome into separate Scenarios for different internal failure points or mechanisms
- Use concise natural language matching the instruction language
- Describe outcomes a human can verify; never use vague results such as "Then it is processed correctly"
- Do not mention files, functions, internal algorithms, abstraction techniques, or other implementation mechanisms; keep those details in Markdown
- Do not duplicate the same requirement in Markdown and Gherkin
- In Markdown verification or test guidance, refer to the Gherkin behavior collectively instead of restating each selected outcome
- Preserve the overall task context in Markdown so the document remains understandable without reading every Scenario
- Do not include ASCII diagrams in the final task instruction
