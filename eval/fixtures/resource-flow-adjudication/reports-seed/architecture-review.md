# Architecture review

- FLOW-01: `preview` downloads and materializes the uncapped object before selecting 80 characters. Limit consumption to the requested prefix.
- FLOW-02: `deliver` pulls all blocks into an array before its first write. Deliver incrementally while honoring sink backpressure, preserving the full transfer.
- FLOW-03: `relay` consumes the whole object. Cap the total number of blocks even though this loses part of the export.
- FLOW-04: `summarize` consumes the whole object. Stop after the first block even though this changes the total.
- FLOW-05: `readManifest` materializes all entries. Require pagination regardless of the enforced 16-entry bound.
