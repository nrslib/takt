Start by identifying the observable contracts, boundaries, and responsible sources changed by the original requirements, plan, and cumulative diff.

List the types, events, functions, configuration, and shared values in the review target. Trace each definition through its references, actual entry points, consumers, and final results in the code. Finding one problem is not a reason to leave another part of the same change unchecked. Expand the search only when ownership is unclear, a new trust boundary, shared state, or external contract is involved, or evidence disproves an assumption.

When requirements or specifications provide concrete, prohibited, or allowed examples, compare the target's actual names, values, and structure directly with them. Do not skip the comparison because the result appears generally plausible or because another problem was found. Record anything that cannot be confirmed as unchecked.

When changing an identifier supplied through external configuration or an API, or an identifier whose format is documented, build the actual value from a concrete specification example. Check that it keeps the same format from creation through conversion or lookup, use sites, and the final result. A passing test is not proof when fixtures, mocks, test inputs, and implementation merely share the same incorrect format.

- compare observable behavior before and after a replacement or move
- for changes to values, state, types, schemas, resolvers, normalizers, adapters, or shared helpers, trace definitions, references, reachable entries, and consumers
- inspect failure, interruption, retry, concurrency, and auxiliary entries only when those states exist in the changed target or a reachable impact path
