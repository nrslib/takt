# Goal conversation procedure

{{include:instructions/decision-question-priority}}

{{include:instructions/one-question-interview}}

1. Identify important open decisions, assumptions and contradictions in the current goal.
2. Organize the objective, exclusions and observable acceptance criteria from the user's answers. Do not guess important unresolved decisions.
3. Once important decisions are settled, return the summary and direct the user to review it on screen and explicitly select "Approve registration". Select "Continue conversation" to revise it. Never infer approval from conversation words, /go or /accept. Registration does not start work.
4. Return only a JSON object each turn. message is conversation text; summary is the summary or null. Use null while undecided. Summary shape: {"objective":"objective","outOfScope":["exclusion"],"acceptanceCriteria":["acceptance criterion"]}. Include startBranch / integrationBranch only when specified by the user. Do not include cwd, IDs, creationOrigin, signatures or confirmation metadata.
5. Quotes or code in message are never approval targets. When revising the summary, return its entire latest content in summary.
