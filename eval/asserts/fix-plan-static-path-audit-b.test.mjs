import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '../fixtures/fix-plan-static-path-audit-b/src/schema.js';
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

test('report ID mutation reaches the generated template and artifact terminals', () => {
  withProject((projectRoot) => {
    const inputPath = join(projectRoot, 'artifacts', 'source.json');
    writeFileSync(inputPath, JSON.stringify({
      report_id: 'r-002',
      entries: ['first source entry', 'second source entry'],
    }));

    const result = buildReportArtifact(projectRoot);

    assert.equal(result.templatePath, 'reports/r-002.md');
    assert.equal(
      readFileSync(result.mergeFile, 'utf8'),
      '# r-002\n- first source entry\n- second source entry',
    );
  });
});

test('entry mutation reaches the generated artifact terminal', () => {
  withProject((projectRoot) => {
    const inputPath = join(projectRoot, 'artifacts', 'source.json');
    writeFileSync(inputPath, JSON.stringify({ report_id: 'r-001', entries: ['changed entry'] }));

    const result = buildReportArtifact(projectRoot);

    assert.equal(result.templatePath, 'reports/r-001.md');
    assert.equal(readFileSync(result.mergeFile, 'utf8'), '# r-001\n- changed entry');
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

test('order mutation changes the ordered contract through the planner entry', () => {
  withProject((projectRoot) => {
    const changed = structuredClone(schema);
    changed.output_contracts.report[0].order = 0;

    const result = buildReportArtifact(projectRoot, changed);

    assert.deepEqual(result.orderedReports.map(({ name }) => name), ['summary', 'findings']);
  });
});

test('report collection preserves duplicates at the planner terminal', () => {
  withProject((projectRoot) => {
    const changed = structuredClone(schema);
    changed.output_contracts.report.push({ name: 'findings', order: 3 });

    const result = buildReportArtifact(projectRoot, changed);
    const names = result.orderedReports.map(({ name }) => name);

    assert.deepEqual(names, ['findings', 'summary', 'findings']);
    assert.equal(names.filter((name) => name === 'findings').length, 2);
  });
});

test('report collection preserves omissions at the planner terminal', () => {
  withProject((projectRoot) => {
    const changed = structuredClone(schema);
    changed.output_contracts.report = [changed.output_contracts.report[0]];

    const result = buildReportArtifact(projectRoot, changed);
    const names = result.orderedReports.map(({ name }) => name);

    assert.deepEqual(names, ['summary']);
    assert.equal(names.includes('findings'), false);
  });
});

test('source path replacement and alternate input reach the same downstream consumers', () => {
  withProject((projectRoot) => {
    const alternatePath = join(projectRoot, 'artifacts', 'alternate.json');
    writeFileSync(alternatePath, JSON.stringify({
      report_id: 'r-001',
      entries: ['first source entry', 'second source entry'],
    }));
    const changed = structuredClone(schema);
    changed.arpeggio.source_path = 'artifacts/alternate.json';

    const result = buildReportArtifact(projectRoot, changed);

    assert.equal(result.sourcePath, alternatePath);
    assert.equal(result.templatePath, 'reports/r-001.md');
    assert.equal(
      readFileSync(result.mergeFile, 'utf8'),
      '# r-001\n- first source entry\n- second source entry',
    );
    assert.equal(JSON.parse(readFileSync(join(projectRoot, 'artifacts', 'source.json'), 'utf8')).report_id, 'r-001');
  });
});

test('merge destination mutation changes the written terminal', () => {
  withProject((projectRoot) => {
    const changed = structuredClone(schema);
    changed.arpeggio.merge.file = 'reports/changed-index.md';
    const result = buildReportArtifact(projectRoot, changed);

    assert.equal(result.mergeFile, join(projectRoot, 'reports', 'changed-index.md'));
    assert.equal(readFileSync(result.mergeFile, 'utf8'), '# r-001\n- first source entry\n- second source entry');
  });
});

test('missing source input is rejected instead of silently skipping generation', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'takt-static-path-b-missing-'));
  try {
    const changed = structuredClone(schema);
    changed.arpeggio.source_path = 'artifacts/missing.json';

    assert.throws(() => buildReportArtifact(projectRoot, changed));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
