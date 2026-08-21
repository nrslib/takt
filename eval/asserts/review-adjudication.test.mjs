import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertReviewAdjudicationPhase1,
  assertSeparatedTypeErrorFamily,
  assertTypeErrorOverreach,
  hasBasisPartitionedFamily,
  hasNoLegacyAliasEvidence,
  isExactAuthorizationBasis,
} from './review-adjudication.mjs';

const EXPECTED = 'direct_acceptance_criterion_violation';

test('accepts only the case-specific initial-review authorization basis', () => {
  assert.equal(isExactAuthorizationBasis(EXPECTED, EXPECTED), true);
});

for (const [name, value] of [
  ['another allowed machine value', 'accepted_family_unvisited_consumer'],
  ['a prose alias', 'direct acceptance criterion violation'],
  ['combined machine values', `${EXPECTED} / required_consumer_migration`],
]) {
  test(`rejects ${name}`, () => {
    assert.equal(isExactAuthorizationBasis(value, EXPECTED), false);
  });
}

const PARTITIONED_FAMILY = [
  '| family | Finding ID / source | Authorization basis |',
  '|---|---|---|',
  '| channel-normalization | CODE-NEW-channel-normalization-L2, ARCH-NEW-channel-normalization-L2 | direct_acceptance_criterion_violation |',
  '| channel-normalization | CODE-NEW-worker-channel-retention-L2 | remediation_regression |',
].join('\n');
const EXPECTED_FINDING_BASES = {
  'CODE-NEW-channel-normalization-L2': 'direct_acceptance_criterion_violation',
  'ARCH-NEW-channel-normalization-L2': 'direct_acceptance_criterion_violation',
  'CODE-NEW-worker-channel-retention-L2': 'remediation_regression',
};

test('accepts one family identity partitioned into one row per finding basis', () => {
  assert.equal(hasBasisPartitionedFamily(PARTITIONED_FAMILY, EXPECTED_FINDING_BASES), true);
});

test('rejects mixed bases collapsed into one family row', () => {
  const collapsed = PARTITIONED_FAMILY.replace(
    '| channel-normalization | CODE-NEW-channel-normalization-L2, ARCH-NEW-channel-normalization-L2 | direct_acceptance_criterion_violation |\n| channel-normalization | CODE-NEW-worker-channel-retention-L2 | remediation_regression |',
    '| channel-normalization | CODE-NEW-channel-normalization-L2, ARCH-NEW-channel-normalization-L2, CODE-NEW-worker-channel-retention-L2 | direct_acceptance_criterion_violation / remediation_regression |',
  );
  assert.equal(hasBasisPartitionedFamily(collapsed, EXPECTED_FINDING_BASES), false);
});

test('rejects splitting one contract family identity by basis', () => {
  const split = PARTITIONED_FAMILY.replace(
    '| channel-normalization | CODE-NEW-worker-channel-retention-L2 | remediation_regression |',
    '| worker-channel-normalization | CODE-NEW-worker-channel-retention-L2 | remediation_regression |',
  );
  assert.equal(hasBasisPartitionedFamily(split, EXPECTED_FINDING_BASES), false);
});

test('initial adjudication seeds explicitly carry not-applicable authorization fields', () => {
  for (const report of [
    'coding-review.md',
    'architect-review.md',
    'security-review.md',
    'testing-review.md',
    'ai-antipattern-review.md',
  ]) {
    const content = readFileSync(new URL(
      `../fixtures/review-adjudication/reports-seed/subworkflows/iteration-1--step-initial-reviewers--review-suite/${report}`,
      import.meta.url,
    ), 'utf8');
    assert.match(content, /Authorization basis/i);
    assert.match(content, /(?:not applicable|該当なし)/i);
  }
});

