Adjudicate these Companion candidates using only the supplied evidence. Do not perform a new scan.

Task contract: move request-token trim-and-lowercase normalization to `normalizeRequestToken` and migrate all current consumers of that invariant. Telemetry label formatting is unchanged and outside this family.

- C-01 (`must_fix`, `src/cli-request.ts:2`): `cliToken` still executes `raw.trim().toLowerCase()` after the shared owner was added. The supplied diff shows the exact line.
- C-02 (`should_fix`, `src/cli-request.ts:2`): the CLI consumer duplicates the new owner's trim-and-lowercase invariant. The supplied diff shows the same exact line as C-01.
- C-03 (`must_fix`, `src/telemetry.ts:2`): telemetry labels still replace spaces with underscores and should use the request-token helper. The task explicitly leaves telemetry formatting unchanged.
- C-04 (`must_fix`, `src/mobile-request.ts:1`): a mobile consumer probably duplicates normalization. No mobile file, diff, or other evidence was supplied.

Return exactly one `accept` or `reject` decision for every submitted candidate, using its zero-based position in this list as `sourceIndex` (`0` through `3`). Emit no unmatched item and no fields outside the supplied output schema.
