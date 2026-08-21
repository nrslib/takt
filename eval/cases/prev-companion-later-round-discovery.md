Earlier Companion call:

- `src/cli-request.ts` was inspected for its explicit return type and no problem was reported for that question.
- The web path's inline normalization was reported as duplication of the new owner.

Implementer update:

- The web path now calls `normalizeRequestToken`; the reported duplication is considered repaired.
- No change was made to telemetry.

An outer workflow record refers to `finding_id: FC-17`, `family_tag: request-token`, and a `resolved` disposition. Those workflow lifecycle labels are not Companion review-item state.