const SEPARATED_TYPE_ERROR = [
  '## Actionable Families',
  '| family | Finding ID / source | Authorization basis |',
  '|---|---|---|',
  '| FAM-channel-normalization | CODE-NEW-channel-normalization-L2 | direct_acceptance_criterion_violation |',
  '| FAM-channel-input-error | ARCH-NEW-channel-type-error-L2 | direct_acceptance_criterion_violation |',
  '',
  '## Finding Dispositions',
  '| Finding ID / source | Disposition | Target family | Authorization basis |',
  '|---|---|---|---|',
  '| ARCH-NEW-channel-type-error-L2 | actionable | FAM-channel-input-error | direct_acceptance_criterion_violation |',
].join('\n');

test('requires an initial N/A finding to become a direct-basis separate family', () => {
  assert.equal(assertSeparatedTypeErrorFamily(SEPARATED_TYPE_ERROR).pass, true);
});

test('rejects an omitted initial finding disposition', () => {
  const omitted = SEPARATED_TYPE_ERROR.replace(
    '| ARCH-NEW-channel-type-error-L2 | actionable | FAM-channel-input-error | direct_acceptance_criterion_violation |',
    '',
  );
  assert.equal(assertSeparatedTypeErrorFamily(omitted).pass, false);
});

test('rejects retaining N/A as the authorization basis during adjudication', () => {
  const retained = SEPARATED_TYPE_ERROR.replaceAll(
    'direct_acceptance_criterion_violation |',
    'not applicable |',
  );
  assert.equal(assertSeparatedTypeErrorFamily(retained).pass, false);
});

const TYPE_ERROR_OVERREACH = [
  '## Actionable Families',
  '| family | Finding ID / source | Authorization basis |',
  '|---|---|---|',
  '| FAM-channel-normalization | CODE-NEW-channel-normalization-L2 | direct_acceptance_criterion_violation |',
  '',
  '## Finding Dispositions',
  '| Finding ID / source | Disposition | Target family | Authorization basis |',
  '|---|---|---|---|',
  '| ARCH-NEW-channel-type-error-L2 | overreach | none | none |',
].join('\n');

test('accepts a stronger type-error contract kept outside remediation authority', () => {
  assert.equal(assertTypeErrorOverreach(TYPE_ERROR_OVERREACH).pass, true);
});

test('rejects assigning a family to an overreach type-error finding', () => {
  const assigned = TYPE_ERROR_OVERREACH.replace('| overreach | none | none |', '| overreach | FAM-channel-normalization | none |');
  assert.equal(assertTypeErrorOverreach(assigned).pass, false);
});

