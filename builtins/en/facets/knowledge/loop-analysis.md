# TAKT Workflow Analysis Model

A TAKT workflow defines its execution process through steps, transitions, rules, and the facets composed into each step.

- Facets are composed independently. A facet does not implicitly know the contents of another facet used by the same or a different step.
- Put invariants shared by multiple steps in a workflow-wide rule instead of duplicating them across individual facets.
- Carry information between steps through the previous response or an explicit report. Do not make one step refer directly to another step's facet.
- The workflow definition owns routing and execution order. The corresponding facet owns procedures, roles, decision material, or output structure specific to one step.
- During analysis, inspect both the workflow structure and the facets actually referenced by each step, then assign the cause and proposed change to the layer that owns them.
