Decompose the AI Review findings into non-conflicting fix parts. The parent Team Leader must not use tools; it must plan only from the engine-provided previous response below.

**AI Review response:**
{previous_response}

**Decomposition requirements:**
- State the target files, reference-only files, work to perform, and completion criteria in every part instruction
- Never assign the same file to multiple parts
- Every part in the same batch must be independently executable; request tests and builds only in a later feedback batch after fix results are available
- Include confirmation, direct remediation, and verification of each finding in the member part instructions
- Do not fill in facts absent from the report. Create an inspection-only part when information is insufficient
