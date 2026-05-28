# Existing System Knowledge

## Existing System Contracts

In an existing system, contracts are not limited to explicit APIs. Values and structures observed by users or developers also function as contracts. A small code change can affect production screens, tests, reviews, and maintenance workflows.

| Criteria | Judgment |
|----------|----------|
| User-visible copy or state changes | Contract change |
| A value asserted by tests changes | Contract change |
| Hook or component call shape changes | Contract change |
| Only file placement or type names change | May still be a maintenance contract change |
| Closed internal duplication is removed | Internal change if impact is contained |

## Diff Classification

Changes in existing systems are classified by causal relationship to the request. The question is whether the request requires the change, not whether the change is in a touched file.

| Classification | Decision criteria |
|----------------|-------------------|
| Required change | Directly required to satisfy the request |
| Related change | Required to wire, verify, or keep a required change consistent |
| Unnecessary change | The request still succeeds without it |
| Dangerous unnecessary change | The request still succeeds without it and it changes an existing contract |

### Boundary of Related Changes

A related change must have an explainable connection to a required change. Proximity, same file, or same responsibility is not enough.

| Example | Classification |
|---------|----------------|
| Updating callers after adding a required parameter | Related change |
| Deleting an old store after changing persistence boundary | Related change |
| Renaming a touched component's Props type by preference | Unnecessary change |
| Changing a hook return shape to a props object as cleanup | Dangerous unnecessary change |

## Conflicts With General Quality Criteria

In maintenance work, general design improvements and framework style are not always the highest priority. Even when the existing structure is imperfect, leaving it unchanged can be lower risk when the request does not require changing it.

| Situation | Judgment |
|-----------|----------|
| Component extraction would look cleaner but is unnecessary for this fix | Do not change |
| Renaming or relocating Props types only to match common style | Do not change |
| The existing structure cannot satisfy the request | Change the minimum necessary scope |
| The existing structure is the cause of the bug | Change it with reason and impact scope documented |

## Meaning of Comments and Tests

Comments and tests may preserve historical constraints or intent. Even comments that look explanatory can act like contracts when they document calculation rationale, platform constraints, or known workaround reasons.

| Target | Handling |
|--------|----------|
| Calculation rationale comments | Preserve |
| Constraint or workaround comments | Preserve |
| Comments contradicting code | Correct |
| Comments that only restate function names | May consider deleting |
| Existing test expectations | Treat as existing contracts |

## Maintenance Change Risk

For maintenance work, preserving existing behavior is more important than making new code look better. Even a technically good change increases review cost and regression risk when it is outside the request.

| Change | Risk |
|--------|------|
| Rename | Increases grep, history tracing, and review scope |
| File move | Changes ownership boundaries, imports, and history tracing |
| UI contract change | Changes user experience, assistive technology behavior, and tests |
| Test weakening | Reduces regression detection |
| Extra abstraction | Adds present understanding cost for future flexibility |
