import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { assertRequiredFacetSnapshots } from '../scripts/prepare.mjs';

const EVAL_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(EVAL_DIR, '..');

test('frontend prepare creates independent snapshot sets for each configured execution directory', () => {
  const result = spawnSync(
    process.execPath,
    ['eval/scripts/prepare.mjs', 'frontend-review', 'frontend-review-react'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const id of ['frontend-review', 'frontend-review-react']) {
    const runDirectory = join(EVAL_DIR, '.work', id);
    const snapshotDirectory = join(runDirectory, '.takt', 'eval-snapshots');
    assert.equal(existsSync(runDirectory), true);
    assert.deepEqual(
      readdirSync(snapshotDirectory).sort(),
      [`${id}-knowledge.md`, `${id}-policies.md`].sort(),
    );
    for (const snapshotName of readdirSync(snapshotDirectory)) {
      assert.ok(readFileSync(join(snapshotDirectory, snapshotName), 'utf8').trim().length > 0);
    }

    const prompt = readFileSync(join(EVAL_DIR, 'prompts', `${id}.phase1.j2`), 'utf8');
    assert.match(prompt, new RegExp(`/eval/\\.work/${id}(?:/|\\b)`));
  }
});

test('normal promptfoo loading preserves each frontend prompt config for the provider', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-frontend-promptfoo-config-'));
  const binDirectory = join(directory, 'bin');
  const resultPath = join(directory, 'result.json');
  try {
    mkdirSync(binDirectory);
    const claudePath = join(binDirectory, 'claude');
    writeFileSync(claudePath, '#!/bin/sh\nprintf \'[]\\n\'\n');
    chmodSync(claudePath, 0o755);

    const preparation = spawnSync(
      process.execPath,
      ['eval/scripts/prepare.mjs', 'frontend-review', 'frontend-review-react'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    assert.equal(preparation.status, 0, preparation.stderr || preparation.stdout);

    const evaluation = spawnSync(
      process.execPath,
      [
        'node_modules/promptfoo/dist/src/entrypoint.js',
        'eval',
        '-c',
        'eval/agents/frontend-review/frontend-opus.yaml',
        '--filter-first-n',
        '1',
        '--no-cache',
        '--no-progress-bar',
        '--no-table',
        '--no-share',
        '-o',
        resultPath,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
          PROMPTFOO_CONFIG_DIR: directory,
        },
      },
    );
    assert.notEqual(evaluation.status, null, evaluation.error?.message);

    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    const configs = result.results.prompts.map(({ config }) => config);
    assert.deepEqual(configs, [
      {
        working_dir: '.work/frontend-review',
        required_snapshots: [
          '.takt/eval-snapshots/frontend-review-policies.md',
          '.takt/eval-snapshots/frontend-review-knowledge.md',
        ],
      },
      {
        working_dir: '.work/frontend-review-react',
        required_snapshots: [
          '.takt/eval-snapshots/frontend-review-react-policies.md',
          '.takt/eval-snapshots/frontend-review-react-knowledge.md',
        ],
      },
    ]);
    assert.equal(
      result.results.results.every(({ response }) => response?.error === undefined && response?.output === '[]\n'),
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('prepare rejects a required facet snapshot that is missing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-frontend-snapshot-check-'));
  const policiesPath = join(directory, 'policies.md');
  try {
    writeFileSync(policiesPath, '# policies\n');
    assert.throws(
      () => assertRequiredFacetSnapshots('frontend-review', ['policies', 'knowledge'], {
        policies: policiesPath,
        knowledge: join(directory, 'missing-knowledge.md'),
      }),
      /Required knowledge facet snapshot missing for eval target "frontend-review"/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
