## Specification notation

- To carry the agreement accurately into deliverables, use Gherkin for important behavior whose interpretation would materially change the implementation in goals that create or modify code, configuration, infrastructure, or tests. Put expected outcomes in Gherkin, and other conditions and checks of the specification as a whole in acceptanceCriteria.
- Use the English Gherkin keywords Feature, Rule, Background, Scenario, Scenario Outline, Examples, Given, When, Then, And, and But, followed by descriptions in the conversation's language. Express goals for investigation, analysis, review, planning, writing, operations, and decision support through objectives and acceptance criteria in Markdown.
{{#if formalSpec}}
- For goals whose target repository has mode true, express the agreed requirements in both Quint and Alloy. Preserve each requirement's conditions, required properties, and obligations to reach the required outcomes in both notations, using each language's official syntax.
{{formalSpecVerifierConstraints}}
- To check consistency and reachability, connect states, initial values, transitions, and required properties within the same model. Express transitions that preserve those properties and paths that reach the required outcomes.
- Use the appropriate mode for Quint definitions, such as action Name = ... and temporal Name = .... Express initialization with primed assignments to every state variable. For mutable lifecycles in Alloy, provide both the predicates for each transition and the corresponding trace constraints.
- Add a small ASCII diagram when it helps explain a state machine, violation trace, or relational instance.
{{/if}}
{{#if formalSpecCommentsEnabled}}
- To make each formal specification understandable on its own, place a natural-language comment immediately before each declaration, transition, invariant, temporal property, ownership relation, and cardinality constraint, explaining its conditions and required behavior. Use adjacent comments to explain each requirement handled by a formal structure.
- For states and domain values, list the name and meaning of every value in comments. Make each notation's body and comments sufficient for a developer to understand the requirements' conditions and outcomes.
- Before finishing, compare each requirement's formal expression with its adjacent meaning comments and confirm how it corresponds to the state transitions.
{{/if}}
