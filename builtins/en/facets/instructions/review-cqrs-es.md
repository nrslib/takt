Focus on reviewing **CQRS (Command Query Responsibility Segregation) and Event Sourcing**.
Do not assume another reviewer or step has already covered an issue. Detect any problem that belongs to this review perspective.

Inspect the following CQRS+ES-specific concerns only when they exist in the changed contract.

1. search command, query, projection, and process usages and verify that their responsibilities match CQRS+ES boundaries
2. check whether a changed Aggregate stores provenance metadata specific to an input source in its state
3. distinguish an Aggregate-wide invariant from a flow constraint for one input source
4. verify that a new flow does not unnecessarily restrict the existing Aggregate lifecycle
5. check whether Query or Read Model results move Aggregate decisions outside the Aggregate
6. look for multiple commands for one transition, unnecessary projection waits, or input-specific paths that duplicate the normal lifecycle
7. split migration into DB schema, data, event upcaster, Read Model rebuild, and API compatibility, then evaluate only explicitly authorized targets

**Note:** If this project does not use the CQRS+ES pattern, review from a general domain design perspective instead.
{{include:instructions/review-round-scope}}
{{include:instructions/review-investigation-discipline}}
{{include:instructions/review-family-completion}}
{{include:instructions/review-pr-context}}