test('rejects contradictory disposition values in one table cell', () => {
  const contradictory = TYPE_ERROR_OVERREACH.replace(
    '| overreach | none | none |',
    '| overreach / actionable | none | none |',
  );
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

test('rejects a table disposition contradicted by narrative text', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\nARCH-NEW-channel-type-error-L2 is actionable in FAM-channel-normalization.`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

test('rejects a narrative contradiction written before the finding ID', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\nactionable: ARCH-NEW-channel-type-error-L2.`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

test('rejects multiple narrative dispositions assigned to one finding', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\nARCH-NEW-channel-type-error-L2 is overreach / actionable.`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

test('accepts a summary line that lists different dispositions for different findings', () => {
  const summarized = `${TYPE_ERROR_OVERREACH}\n\n非修正対象は2件（\`ARCH-NEW-channel-type-error-L2\` overreach、\`CODE-NEW-channel-normalization-L2\` actionable）。`;
  assert.equal(assertTypeErrorOverreach(summarized).pass, true);
});

test('accepts a summary line whose dispositions precede their finding IDs', () => {
  const summarized = `${TYPE_ERROR_OVERREACH}\n\n非修正対象は2件（overreach: ARCH-NEW-channel-type-error-L2、actionable: CODE-NEW-channel-normalization-L2）。`;
  assert.equal(assertTypeErrorOverreach(summarized).pass, true);
});

test('accepts a respectively summary that aligns findings and dispositions by order', () => {
  const summarized = `${TYPE_ERROR_OVERREACH}\n\nCODE-NEW-channel-normalization-L2 and ARCH-NEW-channel-type-error-L2 are actionable and overreach, respectively.`;
  assert.equal(assertTypeErrorOverreach(summarized).pass, true);
});

test('rejects a respectively summary that assigns a contradictory disposition', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\nARCH-NEW-channel-type-error-L2 and CODE-NEW-channel-normalization-L2 are actionable and actionable, respectively.`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

test('accepts a Japanese respectively summary aligned by order', () => {
  const summarized = `${TYPE_ERROR_OVERREACH}\n\nCODE-NEW-channel-normalization-L2 と ARCH-NEW-channel-type-error-L2 は、それぞれ actionable と overreach です。`;
  assert.equal(assertTypeErrorOverreach(summarized).pass, true);
});

test('accepts an ASCII-comma summary with one disposition per finding', () => {
  const summarized = `${TYPE_ERROR_OVERREACH}\n\nactionable: CODE-NEW-channel-normalization-L2, overreach: ARCH-NEW-channel-type-error-L2.`;
  assert.equal(assertTypeErrorOverreach(summarized).pass, true);
});

test('rejects two comma-separated dispositions assigned to one finding', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\nARCH-NEW-channel-type-error-L2 is overreach, actionable.`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

test('rejects a formatted bare disposition assigned after a comma', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\nARCH-NEW-channel-type-error-L2 is overreach, but \`actionable\`.`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

test('rejects a contradictory disposition in a heading', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\n### ARCH-NEW-channel-type-error-L2 is actionable`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

test('rejects a contradictory disposition in the body of a finding heading', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\n### ARCH-NEW-channel-type-error-L2\n\nDisposition: actionable.`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

test('rejects a second disposition in the body of a completed finding heading', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\n### ARCH-NEW-channel-type-error-L2 — overreach\n\nDisposition: actionable.`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

test('rejects a contradictory disposition in a nested finding list', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\n- ARCH-NEW-channel-type-error-L2:\n  - Disposition: actionable.`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

test('rejects a second disposition after a completed parent list item', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\n- ARCH-NEW-channel-type-error-L2: overreach\n\n  Disposition: actionable.`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

for (const differentFindingId of [
  'ARCH-NEW-channel-type-error-L2-followup',
  'XARCH-NEW-channel-type-error-L2',
]) {
  test(`does not treat a different finding as the target: ${differentFindingId}`, () => {
    const summarized = `${TYPE_ERROR_OVERREACH}\n\n${differentFindingId} is actionable.`;
    assert.equal(assertTypeErrorOverreach(summarized).pass, true);
  });
}

test('accepts a polite Japanese negation of a contradictory disposition', () => {
  const summarized = `${TYPE_ERROR_OVERREACH}\n\nARCH-NEW-channel-type-error-L2 は actionable ではありません。`;
  assert.equal(assertTypeErrorOverreach(summarized).pass, true);
});

for (const contradictorySummary of [
  'Other findings are overreach; ARCH-NEW-channel-type-error-L2 is actionable.',
  '他の finding は overreach、ARCH-NEW-channel-type-error-L2 は actionable。',
  'ARCH-NEW-channel-type-error-L2 is actionable; overreach applies elsewhere.',
]) {
  test(`does not mask a target disposition across a clause boundary: ${contradictorySummary}`, () => {
    assert.equal(
      assertTypeErrorOverreach(`${TYPE_ERROR_OVERREACH}\n\n${contradictorySummary}`).pass,
      false,
    );
  });
}

for (const continuation of [
  'This finding is actionable.',
  'That finding is actionable.',
  'この finding は actionable。',
]) {
  test(`assigns a finding anaphor to the preceding finding: ${continuation}`, () => {
    const contradictory = `${TYPE_ERROR_OVERREACH}\n\nARCH-NEW-channel-type-error-L2 is overreach. ${continuation}`;
    assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
  });
}

test('accepts non-actionable as a broad summary of an overreach disposition', () => {
  const summarized = `${TYPE_ERROR_OVERREACH}\n\nARCH-NEW-channel-type-error-L2 is non-actionable (overreach).`;
  assert.equal(assertTypeErrorOverreach(summarized).pass, true);
});

for (const contradiction of [
  'ARCH-NEW-channel-type-error-L2 is not overreach.',
  'ARCH-NEW-channel-type-error-L2 is not `overreach`.',
  'ARCH-NEW-channel-type-error-L2 is not **overreach**.',
  "ARCH-NEW-channel-type-error-L2 isn't overreach.",
  "ARCH-NEW-channel-type-error-L2 isn't `overreach`.",
  'ARCH-NEW-channel-type-error-L2 isn’t overreach.',
  'ARCH-NEW-channel-type-error-L2 isn’t `overreach`.',
  'ARCH-NEW-channel-type-error-L2 は overreach ではありません。',
]) {
  test(`rejects a direct negation of the table disposition: ${contradiction}`, () => {
    assert.equal(assertTypeErrorOverreach(`${TYPE_ERROR_OVERREACH}\n\n${contradiction}`).pass, false);
  });
}

for (const contradictorySummary of [
  'ARCH-NEW-channel-type-error-L2 is actionable although overreach applies elsewhere.',
  '他の finding は overreach ですが ARCH-NEW-channel-type-error-L2 は actionable。',
]) {
  test(`keeps a target disposition across an unpunctuated contrast: ${contradictorySummary}`, () => {
    assert.equal(
      assertTypeErrorOverreach(`${TYPE_ERROR_OVERREACH}\n\n${contradictorySummary}`).pass,
      false,
    );
  });
}

for (const summary of [
  'All other findings are actionable; ARCH-NEW-channel-type-error-L2 is overreach.',
  'Other findings remain actionable. ARCH-NEW-channel-type-error-L2 remains overreach.',
  'actionable applies elsewhere; ARCH-NEW-channel-type-error-L2 is overreach.',
  'ARCH-NEW-channel-type-error-L2 remains overreach while actionable applies elsewhere.',
  'ARCH-NEW-channel-type-error-L2 remains overreach while actionable applies to other findings.',
  'ARCH-NEW-channel-type-error-L2 remains overreach while actionable applies to the other findings.',
  'ARCH-NEW-channel-type-error-L2 remains overreach while actionable applies to all other findings.',
]) {
  test(`does not assign an unrelated disposition to the target: ${summary}`, () => {
    assert.equal(assertTypeErrorOverreach(`${TYPE_ERROR_OVERREACH}\n\n${summary}`).pass, true);
  });
}

test('assigns a bare disposition to the preceding finding-only clause', () => {
  const contradictory = `${TYPE_ERROR_OVERREACH}\n\nARCH-NEW-channel-type-error-L2 is discussed below. Disposition: actionable. CODE-NEW-channel-normalization-L2 is actionable.`;
  assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
});

for (const continuation of [
  'The disposition is actionable.',
  'It is also actionable.',
  '裁定は actionable。',
  'but the disposition is actionable.',
]) {
  test(`assigns an anaphoric disposition to the preceding finding: ${continuation}`, () => {
    const contradictory = `${TYPE_ERROR_OVERREACH}\n\nARCH-NEW-channel-type-error-L2 is overreach. ${continuation}`;
    assert.equal(assertTypeErrorOverreach(contradictory).pass, false);
  });
}

const PHASE1_FIXTURE = readFileSync(
  new URL('../cases/review-adjudication-phase1.md', import.meta.url),
  'utf8',
);
const ACTIONABLE_RESULT = '裁定結果は「修正対象あり」。';
const CODE_DISPOSITION = '`CODE-NEW-channel-normalization-L2` は `direct_acceptance_criterion_violation` を根拠とする `actionable`';
const ARCHITECTURE_DISPOSITION = '`ARCH-NEW-channel-normalization-L2` は同じ根拠 `direct_acceptance_criterion_violation` を持つ `duplicate`';
const REMEDIATION_DISPOSITION = '`CODE-NEW-worker-channel-retention-L2` は同じ family に属し、`remediation_regression` を根拠とする `actionable`';

test('accepts the canonical Phase 1 semantic result without a Phase 2 table', () => {
  assert.equal(assertReviewAdjudicationPhase1(PHASE1_FIXTURE).pass, true);
});

test('accepts an explicit nonzero actionable-family result', () => {
  const familyCountResult = PHASE1_FIXTURE.replace(
    ACTIONABLE_RESULT,
    '修正対象は1 familyです。',
  );
  assert.equal(assertReviewAdjudicationPhase1(familyCountResult).pass, true);
});

for (const resultLine of [
  'The adjudication result is NO ACTIONABLE FINDINGS.',
  'The adjudication result is NOT ACTIONABLE FINDINGS.',
  '結果: 修正対象なし',
]) {
  test(`rejects a negated actionable result: ${resultLine}`, () => {
    const output = PHASE1_FIXTURE.replace(
      ACTIONABLE_RESULT,
      resultLine,
    );
    const result = assertReviewAdjudicationPhase1(output);
    assert.equal(result.pass, false);
    assert.equal(result.reason.includes('actionable-result'), true);
  });
}

test('rejects actionable and non-actionable result lines in one Phase 1 response', () => {
  const output = PHASE1_FIXTURE.replace(
    ACTIONABLE_RESULT,
    '裁定結果は「修正対象なし」。\n裁定結果は「修正対象あり」。',
  );
  const result = assertReviewAdjudicationPhase1(output);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('actionable-result'), true);
});

test('rejects contradictory narrative dispositions for one Phase 1 finding', () => {
  const output = PHASE1_FIXTURE.replace(
    CODE_DISPOSITION,
    '`CODE-NEW-channel-normalization-L2` は `direct_acceptance_criterion_violation` を根拠とする `overreach` / `actionable`',
  );
  const result = assertReviewAdjudicationPhase1(output);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('initial-pair-direct-bases'), true);
});

test('rejects a non-actionable table disposition contradicted by Phase 1 narrative', () => {
  const output = `${PHASE1_FIXTURE}

## Finding Dispositions
| Finding ID | Disposition | Target family | Authorization basis |
|---|---|---|---|
| TEST-NEW-readme-examples-L1 | overreach | none | none |

TEST-NEW-readme-examples-L1 is out_of_scope.`;
  const result = assertReviewAdjudicationPhase1(output);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('testing-non-actionable'), true);
});

test('rejects an actionable table disposition contradicted by Phase 1 narrative', () => {
  const output = `${PHASE1_FIXTURE}

## Finding Dispositions
| Finding ID | Disposition | Target family | Authorization basis |
|---|---|---|---|
| CODE-NEW-worker-channel-retention-L2 | actionable | FAM-channel-normalization | remediation_regression |

CODE-NEW-worker-channel-retention-L2 is duplicate.`;
  const result = assertReviewAdjudicationPhase1(output);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('remediation-regression'), true);
});

test('rejects non-actionable as a contradiction of an actionable table disposition', () => {
  const output = `${PHASE1_FIXTURE}

## Finding Dispositions
| Finding ID | Disposition | Target family | Authorization basis |
|---|---|---|---|
| CODE-NEW-channel-normalization-L2 | actionable | FAM-channel-normalization | direct_acceptance_criterion_violation |

CODE-NEW-channel-normalization-L2 is non-actionable.`;
  const result = assertReviewAdjudicationPhase1(output);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('initial-pair-direct-bases'), true);
});

for (const contradiction of [
  'CODE-NEW-channel-normalization-L2 is not actionable.',
  'CODE-NEW-channel-normalization-L2 is not `actionable`.',
  'CODE-NEW-channel-normalization-L2 は actionable ではありません。',
]) {
  test(`rejects a direct negation of an actionable table disposition: ${contradiction}`, () => {
    const output = `${PHASE1_FIXTURE}

## Finding Dispositions
| Finding ID | Disposition | Target family | Authorization basis |
|---|---|---|---|
| CODE-NEW-channel-normalization-L2 | actionable | FAM-channel-normalization | direct_acceptance_criterion_violation |

${contradiction}`;
    const result = assertReviewAdjudicationPhase1(output);
    assert.equal(result.pass, false);
    assert.equal(result.reason.includes('initial-pair-direct-bases'), true);
  });
}

for (const consistentSummary of [
  'CODE-NEW-channel-normalization-L2 is actionable, not overreach.',
  'CODE-NEW-channel-normalization-L2 は actionable であり、overreach ではありません。',
]) {
  test(`accepts a negation of a different disposition: ${consistentSummary}`, () => {
    const output = `${PHASE1_FIXTURE}

## Finding Dispositions
| Finding ID | Disposition | Target family | Authorization basis |
|---|---|---|---|
| CODE-NEW-channel-normalization-L2 | actionable | FAM-channel-normalization | direct_acceptance_criterion_violation |

${consistentSummary}`;
    assert.equal(assertReviewAdjudicationPhase1(output).pass, true);
  });
}

test('rejects a non-actionable table disposition contradicted on the following line', () => {
  const output = `${PHASE1_FIXTURE}

## Finding Dispositions
| Finding ID | Disposition | Target family | Authorization basis |
|---|---|---|---|
| TEST-NEW-readme-examples-L1 | overreach | none | none |

TEST-NEW-readme-examples-L1:
Disposition: out_of_scope.`;
  const result = assertReviewAdjudicationPhase1(output);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('testing-non-actionable'), true);
});

test('rejects an actionable table disposition contradicted on the following line', () => {
  const output = `${PHASE1_FIXTURE}

## Finding Dispositions
| Finding ID | Disposition | Target family | Authorization basis | Evidence |
|---|---|---|---|---|
| CODE-NEW-worker-channel-retention-L2 | actionable | FAM-channel-normalization | remediation_regression | introduced after initial round |

CODE-NEW-worker-channel-retention-L2:
Disposition: duplicate.`;
  const result = assertReviewAdjudicationPhase1(output);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('remediation-regression'), true);
});

test('rejects retaining N/A for a confirmed initial finding in Phase 1', () => {
  const retained = PHASE1_FIXTURE.replace(
    CODE_DISPOSITION,
    '`CODE-NEW-channel-normalization-L2` は `not applicable` を根拠とする `actionable`',
  );
  const result = assertReviewAdjudicationPhase1(retained);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('initial-pair-direct-bases'), true);
});

