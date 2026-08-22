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
  ['review-impact-path-coverage', 'initial'],
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
const REVIEW_ADJUDICATION_PHASE2_TARGET_ID = 'review-adjudication-phase2';
const PRODUCTION_REVIEWER_SUITES = [
  'development-review',
  'takt-development-review',
  'peer-review-suite-base',
  'peer-review-suite-cqrs',
  'peer-review-suite-frontend',
  'peer-review-suite-frontend-cqrs',
];
const PROBLEM_TRACKING_STEPS = [
  'peer-review-adjudication.yaml',
  'peer-review-fix-plan.yaml',
  'peer-review-fix.yaml',
  'peer-review-fix-verifier.yaml',
  'peer-review-final-gate.yaml',
];
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
    assert.doesNotMatch(prompt, /\{var:review_mode\}/);
    assert.match(
      prompt,
      new RegExp('レビュー区分は\\s+`' + reviewMode + '`'),
    );
    assert.doesNotMatch(prompt, /The review mode is/i);
  }
});

test('composes only reviewer-scoped workflow rules into every production reviewer suite', () => {
  for (const language of ['ja', 'en']) {
    for (const workflow of PRODUCTION_REVIEWER_SUITES) {
      const workflowPath = new URL(
        `../../builtins/${language}/workflows/${workflow}.yaml`,
        import.meta.url,
      );
      const source = readFileSync(workflowPath, 'utf8');
      assert.equal(
        [...source.matchAll(/^\s+- ref: peer-review-scope$/gm)].length,
        1,
        `${language}/${workflow} must compose peer-review-scope exactly once`,
      );
      assert.equal(
        [...source.matchAll(/^\s+- ref: existing-finding-lookup$/gm)].length,
        1,
        `${language}/${workflow} must compose existing-finding-lookup exactly once`,
      );
      assert.doesNotMatch(
        source,
        /^\s+- ref: problem-tracking$/m,
        `${language}/${workflow} must not compose remediation tracking into ordinary reviewers`,
      );
    }
  }
});

test('composes remediation problem tracking only in dedicated step instructions', () => {
  for (const language of ['ja', 'en']) {
    for (const fileName of PROBLEM_TRACKING_STEPS) {
      const source = readFileSync(new URL(
        `../../builtins/${language}/steps/${fileName}`,
        import.meta.url,
      ), 'utf8');
      assert.equal(
        [...source.matchAll(/^\s+- review-remediation-problem-tracking$/gm)].length,
        1,
        `${language}/${fileName} must compose dedicated problem tracking exactly once`,
      );
    }

    const workflowSources = [
      'review-fix.yaml',
      'review-remediation.yaml',
      'development-remediation-dynamic.yaml',
      'development-remediation.yaml',
      'final-gate.yaml',
    ].map((fileName) => readFileSync(new URL(
      `../../builtins/${language}/workflows/${fileName}`,
      import.meta.url,
    ), 'utf8')).join('\n');
    assert.doesNotMatch(
      workflowSources,
      /^\s+- ref: (?:problem-tracking|existing-family-lookup|invariant-recurrence)$/m,
    );
  }
});

test('keeps remediation bookkeeping vocabulary out of ordinary reviewer prompts', () => {
  const targetIds = [
    'review-impact-path-coverage',
    'follow-up-review-repair-regression',
    'follow-up-testing-review-repair-regression',
  ];
  const result = spawnSync(
    process.execPath,
    ['eval/scripts/prepare.mjs', ...targetIds],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);

  for (const targetId of targetIds) {
    const promptPath = fileURLToPath(
      new URL(`../../eval/prompts/${targetId}.phase1.md`, import.meta.url),
    );
    const prompt = readFileSync(promptPath, 'utf8');
    assert.doesNotMatch(prompt, /\bfamily\b|actionable|fix-verifier|全13項目|再発台帳|不変条件台帳/i);
  }
});

test('keeps finding identity stable across newly checked paths', () => {
  const policies = [
    {
      language: 'ja',
      path: '../../builtins/ja/facets/partials/policies/review-common.md',
      sameProblem: /原因、破られる観測可能な条件、受入条件が同じなら同じ問題/,
      pathEvidence: /根拠ファイル、確認した場所、利用経路、再現入力の違いだけでは別問題にしない/,
      contradictorySplit: /根拠ファイル・再現条件が変わる場合は新規/,
    },
    {
      language: 'en',
      path: '../../builtins/en/facets/partials/policies/review-common.md',
      sameProblem: /cause, violated observable condition, and acceptance criteria remain the same/,
      pathEvidence: /Differences in evidence files, checked locations, consumer paths, or reproduction inputs alone do not create a different problem/,
      contradictorySplit: /problem meaning, evidence files, or reproduction conditions change, issue a new/,
    },
  ];

  for (const policy of policies) {
    const source = readFileSync(new URL(policy.path, import.meta.url), 'utf8');
    assert.match(source, policy.sameProblem, `${policy.language} must define finding identity by behavior`);
    assert.match(source, policy.pathEvidence, `${policy.language} must allow evidence paths to accumulate`);
    assert.doesNotMatch(
      source,
      policy.contradictorySplit,
      `${policy.language} must not split a finding merely because its evidence path changed`,
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
  }
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
  assert.doesNotMatch(prompt, /(?:適用 policy|include 済み|applicable policy|included policy)/i);
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

test('keeps peer-review round scope out of the production final gate', () => {
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
  assert.doesNotMatch(policySnapshot, /(?:peer-review process|ピアレビュー工程)/i);
  assert.equal(
    [...policySnapshot.matchAll(/^# (?:レビューポリシー|Review Policy)$/gm)].length,
    1,
    'the final gate must receive the canonical review policy exactly once',
  );
  assert.doesNotMatch(prompt, /(?:レビュー区分は|The review mode is)/i);
  assert.match(prompt, /(?:現在の裁定または修正計画が対象とした問題|problems covered by the current decision or repair plan)/i);
});
