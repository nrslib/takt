import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '../fixtures/fix-plan-static-path-audit-b/src/schema.js';
import { loadReportInput } from '../fixtures/fix-plan-static-path-audit-b/src/loader.js';
import {
  expandReportTemplate,
  mergeReportFile,
  orderReportContracts,
} from '../fixtures/fix-plan-static-path-audit-b/src/report-consumer.js';
import { buildReportArtifact } from '../fixtures/fix-plan-static-path-audit-b/src/planner.js';

const fixtureRoot = new URL('../fixtures/fix-plan-static-path-audit-b/', import.meta.url);

function createProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'takt-static-path-b-'));
  mkdirSync(join(projectRoot, 'artifacts'), { recursive: true });
  cpSync(
    new URL('artifacts/source.json', fixtureRoot),
    join(projectRoot, 'artifacts', 'source.json'),
  );
  return projectRoot;
}

function withProject(run) {
  const projectRoot = createProject();
  try {
    return run(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

test('planner reads input, expands the template, and writes the merge terminal', () => {
  withProject((projectRoot) => {
    const result = buildReportArtifact(projectRoot);

    assert.equal(result.sourcePath, join(projectRoot, 'artifacts', 'source.json'));
    assert.deepEqual(result.orderedReports.map(({ name }) => name), ['findings', 'summary']);
    assert.equal(result.templatePath, 'reports/r-001.md');
    assert.equal(result.mergeFile, join(projectRoot, 'reports', 'index.md'));
    assert.equal(readFileSync(result.mergeFile, 'utf8'), '# r-001\n- first source entry\n- second source entry');
  });
});

test('source and template mutations reach the generated terminal', () => {
  withProject((projectRoot) => {
    const inputPath = join(projectRoot, 'artifacts', 'source.json');
    writeFileSync(inputPath, JSON.stringify({ report_id: 'r-002', entries: ['changed entry'] }));

    const loaded = loadReportInput(projectRoot, { arpeggio: schema.arpeggio });
    const rendered = expandReportTemplate(schema, loaded.source);
    const mergePath = mergeReportFile(projectRoot, schema, rendered);

    assert.equal(rendered.templatePath, 'reports/r-002.md');
    assert.equal(readFileSync(mergePath, 'utf8'), '# r-002\n- changed entry');
  });
});

test('template setting mutation reaches the generated terminal through the planner entry', () => {
  withProject((projectRoot) => {
    const changed = structuredClone(schema);
    changed.arpeggio.template = 'archive/{report_id}.md';

    const result = buildReportArtifact(projectRoot, changed);

    assert.equal(result.templatePath, 'archive/r-001.md');
    assert.equal(readFileSync(result.mergeFile, 'utf8'), '# r-001\n- first source entry\n- second source entry');
  });
});

test('order mutation changes the ordered contract', () => {
  const changed = structuredClone(schema);
  changed.output_contracts.report[0].order = 0;

  assert.deepEqual(orderReportContracts(changed.output_contracts).map(({ name }) => name), [
    'summary',
    'findings',
  ]);
});

test('report collection preserves duplicates and does not reintroduce omissions at the order terminal', () => {
  const duplicated = structuredClone(schema);
  duplicated.output_contracts.report.push({ name: 'findings', order: 3 });
  const omitted = structuredClone(schema);
  omitted.output_contracts.report = [omitted.output_contracts.report[0]];

  const duplicateNames = orderReportContracts(duplicated.output_contracts).map(({ name }) => name);
  const omittedNames = orderReportContracts(omitted.output_contracts).map(({ name }) => name);

  assert.deepEqual(duplicateNames, [
    'findings',
    'summary',
    'findings',
  ]);
  assert.equal(duplicateNames.filter((name) => name === 'findings').length, 2);
  assert.deepEqual(omittedNames, ['summary']);
  assert.equal(omittedNames.includes('findings'), false);
});

test('source path replacement and alternate input reach the same downstream consumers', () => {
  withProject((projectRoot) => {
    const alternatePath = join(projectRoot, 'artifacts', 'alternate.json');
    writeFileSync(alternatePath, JSON.stringify({ report_id: 'r-alternate', entries: ['alternate entry'] }));
    const changed = structuredClone(schema);
    changed.arpeggio.source_path = 'artifacts/alternate.json';

    const loaded = loadReportInput(projectRoot, changed);
    const rendered = expandReportTemplate(changed, loaded.source);
    const mergePath = mergeReportFile(projectRoot, changed, rendered);

    assert.equal(loaded.sourcePath, alternatePath);
    assert.equal(rendered.templatePath, 'reports/r-alternate.md');
    assert.equal(readFileSync(mergePath, 'utf8'), '# r-alternate\n- alternate entry');
    assert.equal(JSON.parse(readFileSync(join(projectRoot, 'artifacts', 'source.json'), 'utf8')).report_id, 'r-001');
  });
});

test('merge destination mutation changes the written terminal', () => {
  withProject((projectRoot) => {
    const changed = structuredClone(schema);
    changed.arpeggio.merge.file = 'reports/changed-index.md';
    const loaded = loadReportInput(projectRoot, changed);
    const rendered = expandReportTemplate(changed, loaded.source);
    const mergePath = mergeReportFile(projectRoot, changed, rendered);

    assert.equal(mergePath, join(projectRoot, 'reports', 'changed-index.md'));
    assert.equal(readFileSync(mergePath, 'utf8'), '# r-001\n- first source entry\n- second source entry');
  });
});

test('missing source input is rejected instead of silently skipping generation', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'takt-static-path-b-missing-'));
  try {
    const changed = structuredClone(schema);
    changed.arpeggio.source_path = 'artifacts/missing.json';

    assert.throws(() => loadReportInput(projectRoot, changed));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
