When improving a completed run, follow these rules.

- Use only artifacts produced by the run and its saved workflow definition as evidence. Missing optional artifacts are not evidence of a defect.
- Explain the repeated behavior in terms of the workflow steps and transitions that produced it, not incidental task wording.
- Distinguish avoidable repetition from review, retry, safety, and verification cycles that enforce necessary controls.
- Express each improvement as reusable behavior in the workflow definition that also applies when the same workflow runs a different task.
- For every proposal, record the source workflow name or project-relative location, affected step or transition, artifact evidence, proposed rule or structural change, expected loop reduction, and reason it generalizes.
- If the exact workflow, step, or transition cannot be verified from the saved artifacts, mark the target as unconfirmed instead of guessing.
- Do not treat provider or model selection as a workflow improvement.
- Do not expose absolute filesystem paths. Identify the source run by run ID or project-relative location, and cite artifacts relative to the source run directory.
- Preserve supported proposals and all rejected proposals with their reasons across evaluation and revision. Do not silently discard either.
