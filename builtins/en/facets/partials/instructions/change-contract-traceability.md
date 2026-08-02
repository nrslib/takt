**Change contract traceability (required for implementation tasks):**
- Derive observable completion obligations from explicit requirements and existing behavior that must be preserved. Give each independently verifiable contract family a stable contract ID; do not assign IDs to files, implementation steps, or individual field edits
- Preserve each contract ID and its meaning across planning, testing, and implementation. When later investigation discovers a new completion obligation, add a new ID instead of silently changing the meaning of an existing ID
- Map each contract ID to valid behavior, a plausible incorrect implementation, and completion evidence that directly observes the contract. A broad suite pass alone is not evidence for an individual contract

**Impact-path tracing (only for applicable contracts):**
- When a changed value or state crosses multiple boundaries, entry points, or consumers, trace the existing path through definition/input, normalization, production, persistence/transport, restoration, and consumption/output as applicable. Include public and auxiliary entry points and existing branches with the same responsibility
- For relevant state, identity, authorization, persisted formats, events, shared resources, retries, resume behavior, or concurrency, define invariants for success, relevant failure exits, re-entry, and interleaving. Do not add stages or state axes that do not apply
- Keep identity data, authorization evidence, and state ownership distinct; make shared-value mutability, snapshot boundaries, and start/terminal pairing explicit
- When changing public or persisted formats, choose preservation, migration, or a breaking change from the source of truth. Do not add unsupported compatibility handling or compatibility breaks
