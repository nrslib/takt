## Requirement Scenario Planning

Before finalizing completion contracts, classify each contract against these boundary risks:

- **Structured input**: classification or transformation where the same literal text is included or excluded depending on position or context (code fences, literals, comments, quotes, and escaped regions change the result)
- **Identifier generation**: generated identifiers, sequence numbers, or names share a namespace with existing content, persisted data, or other artifacts generated in the same operation

For qualifying contracts, fix the included and excluded regions (or the existing namespace and potentially colliding existing values) with concrete input fragments, and write positive/negative scenario pairs in the Requirement Scenarios section.

For the structured-input class, enumerate the supported variants of the target format (alternative delimiter or fence syntaxes, nesting, unclosed forms), determine whether each variant is included or excluded under the existing contracts, and include a representative excluded variant in a negative scenario (when there are many variants, bundle them with And clauses in a single scenario's Given). For the identifier-generation class, include one negative scenario for whichever the existing contracts define as rejected or avoided: numeric boundaries (huge values, non-numeric values) or collisions with the existing namespace.

Scenarios concretize existing completion contracts and never create new requirements. When no contract qualifies, write one line: "Not applicable — no qualifying completion contract".
