import assert from 'node:assert/strict';
import test from 'node:test';

import assertInitialReviewExternalIdentityWiring from './initial-review-external-identity-wiring.mjs';

const completeReview = `
Result: REJECT

| family_tag | contract map |
| --- | --- |
| external-step-target | The authoritative owner is \`docs/configuration.md\`. The workflow fixture \`workflows/sample-flow.json\` supplies workflow name \`sample-flow\` and step name \`execute\`; composing those components yields the canonical \`sample-flow/execute\` identity. The producer \`config/runtime.json\` is read by \`src/target-lookup.js\` and consumed by \`src/execution-target.js\` and \`src/preview-target.js\`, reaches the terminal output, and is covered by \`e2e/external-step.test.js\`. |

The canonical key \`sample-flow/execute\` falls back to \`default-runner\`. The runtime config,
implementation, and E2E test all use the same raw \`execute\` key, so the green test is a
self-consistent false positive. Update the E2E test to assert the canonical
\`sample-flow/execute\` behavior.

The adjacent \`src/local-step-cache.js\` contract is preserved and outside this finding.

| finding_id | family_tag | files |
| --- | --- | --- |
| F-1 | external-step-target | \`docs/configuration.md\`, \`workflows/sample-flow.json\`, \`config/runtime.json\`, \`src/target-lookup.js\`, \`src/execution-target.js\`, \`src/preview-target.js\`, \`e2e/external-step.test.js\` |
`;

test('accepts a complete external identity family and excludes the adjacent contract', () => {
  const result = assertInitialReviewExternalIdentityWiring(completeReview);

  assert.equal(result.pass, true);
  assert.equal(result.score, 1);
});

test('accepts substantive identity tracing without a family table or participates label', () => {
  const review = `
Result: REJECT

The authoritative contract in \`docs/configuration.md\` defines the canonical external key.
\`workflows/sample-flow.json\` supplies \`workflow.name = sample-flow\` and
\`step.name = execute\`; composing those components yields \`sample-flow/execute\`.
\`config/runtime.json\` instead stores the bare \`execute\` key. The lookup in
\`src/target-lookup.js\` queries that same raw step name for both consumers,
\`src/execution-target.js\` and \`src/preview-target.js\`,
so a canonical \`sample-flow/execute\` input falls back to \`default-runner\` at the terminal.
The green \`e2e/external-step.test.js\` is a self-consistent false positive because its
fixture and the implementation share the shortened key. Update that E2E test to require
canonical \`sample-flow/execute\` behavior.

The separate \`src/local-step-cache.js\` contract is preserved and outside this finding.
`;

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, true);
  assert.equal(result.score, 1);
});

test('accepts a documented-value test fix and an adjacent path named without src prefix', () => {
  const review = `
Result: REJECT

The documented key in \`docs/configuration.md\` is \`sample-flow/execute\`. The workflow
fixture supplies \`sample-flow\` and \`execute\`. \`config/runtime.json\` and
\`src/target-lookup.js\` instead share the bare
\`execute\` key, so execution and preview fall back to \`default-runner\`.
The green E2E and implementation use that same wrong short key. Update the runtime
config and E2E to use the documented key.

\`local-step-cache.js\` uses a separate local key and is outside this finding.

| finding_id | files |
| --- | --- |
| F-1 | \`docs/configuration.md\`, \`workflows/sample-flow.json\`, \`config/runtime.json\`, \`src/target-lookup.js\`, \`src/execution-target.js\`, \`src/preview-target.js\`, \`e2e/external-step.test.js\` |
`;

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, true);
  assert.equal(result.score, 1);
});

test('accepts shared wrong-key evidence split across bullets in one finding', () => {
  const review = `
Result: REJECT

## Finding F-1

- \`docs/configuration.md\` and \`workflows/sample-flow.json\` define \`sample-flow/execute\`.
- \`config/runtime.json\` and the lookup in \`src/target-lookup.js\` use bare \`execute\`.
- \`src/execution-target.js\` and \`src/preview-target.js\` therefore fall back to
  \`default-runner\` for execution and preview when the documented key is used.
- The green \`e2e/external-step.test.js\` reads the same bare-key fixture, so it is a false green.
- Update the E2E to use \`sample-flow/execute\` and cover that documented value.

\`local-step-cache.js\` is a separate local-key behavior and is outside this finding.
`;

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, true);
  assert.equal(result.score, 1);
});

