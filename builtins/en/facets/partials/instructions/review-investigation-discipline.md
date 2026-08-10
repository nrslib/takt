Start by identifying the observable contracts, boundaries, and responsibility owners changed by the original requirements, plan, and cumulative diff.

Use only the judgment criteria and supporting material classified as applicable by the shared full-reading procedure when investigating the changed contracts, boundaries, and real impact paths. Expand code exploration when ownership is unclear, a new trust boundary, shared state, or external contract is involved, or evidence disproves an assumption. When no criteria or supporting material is provided, still complete the investigation from the original requirements, current code, and observable contracts.

The diff is the starting point for reading, not an absolute ceiling. When needed to judge the changed contract, identify its owner, or find implementations with the same meaning, expand semantic search across the repository. Do not pre-limit investigation size; choose the relevant investigation for each applicable criterion:

- compare observable behavior before and after a replacement or move
- for changes to values, state, types, schemas, resolvers, normalizers, adapters, or shared helpers, trace definitions, references, reachable entries, and consumers
- when a new shared responsibility or abstraction candidate appears, search for existing implementations with the same meaning, contract, and reason to change
- inspect failure, interruption, retry, concurrency, and auxiliary entries only when those state dimensions exist in the changed contract or a reachable impact path

Classify discovered paths as `participates in the changed contract / contractually unchanged / pre-existing and out of scope`. Reading broadly does not grant authority to report or edit broadly. Base finding scope on the original requirements, observable contracts, and current code, applying any provided relevant judgment criteria.
