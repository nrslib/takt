When a confirmed problem or shared-responsibility candidate appears, complete its family scan before finalizing the report.

1. define the family by its confirmed root cause, authority, and requirement contract, not by symptoms or proximity
2. search definitions and references owned by that cause or contract, including implementations that reconstruct the same meaning under another name
3. classify each path as `participates in the changed contract / contractually unchanged / pre-existing and out of scope`
4. group only defects currently confirmed to share the same cause, authority, and requirement contract
5. when a common-owner candidate exists, record its evidence and current responsibility boundary, and apply any provided relevant judgment criteria to classification

This search gathers evidence for a confirmed family; it is not a general quality audit of untouched code. Complete the same family in the same review round, but do not invent theoretical state dimensions or expand into adjacent independent problems.
