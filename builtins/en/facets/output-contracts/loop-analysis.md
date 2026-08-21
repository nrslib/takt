```markdown
# Loop Analysis Report

## Decision
- Result: `{APPROVE or REVISE}`

## Source Run
- Run: {run ID or project-relative location}
- Artifacts examined: {paths relative to the source run directory}

## Accepted Workflow Improvements

### {proposal title, or "None"}
- Change scope: `{Workflow-wide rule or step-specific prompt component}`
- Workflow definition: `{verified source workflow reference or path, or "Unconfirmed"}`
- Affected step or transition: `{verified name, or "Unconfirmed"}`
- Verified target file: `{source-run-relative path, "Not applicable", or "Unconfirmed"}`
- Evidence: {artifact path and observed repeated behavior}
- Proposed change: {specific workflow-wide rule or step-specific prompt change}
- Expected loop reduction: {avoidable loop addressed}
- Generalization: {why this applies beyond the source run}

## Required Reanalysis

### {required correction, or "None"}
- Proposal: {proposal affected by this correction}
- Evidence or gap: {artifact path and the unsupported claim, targeting error, missing case, or weakened control}
- Required correction: {specific change needed before approval}

## Disposition of Prior Findings

### {finding, or "Not applicable" for the initial review}
- Result: `{Addressed, Cannot be addressed, or Not applicable}`
- Evidence: {artifact showing the correction, or artifact and reason showing why the proposal was withdrawn}

## Rejected Proposals

### {proposal title, or "None"}
- Change scope: `{Workflow-wide rule or step-specific prompt component}`
- Workflow definition: `{candidate source workflow reference or path, or "Unconfirmed"}`
- Affected step or transition: `{candidate name, or "Unconfirmed"}`
- Verified target file: `{source-run-relative path, "Not applicable", or "Unconfirmed"}`
- Rejection reason: {why it was unsupported, over-specialized, unsafe, redundant, or targeted incorrectly}
```

Include every accepted proposal, every required correction, every prior-finding disposition, and every proposal rejected during analysis or evaluation. Do not omit rejected proposals when the final accepted set is empty. Use `None` for Required Reanalysis when the result is `APPROVE`. Before saving or publishing the report, remove secrets, credentials, tokens, personally identifiable information, absolute filesystem paths, and runner-identifying metadata.
