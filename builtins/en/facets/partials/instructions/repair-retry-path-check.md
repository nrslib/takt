{{include:instructions/contract-path-analysis}}

For every problem whose verification found a gap, reconstruct its invariant, responsible source, and complete affected path graph. Repair only paths inside the bounded graph recorded in the plan. Add an unvisited consumer only when it is governed by that same invariant and is required by the acceptance criteria.

When verification records that a search or proof method failed, invalidate that method and reopen the affected paths closed under the same assumption. Carry recurrence history forward unchanged, and distinguish implementation or evidence gaps from deficiencies in assumptions, boundaries, or methods that require a plan change.
