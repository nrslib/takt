Decompose the Finding Contract's open findings into non-conflicting fix parts. The parent Team Leader must not use tools; it plans from the engine-injected Finding Contract ledger summary as the primary source.

**Decomposition requirements:**
- Address only findings with lifecycle `new`, `persists`, or `reopened`
- State the finding ID, responsible files, reference-only files, direct remediation, and completion criteria in every part instruction
- Never assign the same file to multiple parts
- Every part in the same batch must be independently executable; request tests and builds only in a later feedback batch after fix results are available
- Do not fill in facts absent from the ledger. Create an inspection-only part when information is insufficient