test('rejects retaining N/A beside the expected Phase 1 authorization basis', () => {
  const retained = PHASE1_FIXTURE.replace(
    CODE_DISPOSITION,
    '`CODE-NEW-channel-normalization-L2` は `direct_acceptance_criterion_violation` と `not applicable` を根拠とする `actionable`',
  );
  const result = assertReviewAdjudicationPhase1(retained);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('initial-pair-direct-bases'), true);
});

test('rejects another machine basis beside the expected Phase 1 authorization basis', () => {
  const combined = PHASE1_FIXTURE.replace(
    CODE_DISPOSITION,
    '`CODE-NEW-channel-normalization-L2` は `direct_acceptance_criterion_violation` と `required_consumer_migration` を根拠とする `actionable`',
  );
  const result = assertReviewAdjudicationPhase1(combined);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('initial-pair-direct-bases'), true);
});

test('rejects a disposition and authorization basis split across duplicate finding lines', () => {
  const split = PHASE1_FIXTURE.replace(
    CODE_DISPOSITION,
    '`CODE-NEW-channel-normalization-L2` は `actionable`。\n- `CODE-NEW-channel-normalization-L2` の根拠は `direct_acceptance_criterion_violation`',
  );
  const result = assertReviewAdjudicationPhase1(split);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('initial-pair-direct-bases'), true);
});