test('accepts plain wrong-format wording under a backticked finding ID', () => {
  const review = `
Result: REJECT

### finding_id: \`EXT-KEY-001\`

\`docs/configuration.md\` and \`workflows/sample-flow.json\` define
\`sample-flow/execute\`. \`config/runtime.json\` and \`src/target-lookup.js\`
use \`execute\`, so \`src/execution-target.js\` and \`src/preview-target.js\`
fall back to \`default-runner\` in execution and preview. The green
\`e2e/external-step.test.js\` is not evidence because the config, implementation,
and test share the same wrong key format. Update the E2E to require
\`sample-flow/execute\`.

\`local-step-cache.js\` keeps separate local behavior and is outside this finding.
`;

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, true);
  assert.equal(result.score, 1);
});

test('rejects a review that does not trace both execution and preview consumers', () => {
  const review = completeReview.replaceAll('`src/preview-target.js`', '`src/execution-target.js`');

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, false);
});

test('rejects false-green evidence that names only the documented execute key', () => {
  const review = `
Result: REJECT

The authoritative owner is \`docs/configuration.md\`. The runtime configuration in
\`config/runtime.json\` uses \`stepTargets\` with \`sample-flow/execute\`, and
\`src/target-lookup.js\` resolves that key.
\`src/execution-target.js\` reaches the terminal execution path, and
\`src/preview-target.js\` covers preview. Canonical \`sample-flow/execute\` falls back
to \`default-runner\`. The implementation, config, and green
\`e2e/external-step.test.js\` are self-consistent. Update the E2E test to require
canonical \`sample-flow/execute\` behavior.

The adjacent \`src/local-step-cache.js\` contract is preserved and outside this finding.
`;

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, false);
});

test('rejects false-green evidence when only config uses the bare execute key', () => {
  const review = `
Result: REJECT

The authoritative owner is \`docs/configuration.md\`. The workflow fixture
\`workflows/sample-flow.json\` supplies \`sample-flow\` and \`execute\`, yielding
the canonical \`sample-flow/execute\` identity. \`config/runtime.json\` alone stores
the bare \`execute\` key, while \`src/target-lookup.js\` and the implementation in
\`src/execution-target.js\` and \`src/preview-target.js\` resolve canonical
\`sample-flow/execute\` through the execution and preview terminal paths. The green
\`e2e/external-step.test.js\` is
self-consistent with the canonical implementation. Canonical input still falls back
to \`default-runner\`. Update the E2E test to require canonical
\`sample-flow/execute\` behavior.

The adjacent \`src/local-step-cache.js\` contract is preserved and outside this finding.
`;

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, false);
});

test('rejects a review that turns the adjacent cache contract into a finding', () => {
  const review = completeReview.replace(
    '`e2e/external-step.test.js` |',
    '`e2e/external-step.test.js`, `src/local-step-cache.js` |',
  );

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, false);
  assert.match(result.reason, /adjacent-path-not-a-finding/);
});

test('rejects documented-key evidence distributed across separate findings', () => {
  const review = `
Result: REJECT

## Finding F-1

The authoritative owner is \`docs/configuration.md\`. The runtime configuration in
\`config/runtime.json\` uses \`stepTargets\`, and \`src/execution-target.js\` reaches
the terminal execution path. The canonical key is \`sample-flow/execute\`.

## Finding F-2

\`src/preview-target.js\` covers preview, while \`e2e/external-step.test.js\` is green.
The raw \`step.name\` lookup shared by the config, implementation, and test is a
self-consistent false positive. Canonical input falls back to \`default-runner\`.
Update the E2E test to require canonical \`sample-flow/execute\` behavior.

The adjacent \`src/local-step-cache.js\` contract is preserved and outside these findings.
`;

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, false);
});

test('rejects distributed evidence when finding headings contain only IDs', () => {
  const review = `
Result: REJECT

## EXT-TARGET-001

\`docs/configuration.md\` and \`workflows/sample-flow.json\` define
\`sample-flow/execute\`. \`config/runtime.json\` and \`src/target-lookup.js\`
use bare \`execute\`, so \`src/execution-target.js\` falls back to
\`default-runner\` for execution.

## EXT-TARGET-002

\`src/preview-target.js\` also falls back for preview. The green
\`e2e/external-step.test.js\` reads the same bare-key fixture, so it is a false green.
Update that E2E to cover \`sample-flow/execute\`.

\`local-step-cache.js\` is outside these findings.
`;

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, false);
});

test('rejects a documented-value test request placed in a separate finding', () => {
  const review = `
Result: REJECT

## Finding F-1

\`docs/configuration.md\` and \`workflows/sample-flow.json\` define
\`sample-flow/execute\`. \`config/runtime.json\` and \`src/target-lookup.js\`
use bare \`execute\`, so \`src/execution-target.js\` and \`src/preview-target.js\`
fall back to \`default-runner\` for execution and preview. The green
\`e2e/external-step.test.js\` shares the same bare key with the implementation,
so it is a self-consistent false positive.

## Finding F-2

Update a test to cover the documented \`sample-flow/execute\` value.

\`local-step-cache.js\` is outside these findings.
`;

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, false);
});
