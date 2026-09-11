Investigate the cause preventing confirmation of the repair plan by executing focused experiments.

## Repair plan
{report:fix-plan.md}

If fix-investigation.md exists in Report Directory, inspect its previous hypotheses, execution conditions, and results.

- Limit investigation to currently adopted finding IDs and unresolved causes. Follow the plan's hypotheses, fixed conditions, single varied condition, and observation target when reproducing, collecting logs, or measuring. Minimal reproduction tests or temporary instrumentation are allowed; do not implement production repairs based on an unconfirmed cause or weaken acceptance criteria.
- For suspected concurrency or timing causes, repeat controlled conditions and compare with exactly one changed condition, tracing the failed operation. A successful isolated run or increased timeout alone does not establish a cause.
- Record commands, target code and environment, repetition counts, observed successes and failures, and log locations. Separate facts from hypotheses, identify ruled-out and unresolved causes, and specify the next untried experiment. Repeating unchanged conditions alone is not new evidence.
- Record temporary changes and whether they remain. Revert only unnecessary changes introduced for this investigation; preserve other changes.
