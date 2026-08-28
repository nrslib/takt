import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
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

  assert.throws(
    () => buildExecutionPlan(
      {
        tags: ['review'],
        entries: [{ id: 'review-entry', tag: 'review' }],
        count: 2,
      },
      {
        workflow: {
          entry: 'root',
          calls: { root: [] },
        },
      },
    ),
    TypeError,
  );

  const withoutSelectionMatch = buildExecutionPlan({
    tags: ['missing'],
    entries: [
      { id: 'review-entry', tag: 'review' },
      { id: 'other-entry', tag: 'other' },
    ],
    count: 2,
  });

  assert.deepEqual(withoutSelectionMatch.selection.ids, []);
  assert.deepEqual(withoutSelectionMatch.cycle, result.cycle);
  assert.deepEqual(withoutSelectionMatch.monitor, result.monitor);

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

  const beforeLimit = buildExecutionPlan({
    tags: ['review'],
    entries: [
      { id: 'review-entry', tag: 'review' },
      { id: 'other-entry', tag: 'other' },
    ],
    count: 1,
  });

  assert.deepEqual(beforeLimit.selection, result.selection);
  assert.deepEqual(beforeLimit.cycle, result.cycle);
  assert.equal(beforeLimit.monitor.decision, 'continue');
  assert.equal(beforeLimit.monitor.instruction, 'Inspect pass 1.');
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

    const alternateSource = buildArtifact(projectRoot, {
      ...settings,
      source: 'artifacts/alternate.json',
    });

    assert.equal(alternateSource.document.label, 'document:d-002');
    assert.equal(alternateSource.document.content, '# d-002\n- gamma');
    assert.deepEqual(alternateSource.sections, result.sections);

    const alternateRender = buildArtifact(projectRoot, {
      ...settings,
      documentLabel: 'note:{document_id}',
    });

    assert.equal(alternateRender.document.label, 'note:d-001');
    assert.equal(alternateRender.document.content, result.document.content);
    assert.deepEqual(alternateRender.sections, result.sections);

    const alternateOrder = buildArtifact(projectRoot, {
      ...settings,
      sections: [
        { name: 'summary', order: 1 },
        { name: 'details', order: 2 },
      ],
    });

    assert.deepEqual(alternateOrder.sections.map(({ name }) => name), ['summary', 'details']);
    assert.deepEqual(alternateOrder.document, result.document);

    const alternateOutput = buildArtifact(projectRoot, {
      ...settings,
      indexPath: 'output/alternate.md',
    });

    assert.deepEqual(alternateOutput.document, result.document);
    assert.deepEqual(alternateOutput.sections, result.sections);
    assert.equal(alternateOutput.indexFile, join(projectRoot, 'output/alternate.md'));
    assert.equal(readFileSync(alternateOutput.indexFile, 'utf8'), '# d-001\n- alpha\n- beta');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
