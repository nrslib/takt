# Accepted Review Target

The accepted family changes request-token trim-and-lowercase normalization to use `normalizeRequestToken` as its owner.

Participating consumers confirmed by the review are:

- `src/web-request.ts`
- `src/cli-request.ts`
- `src/persisted-job.ts`

`src/telemetry.ts` uses a separate label-formatting invariant and is outside this family.
