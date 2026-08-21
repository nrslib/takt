import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { composeConfiguredDynamicFacets } = await import('../scripts/prepare.mjs');

const TARGET_ID = 'prepare-dynamic-facet-composition-contract';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SMOKE_TARGET_ID = 'coding-review';
const SMOKE_PROMPT_PATH = fileURLToPath(
  new URL(`../../eval/prompts/${SMOKE_TARGET_ID}.phase1.md`, import.meta.url),
);
const SMOKE_RUNTIME_DIR = fileURLToPath(
  new URL('../../eval/fixtures/sample-project/.takt', import.meta.url),
);
const REVIEW_MODE_TARGETS = new Map([
  ['review-family-closure', 'initial'],
  ['initial-review-contract-discovery', 'initial'],
  ['testing-review-observable-evidence', 'initial'],
  ['security-review-method', 'initial'],
  ['follow-up-review-repair-regression', 'follow_up'],
  ['follow-up-testing-review-repair-regression', 'follow_up'],
  ['review-adjudication-binding', 'follow_up'],
]);
const PHASE1_WITHOUT_OUTPUT_CONTRACT_TARGET_IDS = [
  'security-review-method',
  'review-adjudication-binding',
];
const FOLLOW_UP_PHASE2_TARGET_ID = 'follow-up-review-repair-regression-phase2';
const REVIEW_ADJUDICATION_PHASE1_TARGET_ID = 'review-adjudication';
const REVIEW_ADJUDICATION_PHASE2_TARGET_ID = 'review-adjudication-phase2';
const SOURCE_WORKFLOW = 'development-review';
const SECURITY_REVIEW_POOL = 'security-review-facets';
const CANDIDATE_KNOWLEDGE = readFileSync(
  new URL('../../builtins/ja/facets/knowledge/security-local.md', import.meta.url),
  'utf8',
).trim();

function selection(overrides = {}) {
  return {
    sourceWorkflow: SOURCE_WORKFLOW,
    pool: SECURITY_REVIEW_POOL,
    candidateIds: ['cli'],
    ...overrides,
  };
}

function target() {
  return {
    policyContents: [{ content: 'fixed policy' }],
    knowledgeContents: [{ content: 'fixed knowledge' }],
  };
}

function snapshotFile(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path, { bigint: true });
  return {
    content: readFileSync(path),
    mtimeNs: stat.mtimeNs,
    size: stat.size,
  };
}

function assertCompositionError(run, cause) {
  assert.throws(run, (error) => {
    assert.match(error.message, new RegExp(`eval target "${TARGET_ID}"`));
    assert.match(error.message, cause);
    return true;
  });
}

test('composes knowledge from the selected dynamic facet candidate', () => {
  const result = composeConfiguredDynamicFacets(
    target(),
    selection(),
    TARGET_ID,
    'security-review',
  );

  assert.ok(result.knowledgeContents.some(({ content }) => content.trim() === CANDIDATE_KNOWLEDGE));
  assert.ok(result.policyContents.some(({ content }) => content === 'fixed policy'));
});

test('keeps the target unchanged when dynamic facet selection is not configured', () => {
  const original = target();

  assert.strictEqual(
    composeConfiguredDynamicFacets(original, undefined, TARGET_ID, 'security-review'),
    original,
  );
});

test('reports a missing source step with the target ID', () => {
  assertCompositionError(
    () => composeConfiguredDynamicFacets(target(), selection(), TARGET_ID, 'missing-step'),
    /Dynamic facet source step not found.*development-review\/missing-step/,
  );
});

test('reports a source step without dynamic facets with the target ID', () => {
  assertCompositionError(
    () => composeConfiguredDynamicFacets(target(), selection(), TARGET_ID, 'review'),
    /has no dynamicFacets configuration.*development-review\/review/,
  );
});

