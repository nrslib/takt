Focus on reviewing **CQRS (Command Query Responsibility Segregation) and Event Sourcing**.
Do not assume another reviewer or step has already covered an issue. Detect any problem that belongs to this review perspective.

Procedure:
1. Open the Knowledge and Policy Source paths with the Read tool and obtain the full content
2. List every `##` section in each of them (do not cherry-pick)
3. Match the criteria in each listed section against the diff and detect any issues
4. For changed Aggregates, check whether origin metadata such as `source` / `input` / `origin` / `channel` / `type` / `kind` is restored into state
5. If origin metadata is used in `if` / `require`, decide whether that validation is an invariant of the whole Aggregate or only a flow constraint for one input source
6. When a new flow is integrated into an existing Aggregate, verify that states allowed by the existing normal lifecycle are not prohibited only for the new flow

**Note:** If this project does not use the CQRS+ES pattern, review from a general domain design perspective instead.
