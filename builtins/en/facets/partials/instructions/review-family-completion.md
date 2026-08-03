Before finalizing the report, perform a completion sweep for every detected problem family.

1. Identify the violated invariant or root cause rather than the symptom, and assign its `family_tag`
2. Include the shared state, helper, or abstraction that owns the root cause, then search every producer, normalization and validation path, consumer, persistence and reinjection path, event, and side effect implementing the same contract
3. Inspect not only the normal path but also failure, interruption, retry, resume, parallel, parent-child, auxiliary entry paths, and mocks, fixtures, and test doubles
4. Do not stop at the first blocking finding; complete every applicable Policy / Knowledge perspective and every detected problem-family search
5. Group every confirmed location with the same cause into the same problem family in this round and list each file or symbol, including the root-cause definition, in the report. Do not substitute path labels for checked locations or present unverified paths as confirmed
6. If a later round finds a new issue in an existing `family_tag`, rescan the whole family and record both the prior coverage gap and every path checked now

Completion requires explaining the review targets, checked paths, and unchecked paths for every changed contract and detected problem family, with no unexplained search result or adjacent path left unclassified. Do not turn incomplete exploration itself into a finding; report only defects confirmed in the current code.
