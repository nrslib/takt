import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExecutionPlan } from '../fixtures/project-cedar/src/build-execution-plan.js';
import { buildArtifact } from '../fixtures/project-lantern/src/build-artifact.js';

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
});

test('project lantern reads, renders, orders, and persists its artifact', () => {
  const fixture = new URL('../fixtures/project-lantern/', import.meta.url);
  const projectRoot = mkdtempSync(join(tmpdir(), 'project-lantern-'));
  try {
    cpSync(fixture, projectRoot, { recursive: true });
    const result = buildArtifact(projectRoot);

    assert.equal(result.document.path, 'documents/d-001.md');
    assert.deepEqual(result.sections.map(({ name }) => name), ['details', 'summary']);
    assert.equal(result.indexFile, join(projectRoot, 'output/index.md'));
    assert.equal(readFileSync(result.indexFile, 'utf8'), '# d-001\n- alpha\n- beta');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
