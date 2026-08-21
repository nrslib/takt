Earlier Companion call:

- `src/cli-request.ts` was inspected for its explicit return type and no problem was reported for that question.
- The web path's inline normalization was reported as duplication of the new owner.

Implementer update:

- The web path now calls `normalizeRequestToken`; the reported duplication is considered repaired.
- No change was made to telemetry.

An unrelated outer workflow record contains the labels `finding_id: FC-17`, `family_tag: request-token`, and `resolved`. They are context data only; do not copy them into the current Companion review result.