test('reports a dynamic facet pool mismatch with the target ID', () => {
  assertCompositionError(
    () => composeConfiguredDynamicFacets(
      target(),
      selection({ pool: 'other-security-review-facets' }),
      TARGET_ID,
      'security-review',
    ),
    /Dynamic facet pool mismatch.*expected "other-security-review-facets".*source uses "security-review-facets"/,
  );
});

test('reports an unknown candidate ID with the target ID', () => {
  assertCompositionError(
    () => composeConfiguredDynamicFacets(
      target(),
      selection({ candidateIds: ['unknown-candidate'] }),
      TARGET_ID,
      'security-review',
    ),
    /Dynamic facet candidate mismatch.*candidate "unknown-candidate".*pool "security-review-facets"/,
  );
});

test('executes main when prepare.mjs is launched directly', () => {
  const promptBefore = snapshotFile(SMOKE_PROMPT_PATH);
  const runtimeDirBefore = existsSync(SMOKE_RUNTIME_DIR);

  try {
    const result = spawnSync(
      process.execPath,
      ['eval/scripts/prepare.mjs', SMOKE_TARGET_ID],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`\\[${SMOKE_TARGET_ID}\\]`));
  } finally {
    if (promptBefore === null) {
      rmSync(SMOKE_PROMPT_PATH, { force: true });
    }
    if (!runtimeDirBefore) {
      rmSync(SMOKE_RUNTIME_DIR, { recursive: true, force: true });
    }
  }
});

test('does not execute main when prepare.mjs is imported', () => {
  const promptBefore = snapshotFile(SMOKE_PROMPT_PATH);
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(new URL('../scripts/prepare.mjs', import.meta.url).href)});`,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(snapshotFile(SMOKE_PROMPT_PATH), promptBefore);
});

test('renders eval targets with the production caller review mode', () => {
  const result = spawnSync(
    process.execPath,
    ['eval/scripts/prepare.mjs', ...REVIEW_MODE_TARGETS.keys()],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);

  for (const [targetId, reviewMode] of REVIEW_MODE_TARGETS) {
    const promptPath = fileURLToPath(
      new URL(`../../eval/prompts/${targetId}.phase1.md`, import.meta.url),
    );
    const prompt = readFileSync(promptPath, 'utf8');
    assert.equal(
      prompt.includes(`レビュー区分 \`${reviewMode}\``)
        || prompt.includes(`Review mode \`${reviewMode}\``),
      true,
      `${targetId} must render review mode ${reviewMode}`,
    );
  }
});

