import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

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
const REVIEW_ADJUDICATION_PHASE2_TARGET_ID = 'review-adjudication-phase2';
const SOURCE_WORKFLOW = 'development-review';
const SECURITY_REVIEW_POOL = 'security-review-facets';
const CANDIDATE_KNOWLEDGE = readFileSync(
  new URL('../../builtins/ja/facets/knowledge/security-local.md', import.meta.url),
  'utf8',
).trim();
const CHILD_PROCESS_TIMEOUT_MS = 30_000;

function spawnNode(args, timeout = CHILD_PROCESS_TIMEOUT_MS) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
  });
}

function runNode(args) {
  const result = spawnNode(args);

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `child process terminated by ${result.signal}`);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function runPrepare(targetIds) {
  return runNode(['eval/scripts/prepare.mjs', ...targetIds]);
}

test('force-kills a child process that exceeds the hang watchdog', () => {
  const result = spawnNode(['-e', 'setInterval(() => {}, 1000)'], 50);

  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGKILL');
});

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
    const result = runPrepare([SMOKE_TARGET_ID]);

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
  const result = runNode([
    '--input-type=module',
    '-e',
    `await import(${JSON.stringify(new URL('../scripts/prepare.mjs', import.meta.url).href)});`,
  ]);

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(snapshotFile(SMOKE_PROMPT_PATH), promptBefore);
});

test('renders eval targets with the production caller review mode', () => {
  runPrepare([...REVIEW_MODE_TARGETS.keys()]);
  const scopeRule = readFileSync(new URL(
    '../../builtins/ja/workflows/rules/peer-review-scope.md',
    import.meta.url,
  ), 'utf8').trim();

  for (const [targetId, reviewMode] of REVIEW_MODE_TARGETS) {
    const promptPath = fileURLToPath(
      new URL(`../../eval/prompts/${targetId}.phase1.md`, import.meta.url),
    );
    const prompt = readFileSync(promptPath, 'utf8');
    assert.doesNotMatch(prompt, /\{var:review_mode\}/);
    const expectedRule = scopeRule
      .replaceAll('{var:review_mode}', reviewMode)
      .replaceAll('{step_iteration}', '1');
    assert.ok(prompt.includes(expectedRule), `${targetId}: caller review mode must reach the scope rule`);
  }
});

test('renders the production review-adjudication Phase 2 report contract', () => {
  runPrepare([REVIEW_ADJUDICATION_PHASE2_TARGET_ID]);

  const promptPath = fileURLToPath(new URL(
    `../../eval/prompts/${REVIEW_ADJUDICATION_PHASE2_TARGET_ID}.phase2.md`,
    import.meta.url,
  ));
  const prompt = readFileSync(promptPath, 'utf8');
  assert.match(prompt, /review-resolution\.md/);
  assert.match(prompt, /\{\{previous_response\}\}/);
});
