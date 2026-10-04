# Fix Plan

## Result: finalized

## Family CF-01: request-token normalization

- Owner: `normalizeRequestToken` in `src/token-normalization.ts`
- Participating consumers: `src/web-request.ts`, `src/cli-request.ts`
- Completion: both listed consumers call the owner; direct trim-and-lowercase reconstruction is removed from those paths
- Preservation: telemetry-label formatting remains unchanged
