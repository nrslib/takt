{{include:instructions/contract-path-analysis}}

For every problem whose verification found a gap, recheck its cause, violated condition, the source that defines that condition, and affected paths. Repair only existing paths required by the planned acceptance criteria. Add an unvisited consumer only when code shows that the same cause affects it.

When verification records that a search or verification method failed, recheck paths previously treated as confirmed by that method. Distinguish implementation or evidence gaps from deficiencies in assumptions, boundaries, or methods that require a plan change.
