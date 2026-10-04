import assert from 'node:assert/strict';
import test from 'node:test';

import assertArchitectureSearch, {
  hasSharedBoundaryFamily,
  parseScopeTelemetry,
} from './scope-architecture-search.mjs';

function outputWithTelemetry(telemetry, prose = '') {
  return `${prose}\n<scope-eval>\n${JSON.stringify(telemetry)}\n</scope-eval>`;
}

function validTelemetry() {
  return {
    boundaryFamilies: [{
      members: ['src/report-path.ts', 'src/attachment-path.ts'],
      sameObservedFailure: true,
      sharedOwnerCandidate: true,
      behaviorEvidence: ['test/attachment-path.test.ts'],
    }],
    findingPaths: ['src/report-path.ts', 'src/attachment-path.ts'],
    structureProxyFindings: false,
  };
}

test('accepts two implementations tied to one observed boundary family', () => {
  const output = outputWithTelemetry(validTelemetry());

  assert.equal(hasSharedBoundaryFamily(parseScopeTelemetry(output)), true);
  assert.equal(assertArchitectureSearch(output).pass, true);
});

test('does not infer a relationship from unrelated natural-language claims', () => {
  const telemetry = validTelemetry();
  telemetry.boundaryFamilies = [
    { ...telemetry.boundaryFamilies[0], members: ['src/report-path.ts'] },
    { ...telemetry.boundaryFamilies[0], members: ['src/attachment-path.ts'] },
  ];
  const prose = 'The first path is unsafe. The second path shares a resolver with another component.';

  assert.equal(assertArchitectureSearch(outputWithTelemetry(telemetry, prose)).pass, false);
});

test('rejects a family without a common owner direction', () => {
  const telemetry = validTelemetry();
  telemetry.boundaryFamilies[0].sharedOwnerCandidate = false;

  assert.equal(assertArchitectureSearch(outputWithTelemetry(telemetry)).pass, false);
});

test('rejects an unrelated path promoted to a finding', () => {
  const telemetry = validTelemetry();
  telemetry.findingPaths.push('src/legacy-counter.ts');

  assert.equal(assertArchitectureSearch(outputWithTelemetry(telemetry)).pass, false);
});

test('rejects prefixed paths instead of accepting suffix matches', () => {
  const cases = [
    {
      mutate: (telemetry) => { telemetry.boundaryFamilies[0].members[0] = 'other/src/report-path.ts'; },
      expectedCheck: 'shared-boundary-family',
    },
    {
      mutate: (telemetry) => { telemetry.boundaryFamilies[0].behaviorEvidence[0] = 'other/test/attachment-path.test.ts'; },
      expectedCheck: 'shared-boundary-family',
    },
    {
      mutate: (telemetry) => { telemetry.findingPaths[1] = 'other/src/attachment-path.ts'; },
      expectedCheck: 'same-family-finding',
    },
  ];

  assert.equal(assertArchitectureSearch(outputWithTelemetry(validTelemetry())).pass, true);

  for (const { mutate, expectedCheck } of cases) {
    const telemetry = validTelemetry();
    mutate(telemetry);
    const result = assertArchitectureSearch(outputWithTelemetry(telemetry));
    assert.equal(result.pass, false);
    assert.equal(result.reason.includes(expectedCheck), true);
  }
});

test('uses structured classifications instead of positive or negative wording', () => {
  const positive = outputWithTelemetry(
    validTelemetry(),
    'attachmentDestination is not out of scope. No unrelated implementation is included.',
  );
  const negativeTelemetry = validTelemetry();
  negativeTelemetry.boundaryFamilies[0].sameObservedFailure = false;
  const negative = outputWithTelemetry(
    negativeTelemetry,
    'Both paths definitely share the same boundary and owner.',
  );

  assert.equal(assertArchitectureSearch(positive).pass, true);
  assert.equal(assertArchitectureSearch(negative).pass, false);
});

test('rejects missing, malformed, or duplicate telemetry', () => {
  const telemetry = validTelemetry();

  assert.equal(assertArchitectureSearch('review only').pass, false);
  assert.equal(assertArchitectureSearch('<scope-eval>{</scope-eval>').pass, false);
  assert.equal(assertArchitectureSearch(
    `${outputWithTelemetry(telemetry)}\n${outputWithTelemetry(telemetry)}`,
  ).pass, false);
});
