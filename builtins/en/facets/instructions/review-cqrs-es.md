Focus on reviewing **CQRS (Command Query Responsibility Segregation) and Event Sourcing**.
Do not assume another reviewer or step has already covered an issue. Detect any problem that belongs to this review perspective.

Determine whether the changed contract and real impact paths contain a CQRS+ES boundary. Only when they do, apply CQRS+ES supporting material classified as `applicable` by the shared procedure to the changed definitions and consumers. When they do not, do not broaden this review perspective into a general domain-design review.

{{include:instructions/review-round-scope}}
{{include:instructions/review-investigation-discipline}}
{{include:instructions/contract-family-review-by-mode}}
{{include:instructions/review-pr-context}}
