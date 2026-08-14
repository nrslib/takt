Start by identifying the observable contracts, boundaries, and responsibility owners changed by the original requirements, plan, and cumulative diff.

Use only the judgment criteria and supporting material classified as applicable by the shared full-reading procedure when investigating the changed contracts, boundaries, and real impact paths. Expand code exploration when ownership is unclear, a new trust boundary, shared state, or external contract is involved, or evidence disproves an assumption. When no criteria or supporting material is provided, still complete the investigation from the original requirements, current code, and observable contracts.

The diff is the starting point for reading, not an absolute ceiling. Inspect the code and evidence needed to apply each relevant criterion. Follow the active role procedure and review authority policy for investigation scope and finding authority:

When changing an identifier supplied through external configuration or an API, or an identifier whose format is documented, build the actual value from a concrete example in the specification. Check that the value keeps the same format from where it is created through conversion or lookup, use sites, and the final result. When fixtures, mocks, or test inputs hold parts of the value in separate fields, build the value as specified and compare it with the implementation. A passing test does not prove correct behavior when the fixture and implementation merely use the same wrong format. When the implementation and test share the same mistake, explain them in one finding instead of splitting them into separate problems.

- compare observable behavior before and after a replacement or move
- for changes to values, state, types, schemas, resolvers, normalizers, adapters, or shared helpers, trace definitions, references, reachable entries, and consumers
- inspect failure, interruption, retry, concurrency, and auxiliary entries only when those state dimensions exist in the changed contract or a reachable impact path
