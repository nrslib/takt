## Requirement Scenario Planning

Before finalizing completion contracts, classify each contract against these boundary risks:

- **Structured input**: classification or transformation where the same literal text is in scope or out of scope depending on position or context (code fences, literals, comments, quotes, and escaped regions change the result)
- **Identifier generation**: generated identifiers, sequence numbers, or names share a namespace with existing content, persisted data, or other artifacts generated in the same operation

For qualifying contracts, fix the in-scope and out-of-scope regions (or the existing namespace and potentially colliding existing values) with concrete input fragments, and write positive/negative scenario pairs in the output contract's Requirement Scenarios section. Scenarios concretize existing completion contracts and never create new requirements. When no contract qualifies, write one line: "Not applicable — no qualifying completion contract".