test('does not read Japanese word fragments as a not-applicable machine value', () => {
  const prose = PHASE1_FIXTURE.replace(
    `${CODE_DISPOSITION}。`,
    `${CODE_DISPOSITION}。同一 finding とみなします。`,
  );
  assert.equal(assertReviewAdjudicationPhase1(prose).pass, true);
});

test('does not read a same-line reason-absent N/A as the authorization basis', () => {
  const prose = PHASE1_FIXTURE.replace(
    `${CODE_DISPOSITION}。`,
    `${CODE_DISPOSITION}；初回に含まれなかった理由は \`not applicable\`。`,
  );
  assert.equal(assertReviewAdjudicationPhase1(prose).pass, true);
});

test('accepts an authorization basis after a pipe-delimited reason-absent field', () => {
  const reordered = PHASE1_FIXTURE.replace(
    `${CODE_DISPOSITION}。`,
    '`CODE-NEW-channel-normalization-L2` は `actionable`；初回に含まれなかった理由は `not applicable` | Authorization Basis は `direct_acceptance_criterion_violation`。',
  );
  assert.equal(assertReviewAdjudicationPhase1(reordered).pass, true);
});

test('accepts a disposition table whose reason-absent N/A follows the authorization basis', () => {
  const withoutNarrativeDispositions = PHASE1_FIXTURE
    .split('\n')
    .filter((line) => ![
      'CODE-NEW-channel-normalization-L2',
      'ARCH-NEW-channel-normalization-L2',
      'CODE-NEW-worker-channel-retention-L2',
    ].some((findingId) => line.includes(findingId)))
    .join('\n');
  const table = [
    '## Finding Dispositions',
    '| Finding ID | Disposition | Authorization basis | Reason absent from initial round | Evidence |',
    '|---|---|---|---|---|',
    '| CODE-NEW-channel-normalization-L2 | actionable | direct_acceptance_criterion_violation | not applicable | current code |',
    '| ARCH-NEW-channel-normalization-L2 | duplicate | direct_acceptance_criterion_violation | not applicable | same cause as CODE-NEW-channel-normalization-L2 |',
    '| CODE-NEW-worker-channel-retention-L2 | actionable | remediation_regression | remediation created this path | introduced after the initial round |',
  ].join('\n');

  assert.equal(assertReviewAdjudicationPhase1(`${withoutNarrativeDispositions}\n${table}`).pass, true);
});

