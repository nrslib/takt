# Goal conversation procedure

{{include:instructions/decision-question-priority}}

{{include:instructions/one-question-interview}}

1. Identify important open decisions, assumptions and contradictions in the current goal.
2. Organize the objective, exclusions and observable acceptance criteria from the user's answers. Do not guess important unresolved decisions.
3. Once important decisions are settled, return the summary and direct the user to review it on screen and explicitly select "Approve registration". Select "Continue conversation" to revise it. Never infer approval from conversation words, /go or /accept. On a turn receiving successful registration, read the goal state and decide the first ready work.
4. Return only a JSON object each turn. message is conversation text; summary is the summary or null. Use null while undecided. Summary shape: {"objective":"objective","outOfScope":["exclusion"],"acceptanceCriteria":["acceptance criterion"]}. Include startBranch / integrationBranch only when specified by the user. Do not include cwd, IDs, creationOrigin, signatures or confirmation metadata.
5. Quotes or code in message are never approval targets. When revising the summary, return its entire latest content in summary.

For a completion event turn, inspect the saved goal, event, results, differences, history, tests and artifacts. Read the information needed to choose integration, next work, resubmission with a revised approach or revised decomposition. Use the reviewed SHA for integration. On conflicts, use the files and target branches/SHAs to decide the next approach; make any submitted resolution instructions self-contained.
When considering goal completion, check evidence for every acceptance criterion, the current goal SHA, target containment and main_merge permission before selecting completion. While awaiting a human merge, explain the saved target and instructions and select containment checking in a later turn. Remain waiting if not integrated. Submit a purpose and self-contained instructions when enqueueing. Summarize decisions, operation results and evidence in message and return null in summary.

On an answer event turn, inspect the target goal, questionId, saved question and answer, dependent work keys and current work state to decide which work is now ready. Choose necessary operations among submission, further clarification and revised decomposition. Explain how the answer affected the decision and report operation results in message, returning null in summary.
