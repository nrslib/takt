import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExecutionPlan } from '../fixtures/project-cedar/src/build-execution-plan.js';
import { definition } from '../fixtures/project-cedar/src/definition.js';
import { buildArtifact } from '../fixtures/project-lantern/src/build-artifact.js';
import { settings } from '../fixtures/project-lantern/src/settings.js';

test('project cedar exposes three independently observable results', () => {
  const result = buildExecutionPlan({
    tags: ['review'],
    entries: [
      { id: 'review-entry', tag: 'review' },
      { id: 'other-entry', tag: 'other' },
    ],
    count: 2,
  });

  assert.deepEqual(result.selection.ids, ['review-entry']);
  assert.deepEqual(result.cycle, ['root', 'child', 'root']);
  assert.equal(result.monitor.decision, 'stop');
  assert.equal(result.monitor.instruction, 'Inspect pass 2.');

  const withoutCycle = buildExecutionPlan(
    {
      tags: ['review'],
      entries: [{ id: 'review-entry', tag: 'review' }],
      count: 2,
    },
    {
      ...definition,
      workflow: {
        entry: 'root',
        calls: { root: [] },
      },
    },
  );

  assert.deepEqual(withoutCycle.selection.ids, ['review-entry']);
  assert.deepEqual(withoutCycle.cycle, []);
  assert.equal(withoutCycle.monitor.decision, 'stop');
});

test('project lantern reads, renders, orders, and persists its artifact', () => {
  const fixture = new URL('../fixtures/project-lantern/', import.meta.url);
  const projectRoot = mkdtempSync(join(tmpdir(), 'project-lantern-'));
  try {
    cpSync(fixture, projectRoot, { recursive: true });
    const result = buildArtifact(projectRoot);

    assert.equal(result.document.label, 'document:d-001');
    assert.deepEqual(result.sections.map(({ name }) => name), ['details', 'summary']);
    assert.equal(result.indexFile, join(projectRoot, 'output/index.md'));
    assert.equal(readFileSync(result.indexFile, 'utf8'), '# d-001\n- alpha\n- beta');

    const alternate = buildArtifact(projectRoot, {
      ...settings,
      documentLabel: 'note:{document_id}',
      indexPath: 'output/alternate.md',
      sections: [
        { name: 'summary', order: 1 },
        { name: 'details', order: 2 },
      ],
    });

    assert.equal(alternate.document.label, 'note:d-001');
    assert.deepEqual(alternate.sections.map(({ name }) => name), ['summary', 'details']);
    assert.equal(alternate.indexFile, join(projectRoot, 'output/alternate.md'));
    assert.equal(readFileSync(alternate.indexFile, 'utf8'), '# d-001\n- alpha\n- beta');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
