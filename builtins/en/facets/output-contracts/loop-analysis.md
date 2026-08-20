```markdown
# Loop Analysis Report

## Decision
- Result: `{APPROVE or REVISE}`

## Source Run
- Run: {run ID or project-relative location}
- Artifacts examined: {paths relative to the source run directory}

## Accepted Workflow Improvements

### {proposal title, or "None"}
- Workflow definition: `{verified source workflow reference or path, or "Unconfirmed"}`
- Affected step or transition: `{verified name, or "Unconfirmed"}`
- Evidence: {artifact path and observed repeated behavior}
- Proposed rule or structural change: {specific workflow-level addition or modification}
- Expected loop reduction: {avoidable loop addressed}
- Generalization: {why this applies beyond the source run}

## Required Reanalysis

### {required correction, or "None"}
- Proposal: {proposal affected by this correction}
- Evidence or gap: {artifact path and the unsupported claim, targeting error, missing case, or weakened control}
- Required correction: {specific change needed before approval}

## Rejected Proposals

### {proposal title, or "None"}
- Workflow definition: `{candidate source workflow reference or path, or "Unconfirmed"}`
- Affected step or transition: `{candidate name, or "Unconfirmed"}`
- Rejection reason: {why it was unsupported, over-specialized, unsafe, redundant, or targeted incorrectly}
```

Include every accepted proposal, every required correction, and every proposal rejected during analysis or evaluation. Do not omit rejected proposals when the final accepted set is empty. Use `None` for Required Reanalysis when the result is `APPROVE`. Do not include absolute filesystem paths or runner-identifying path components.
