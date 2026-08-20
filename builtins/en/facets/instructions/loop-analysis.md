Inspect the completed run directory identified in the task.

Read the available session JSONL logs under `logs/`, `trace.md`, `monitor.json`, and report files. Missing optional artifacts are not evidence of a defect; base every conclusion on artifacts that exist.

Identify avoidable loops such as repeated misunderstanding, repeated review rejection for the same cause, ineffective correction instructions, or redundant work. Distinguish these from required review, retry, safety, and verification loops.

For each proposal:

1. Cite the run artifact evidence and describe the repeated behavior.
2. Identify the owning facet file by a concrete path under a `facets/` directory. Valid facet kinds are persona, policy, knowledge, instruction, and output-contract.
3. Provide the exact addition or change in enough detail for a human to evaluate and apply it.
4. Explain why the proposal generalizes beyond this run and which avoidable loop it should reduce.
5. Record plausible proposals you considered but rejected, with the reason for rejection.

Do not edit any facet. Produce an evidence-based proposal set for independent review.
