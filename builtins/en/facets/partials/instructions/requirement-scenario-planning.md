## Requirement Scenario Planning

Before finalizing completion contracts, classify each contract against these boundary risks:

- **Structured input**: classification or transformation where the same literal text is in scope or out of scope depending on position or context (code fences, literals, comments, quotes, and escaped regions change the result)
- **Identifier generation**: generated identifiers, sequence numbers, or names share a namespace with existing content, persisted data, or other artifacts generated in the same operation

For qualifying contracts, fix the in-scope and out-of-scope regions (or the existing namespace and potentially colliding existing values) with concrete input fragments, and write positive/negative scenario pairs in the output contract's Requirement Scenarios section.

For the structured-input class, enumerate the variants that belong to the target format's family (alternative delimiter or fence syntaxes, nesting, unclosed forms), fix whether each variant is in scope or out of scope under the existing contracts, and include a representative out-of-scope variant in a negative scenario (when there are many variants, bundle them with And clauses in a single scenario's Given). For the identifier-generation class, include one negative scenario for whichever the existing contracts define as rejected or avoided: numeric boundaries (huge values, non-numeric values) or collisions with the existing namespace.

Scenarios concretize existing completion contracts and never create new requirements. When no contract qualifies, write one line: "Not applicable — no qualifying completion contract".
