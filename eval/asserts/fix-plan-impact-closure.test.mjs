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

function cedarInput(overrides = {}) {
  return {
    tags: ['review'],
    entries: [
      { id: 'review-entry', tag: 'review' },
      { id: 'other-entry', tag: 'other' },
    ],
    count: 2,
    ...overrides,
  };
}

function withLanternFixture(run) {
  const fixture = new URL('../fixtures/project-lantern/', import.meta.url);
  const projectRoot = mkdtempSync(join(tmpdir(), 'project-lantern-'));
  try {
    cpSync(fixture, projectRoot, { recursive: true });
    run(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

test('project cedar exposes the partial-source failure after a complete source succeeds', () => {
  const complete = buildExecutionPlan(cedarInput(), definition);

  assert.deepEqual(complete.selection.ids, ['review-entry']);
  assert.deepEqual(complete.cycle, ['root', 'child', 'root']);
  assert.equal(complete.monitor.decision, 'stop');

  assert.throws(
    () => buildExecutionPlan(
      cedarInput(),
      {
        workflow: {
          entry: 'root',
          calls: { root: [] },
        },
      },
    ),
    TypeError,
  );
});

test('project cedar observes selection through the public entry', () => {
  const matching = buildExecutionPlan(cedarInput());
  const withoutMatch = buildExecutionPlan(cedarInput({ tags: ['missing'] }));

  assert.deepEqual(matching.selection.ids, ['review-entry']);
  assert.equal(matching.selection.role, 'reviewer');
  assert.equal(matching.selection.instruction, 'Choose matching entries.');
  assert.deepEqual(withoutMatch.selection.ids, []);
  assert.deepEqual(withoutMatch.cycle, matching.cycle);
  assert.deepEqual(withoutMatch.monitor, matching.monitor);
});

test('project cedar observes cycle changes through the public entry', () => {
  const cyclic = buildExecutionPlan(cedarInput());

  const withoutCycle = buildExecutionPlan(
    cedarInput(),
    {
      ...definition,
      workflow: {
        entry: 'root',
        calls: { root: [] },
      },
    },
  );

  assert.deepEqual(cyclic.cycle, ['root', 'child', 'root']);
  assert.deepEqual(withoutCycle.cycle, []);
  assert.deepEqual(withoutCycle.selection, cyclic.selection);
  assert.deepEqual(withoutCycle.monitor, cyclic.monitor);
});

test('project cedar observes monitor changes through the public entry', () => {
  const atLimit = buildExecutionPlan(cedarInput());
  const beforeLimit = buildExecutionPlan(cedarInput({ count: 1 }));

  assert.equal(atLimit.monitor.decision, 'stop');
  assert.equal(atLimit.monitor.instruction, 'Inspect pass 2.');
  assert.equal(beforeLimit.monitor.decision, 'continue');
  assert.equal(beforeLimit.monitor.instruction, 'Inspect pass 1.');
  assert.deepEqual(beforeLimit.selection, atLimit.selection);
  assert.deepEqual(beforeLimit.cycle, atLimit.cycle);
});

test('project lantern observes source changes through the public entry', () => {
  withLanternFixture((projectRoot) => {
    const baseline = buildArtifact(projectRoot);
    const alternate = buildArtifact(projectRoot, {
      ...settings,
      source: 'artifacts/alternate.json',
    });

    assert.equal(baseline.document.label, 'document:d-001');
    assert.equal(alternate.document.label, 'document:d-002');
    assert.equal(alternate.document.content, '# d-002\n- gamma');
    assert.deepEqual(alternate.sections, baseline.sections);
  });
});

test('project lantern observes render changes through the public entry', () => {
  withLanternFixture((projectRoot) => {
    const baseline = buildArtifact(projectRoot);
    const alternate = buildArtifact(projectRoot, {
      ...settings,
      documentLabel: 'note:{document_id}',
    });

    assert.equal(baseline.document.label, 'document:d-001');
    assert.equal(alternate.document.label, 'note:d-001');
    assert.equal(alternate.document.content, baseline.document.content);
    assert.deepEqual(alternate.sections, baseline.sections);
  });
});

test('project lantern observes sort changes through the public entry', () => {
  withLanternFixture((projectRoot) => {
    const baseline = buildArtifact(projectRoot);
    const alternate = buildArtifact(projectRoot, {
      ...settings,
      sections: [
        { name: 'summary', order: 1 },
        { name: 'details', order: 2 },
      ],
    });

    assert.deepEqual(baseline.sections.map(({ name }) => name), ['details', 'summary']);
    assert.deepEqual(alternate.sections.map(({ name }) => name), ['summary', 'details']);
    assert.deepEqual(alternate.document, baseline.document);
  });
});

test('project lantern observes persisted output changes through the public entry', () => {
  withLanternFixture((projectRoot) => {
    const baseline = buildArtifact(projectRoot);
    const alternate = buildArtifact(projectRoot, {
      ...settings,
      indexPath: 'output/alternate.md',
    });

    assert.equal(baseline.indexFile, join(projectRoot, 'output/index.md'));
    assert.equal(readFileSync(baseline.indexFile, 'utf8'), '# d-001\n- alpha\n- beta');
    assert.equal(alternate.indexFile, join(projectRoot, 'output/alternate.md'));
    assert.equal(readFileSync(alternate.indexFile, 'utf8'), '# d-001\n- alpha\n- beta');
    assert.deepEqual(alternate.document, baseline.document);
    assert.deepEqual(alternate.sections, baseline.sections);
  });
});