test('does not inject report output contracts into Phase 1 eval prompts', () => {
  const result = spawnSync(
    process.execPath,
    ['eval/scripts/prepare.mjs', ...PHASE1_WITHOUT_OUTPUT_CONTRACT_TARGET_IDS],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);

  for (const targetId of PHASE1_WITHOUT_OUTPUT_CONTRACT_TARGET_IDS) {
    const promptPath = fileURLToPath(
      new URL(`../../eval/prompts/${targetId}.phase1.md`, import.meta.url),
    );
    const prompt = readFileSync(promptPath, 'utf8');
    assert.doesNotMatch(prompt, /## Phase 1 evaluation output contract/);
    assert.doesNotMatch(prompt, /(?:入力・状態・経路別の終端結果|Terminal Results by Input, State, and Path)/);
  }
});

test('renders the production Phase 2 terminal-result report contract', () => {
  const result = spawnSync(
    process.execPath,
    ['eval/scripts/prepare.mjs', FOLLOW_UP_PHASE2_TARGET_ID],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);

  const promptPath = fileURLToPath(
    new URL(`../../eval/prompts/${FOLLOW_UP_PHASE2_TARGET_ID}.phase2.md`, import.meta.url),
  );
  const prompt = readFileSync(promptPath, 'utf8');
  assert.match(prompt, /(?:問題系列の完了走査|Problem-Family Completion Sweep)/);
  assert.match(prompt, /(?:契約根拠|Contract authority)/);
  assert.match(prompt, /(?:入力・状態・経路別の終端結果|Terminal Results by Input, State, and Path)/);
  assert.match(prompt, /(?:期待する終端結果|Expected terminal result)/);
  assert.match(prompt, /(?:実際の終端結果と証拠|Actual terminal result and evidence)/);

});

test('renders the production review-adjudication Phase 2 report contract', () => {
  const result = spawnSync(
    process.execPath,
    ['eval/scripts/prepare.mjs', REVIEW_ADJUDICATION_PHASE2_TARGET_ID],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);

  const promptPath = fileURLToPath(new URL(
    `../../eval/prompts/${REVIEW_ADJUDICATION_PHASE2_TARGET_ID}.phase2.md`,
    import.meta.url,
  ));
  const prompt = readFileSync(promptPath, 'utf8');
  assert.match(prompt, /review-resolution\.md/);
  assert.match(prompt, /\{\{previous_response\}\}/);
  assert.match(prompt, /(?:修正対象 family|Actionable Families)/);
  assert.match(prompt, /(?:指摘ごとの裁定|Finding Dispositions)/);
  assert.match(prompt, /(?:適用 policy が選定した正確な機械値1つ|exact single machine value selected by the applicable policy)/);
});

test('does not hard-code workflow-specific report paths in Japanese adjudication instructions', () => {
  const instructionPath = fileURLToPath(new URL(
    '../../builtins/ja/facets/instructions/adjudicate-review-findings.md',
    import.meta.url,
  ));
  const instruction = readFileSync(instructionPath, 'utf8');
  assert.doesNotMatch(instruction, /subworkflows\/iteration-N--step-(?:initial-reviewers|reviewers)/);
  assert.doesNotMatch(instruction, /(?:reviewer suite|reviewer-suite|同じ peer-review)/i);
});

test('composes finding authority policy into the production final gate', () => {
  const targetId = 'final-readiness-supervision-phase2';
  const result = spawnSync(
    process.execPath,
    ['eval/scripts/prepare.mjs', 'final-readiness-supervision', targetId],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);

  const policySnapshotPath = fileURLToPath(new URL(
    `../../eval/fixtures/final-readiness-supervision/.takt/eval-snapshots/${targetId}-policies.md`,
    import.meta.url,
  ));
  const policySnapshot = readFileSync(policySnapshotPath, 'utf8');
  const promptPath = fileURLToPath(new URL(
    '../../eval/prompts/final-readiness-supervision.phase1.md',
    import.meta.url,
  ));
  const prompt = readFileSync(promptPath, 'utf8');
  assert.match(policySnapshot, /(?:探索権限と finding・修正権限|Exploration Authority and Finding \/ Remediation Authority)/);
  assert.match(policySnapshot, /follow-up または Final preservation/);
  assert.match(policySnapshot, /元要件が定義した accepted family/);
  const phase2PromptPath = fileURLToPath(new URL(
    `../../eval/prompts/${targetId}.phase2.md`,
    import.meta.url,
  ));
  const phase2Prompt = readFileSync(phase2PromptPath, 'utf8');
  assert.match(phase2Prompt, /follow-up または Final preservation/);
  assert.equal(
    [...policySnapshot.matchAll(/^# (?:レビューポリシー|Review Policy)$/gm)].length,
    1,
    'the final gate must receive the canonical review policy exactly once',
  );
  assert.match(
    prompt,
    /(?:review-resolution\.md または supervisor-validation\.md|review-resolution\.md or supervisor-validation\.md)[^\n]*(?:「修正対象 family」|Actionable Families)/i,
  );
  assert.doesNotMatch(
    prompt,
    /(?:レビュー報告または supervisor-validation\.md|review report or supervisor-validation\.md)[^\n]*(?:問題系列の完了走査|Problem-Family Completion Sweep)/i,
  );
});
