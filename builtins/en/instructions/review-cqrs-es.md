Review the changes from the perspective of CQRS (Command Query Responsibility Segregation) and Event Sourcing.
AI-specific issue review is not needed (already covered by the ai_review movement).

**Review criteria:**
- Aggregate design validity
- Event design (granularity, naming, schema)
- Command/Query separation
- Projection design
- Eventual consistency considerations

**Note**: If this project does not use the CQRS+ES pattern,
review from a general domain design perspective instead.

## Judgment Procedure

1. Review the change diff and detect issues based on the CQRS and Event Sourcing criteria above
2. For each detected issue, classify as blocking/non-blocking based on Policy's scope determination table and judgment rules
3. If there is even one blocking issue, judge as REJECT