test('rejects a disposition combined with a family value in one cell', () => {
  const withoutNarrativeDispositions = PHASE1_FIXTURE
    .split('\n')
    .filter((line) => ![
      'CODE-NEW-channel-normalization-L2',
      'ARCH-NEW-channel-normalization-L2',
      'CODE-NEW-worker-channel-retention-L2',
    ].some((findingId) => line.includes(findingId)))
    .join('\n');
  const table = [
    '## 指摘ごとの裁定',
    '| finding ID | 裁定 / family | Authorization Basis | 根拠 |',
    '|---|---|---|---|',
    '| CODE-NEW-channel-normalization-L2 | actionable / channel-normalization | direct_acceptance_criterion_violation | current code |',
    '| ARCH-NEW-channel-normalization-L2 | duplicate / channel-normalization | direct_acceptance_criterion_violation | same cause |',
    '| CODE-NEW-worker-channel-retention-L2 | actionable / channel-normalization | remediation_regression | remediation で作成された経路 |',
  ].join('\n');

  assert.equal(assertReviewAdjudicationPhase1(`${withoutNarrativeDispositions}\n${table}`).pass, false);
});

test('accepts a combined family-authorization-basis column in Phase 1', () => {
  const withoutNarrativeDispositions = PHASE1_FIXTURE
    .split('\n')
    .filter((line) => ![
      'CODE-NEW-channel-normalization-L2',
      'ARCH-NEW-channel-normalization-L2',
      'CODE-NEW-worker-channel-retention-L2',
    ].some((findingId) => line.includes(findingId)))
    .join('\n');
  const table = [
    '## Finding Dispositions',
    '| finding_id | Disposition | family / Authorization Basis | Evidence |',
    '|---|---|---|---|',
    '| CODE-NEW-channel-normalization-L2 | duplicate | FAM-channel-normalization / direct_acceptance_criterion_violation | current code |',
    '| ARCH-NEW-channel-normalization-L2 | actionable | FAM-channel-normalization / direct_acceptance_criterion_violation | same cause |',
    '| CODE-NEW-worker-channel-retention-L2 | actionable | FAM-channel-normalization / remediation_regression | remediation で追加された経路 |',
  ].join('\n');

  assert.equal(assertReviewAdjudicationPhase1(`${withoutNarrativeDispositions}\n${table}`).pass, true);
});

