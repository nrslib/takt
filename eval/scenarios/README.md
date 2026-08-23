# Scenario evals

Scenario evals execute more than one agent step and verify the artifact
handoff between them. A flow belongs here when replacing an upstream agent
with a seeded report would remove behavior that the evaluation is intended to
measure. Multi-role workflow behavior, such as fix and loop-monitor decisions
over the same remediation scenario, also belongs here.
