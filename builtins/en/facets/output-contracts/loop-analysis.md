```markdown
# Loop Analysis Report

## Source Run
- Run directory: {absolute source run directory}
- Artifacts examined: {concrete paths}

## Accepted Proposals

### {proposal title, or "None"}
- Facet path: `{concrete persona, policy, knowledge, instruction, or output-contract path}`
- Evidence: {artifact path and observed repeated behavior}
- Proposed change: {specific addition or modification}
- Expected loop reduction: {avoidable loop addressed}
- Generalization: {why this applies beyond the source run}

## Rejected Proposals

### {proposal title, or "None"}
- Facet path: `{candidate path when one was identified}`
- Rejection reason: {why it was unsupported, over-specialized, unsafe, redundant, or assigned to the wrong owner}
```

Include every accepted proposal and every proposal rejected during analysis or review. Do not omit rejected proposals when the final accepted set is empty.