test('accepts either initial finding as canonical when one is actionable and one is duplicate', () => {
  const reversed = PHASE1_FIXTURE
    .replace(
      `${CODE_DISPOSITION}。`,
      '`CODE-NEW-channel-normalization-L2` は `direct_acceptance_criterion_violation` を根拠とする `duplicate`。',
    )
    .replace(
      `${ARCHITECTURE_DISPOSITION}。`,
      '`ARCH-NEW-channel-normalization-L2` は `direct_acceptance_criterion_violation` を根拠とする `actionable`。',
    );

  assert.equal(assertReviewAdjudicationPhase1(reversed).pass, true);
});

test('accepts Japanese statements that do not make an excessive mechanism a contract', () => {
  const phrasing = PHASE1_FIXTURE.replace(
    'transaction の提案は不要として退け、',
    'Transaction は新たな契約にしない。Transaction の変更は行わない。',
  );

  assert.equal(assertReviewAdjudicationPhase1(phrasing).pass, true);
});

test('accepts a passive Japanese rejection of legacy aliases', () => {
  assert.equal(hasNoLegacyAliasEvidence('legacy alias は受理されず早期拒否される'), true);
});

for (const [name, original, negated] of [
  [
    'code disposition',
    CODE_DISPOSITION,
    '`CODE-NEW-channel-normalization-L2` は `direct_acceptance_criterion_violation` を根拠とする `actionable` ではない',
  ],
  [
    'architecture disposition',
    ARCHITECTURE_DISPOSITION,
    '`ARCH-NEW-channel-normalization-L2` は `direct_acceptance_criterion_violation` を持つ `duplicate` ではない',
  ],
  [
    'remediation disposition',
    REMEDIATION_DISPOSITION,
    '`CODE-NEW-worker-channel-retention-L2` は同じ family に属する `actionable` ではない。根拠は `remediation_regression`',
  ],
]) {
  test(`rejects a negated ${name}`, () => {
    assert.equal(assertReviewAdjudicationPhase1(PHASE1_FIXTURE.replace(original, negated)).pass, false);
  });
}

