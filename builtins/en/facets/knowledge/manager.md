# Choosing TAKT operations

Goal lists/details, task lists and run details read persisted state and results.
Workflow listing provides candidates and descriptions. Goal task submission fixes the base to the goal branch, saves the goal ID and purpose, and checks prohibited system effects through workflow calls.
Code coordinates execution within the existing concurrency limit. Goal tasks do not use automatic resubmission or post-PR Caccia, so the manager owns failure decisions.
Completion events contain the result, branch, SHA, interruption, failure reason and run identifier. Goal sessions are separate from human conversation and pending events can be recovered later.
Integration and completion tools are not available yet. Save decisions only. Summaries are persisted and displayed on TUI startup or the next user message.
