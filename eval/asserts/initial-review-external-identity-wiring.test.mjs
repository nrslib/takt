import assert from 'node:assert/strict';
import test from 'node:test';

import assertInitialReviewExternalIdentityWiring from './initial-review-external-identity-wiring.mjs';

const completeReview = `
Result: REJECT

| family_tag | contract map |
| --- | --- |
| external-step-target | The authoritative owner is \`docs/configuration.md\`. The workflow fixture \`workflows/sample-flow.json\` supplies workflow name \`sample-flow\` and step name \`execute\`; composing those components yields the canonical \`sample-flow/execute\` identity. The producer \`config/runtime.json\` is consumed by the lookup resolvers \`src/execution-target.js\` and \`src/preview-target.js\`, reaches the terminal output, and is covered by \`e2e/external-step.test.js\`. |

The canonical key \`sample-flow/execute\` falls back to \`default-runner\`. The runtime config,
implementation, and E2E test all use the same raw \`execute\` key, so the green test is a
self-consistent false positive. Update the E2E test to assert the canonical
\`sample-flow/execute\` behavior.

The adjacent \`src/local-step-cache.js\` contract is preserved and outside this finding.

| finding_id | family_tag | files |
| --- | --- | --- |
| F-1 | external-step-target | \`docs/configuration.md\`, \`workflows/sample-flow.json\`, \`config/runtime.json\`, \`src/execution-target.js\`, \`src/preview-target.js\`, \`e2e/external-step.test.js\` |
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
\`config/runtime.json\` instead stores the bare \`execute\` key. Both lookup consumers,
\`src/execution-target.js\` and \`src/preview-target.js\`, query that same raw step name,
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

test('rejects a review that does not trace both execution and preview consumers', () => {
  const review = completeReview.replaceAll('`src/preview-target.js`', '`src/execution-target.js`');

  const result = assertInitialReviewExternalIdentityWiring(review);

  assert.equal(result.pass, false);
  assert.match(result.reason, /single-family-complete/);
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

test('rejects canonical identity evidence distributed across separate findings', () => {
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
  assert.match(result.reason, /single-family-complete/);
});