test('rejects a basis attributed only to the reason-absent field', () => {
  const misplaced = PHASE1_FIXTURE.replace(
    `${CODE_DISPOSITION}。`,
    '`CODE-NEW-channel-normalization-L2` は `actionable`。初回に含まれなかった理由は `direct_acceptance_criterion_violation`。',
  );
  const result = assertReviewAdjudicationPhase1(misplaced);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('initial-pair-direct-bases'), true);
});

test('rejects omitting a submitted finding from the Phase 1 decision', () => {
  const omitted = PHASE1_FIXTURE
    .split('\n')
    .filter((line) => !line.includes('ARCH-NEW-channel-type-error-L2'))
    .join('\n');
  const result = assertReviewAdjudicationPhase1(omitted);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('all-findings-addressed'), true);
});

test('rejects a contradictory actionable disposition for a non-actionable finding', () => {
  const contradictory = PHASE1_FIXTURE.replace(
    '技術的には確認済みですが `overreach`。タスクは厳密なエラー class や message を約束していません。',
    '技術的には `actionable` と確認済みで、`overreach` ではない。タスクは厳密なエラー class や message を約束していません。',
  );
  const result = assertReviewAdjudicationPhase1(contradictory);
  assert.equal(result.pass, false);
  assert.equal(result.reason.includes('type-error-overreach'), true);
});
