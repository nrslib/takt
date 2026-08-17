# Existing System Knowledge

## Existing System Contracts

In an existing system, contracts are not limited to explicit APIs. Values and structures observed by users or developers also function as contracts. A small code change can affect production screens, tests, reviews, and maintenance workflows.


Existing-contract preservation, current-consumer migration, and legacy support affect different boundaries. For a replaced public API, event, command, configuration, path, or persisted format, current code, existing tests and usage sites, stored or persisted data, published or released status, and placement or isolation at a read boundary reveal impact paths. API compatibility, event upcasters, data migration or backfill, and Read Model rebuilds operate on distinct support boundaries and do not imply one another.

## Diff Classification

Changes in existing systems are classified by causal relationship to the request. The question is whether the request requires the change, not whether the change is in a touched file.


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


## Meaning of Comments and Tests

Comments and tests may preserve historical constraints or intent. Even comments that look explanatory can act like contracts when they document calculation rationale, platform constraints, or known workaround reasons.

| Target | Handling |
|--------|----------|
| Calculation rationale comments | Preserve |
| Constraint or workaround comments | Preserve |
| Comments contradicting code | Correct |
| Comments that only restate function names | May consider deleting |
| Existing test expectations outside the change scope | Treat as existing contracts when they map to observable behavior; existence alone does not make internal structure a contract |
| Existing tests that pin the contract being replaced | Evidence of impacted assertions and consumers |

## Maintenance Change Risk

For maintenance work, preserving existing behavior is more important than making new code look better. Even a technically good change increases review cost and regression risk when it is outside the request.

| Change | Risk |
|--------|------|
| Rename | Increases grep, history tracing, and review scope |
| File move | Changes ownership boundaries, imports, and history tracing |
| UI contract change | Changes user experience, assistive technology behavior, and tests |
| Test weakening | Reduces regression detection |
| Extra abstraction | Adds present understanding cost for future flexibility |
