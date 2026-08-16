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
const SOURCE_WORKFLOW = 'experimental-review';
const SECURITY_REVIEW_POOL = 'security-review-facets';
const FIXED_POLICY = 'fixed policy';
const FIXED_KNOWLEDGE = 'fixed knowledge';
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
    policyContents: [{ content: FIXED_POLICY }],
    knowledgeContents: [{ content: FIXED_KNOWLEDGE }],
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

function assertCompositionError(run, ...identifiers) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(TARGET_ID));
    for (const identifier of identifiers) {
      assert.ok(error.message.includes(identifier));
    }
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
  assert.ok(result.policyContents.some(({ content }) => content === FIXED_POLICY));
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
    SOURCE_WORKFLOW,
    'missing-step',
  );
});

test('reports a source step without dynamic facets with the target ID', () => {
  assertCompositionError(
    () => composeConfiguredDynamicFacets(target(), selection(), TARGET_ID, 'review'),
    SOURCE_WORKFLOW,
    'review',
  );
});

test('reports a dynamic facet pool mismatch with the target ID', () => {
  const requestedPool = 'other-security-review-facets';
  assertCompositionError(
    () => composeConfiguredDynamicFacets(
      target(),
      selection({ pool: requestedPool }),
      TARGET_ID,
      'security-review',
    ),
    requestedPool,
    SECURITY_REVIEW_POOL,
  );
});

test('reports an unknown candidate ID with the target ID', () => {
  const unknownCandidate = 'unknown-candidate';
  assertCompositionError(
    () => composeConfiguredDynamicFacets(
      target(),
      selection({ candidateIds: [unknownCandidate] }),
      TARGET_ID,
      'security-review',
    ),
    unknownCandidate,
    SECURITY_REVIEW_POOL,
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
