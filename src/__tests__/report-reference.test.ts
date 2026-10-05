import { formatMissingReportReference } from '../core/workflow/instruction/report-reference.js';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTemplatePlaceholders, replaceTemplatePlaceholders } from '../core/workflow/instruction/escape.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const injectedFsError = vi.hoisted(() => ({
  operation: '' as '' | 'lstat' | 'realpath' | 'readFile',
  path: '',
  error: undefined as NodeJS.ErrnoException | undefined,
  beforeRead: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], options?: Parameters<typeof actual.lstatSync>[1]) => {
      if (injectedFsError.operation === 'lstat'
        && String(path) === injectedFsError.path
        && injectedFsError.error !== undefined) {
        throw injectedFsError.error;
      }
      return actual.lstatSync(path, options as never);
    }) as typeof actual.lstatSync,
    realpathSync: ((path: Parameters<typeof actual.realpathSync>[0], options?: Parameters<typeof actual.realpathSync>[1]) => {
      if (injectedFsError.operation === 'realpath'
        && String(path) === injectedFsError.path
        && injectedFsError.error !== undefined) {
        throw injectedFsError.error;
      }
      return actual.realpathSync(path, options as never);
    }) as typeof actual.realpathSync,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const beforeRead = injectedFsError.beforeRead;
      injectedFsError.beforeRead = undefined;
      beforeRead?.();
      if (injectedFsError.operation === 'readFile'
        && injectedFsError.error !== undefined) {
        const error = injectedFsError.error;
        injectedFsError.operation = '';
        throw error;
      }
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});
import { resolveReportReferenceDetailed } from '../core/workflow/instruction/report-reference.js';
import { inheritResumeReportSnapshot } from '../core/workflow/run/resume-report-snapshot.js';

describe('resolveReportReferenceDetailed', () => {
  const temporaryDirectories: string[] = [];

  it.each([
    { producer: 'current', expected: 'CURRENT', scope: 'step' },
    { producer: 'parent', expected: 'NEAR', scope: 'parent-run-readonly' },
    { producer: 'ancestor', expected: 'ANCESTOR', scope: 'parent-run-readonly' },
    { producer: 'root', expected: 'ROOT', scope: 'parent-run-readonly' },
  ] as const)('embeds the nearest available report in a deeply nested instruction ($producer)', ({ producer, expected, scope }) => {
    const reports = join(makeTemporaryDirectory(), 'reports');
    const ancestor = join(reports, 'subworkflows', 'outer');
    const parent = join(ancestor, 'subworkflows', 'middle');
    const current = join(parent, 'subworkflows', 'inner');
    mkdirSync(current, { recursive: true });
    writeFileSync(join(reports, 'summary.md'), 'ROOT');
    if (producer !== 'root') writeFileSync(join(ancestor, 'summary.md'), 'ANCESTOR');
    if (producer === 'parent' || producer === 'current') writeFileSync(join(parent, 'summary.md'), 'NEAR');
    if (producer === 'current') writeFileSync(join(current, 'summary.md'), 'CURRENT');
    const step = makeStep({ instruction: '{report:summary.md}' });

    const prepared = new InstructionBuilder(step, makeInstructionContext({
      reportDir: current, reportsRootDir: reports,
    })).prepare();

    expect(prepared.injectedReports).toEqual([{ reference: 'summary.md', content: expected, scope }]);
    expect(prepared.text).toContain(expected);
    for (const other of ['CURRENT', 'NEAR', 'ANCESTOR', 'ROOT'].filter((body) => body !== expected)) {
      expect(prepared.text).not.toContain(other);
    }
  });

  it('does not search ancestors through a malformed namespace structure', () => {
    const reports = join(makeTemporaryDirectory(), 'reports');
    const current = join(reports, 'subworkflows', 'parent', 'extra', 'grandchild');
    mkdirSync(current, { recursive: true });
    writeFileSync(join(reports, 'summary.md'), 'ROOT');
    const step = makeStep({ instruction: '{report:summary.md}' });

    const prepared = new InstructionBuilder(step, makeInstructionContext({
      reportDir: current, reportsRootDir: reports,
    })).prepare();

    expect(prepared.injectedReports).toEqual([{
      reference: 'summary.md', scope: 'missing', content: formatMissingReportReference('summary.md'),
    }]);
    expect(prepared.text).toContain(formatMissingReportReference('summary.md'));
    expect(prepared.text).not.toContain('ROOT');
  });

  it.each(['../plan.md', 'resume-artifacts.json'])('rejects an invalid child reference before ancestor fallback (%s)', (reference) => {
    const reports = join(makeTemporaryDirectory(), 'reports');
    const current = join(reports, 'subworkflows', 'child');
    mkdirSync(current, { recursive: true });
    writeFileSync(join(reports, 'plan.md'), 'PARENT');
    writeFileSync(join(reports, 'resume-artifacts.json'), '{}');

    expect(() => resolveReportReferenceDetailed(current, reference, {
      stepName: 'work', reportsRootDir: reports,
    })).toThrow();
  });

  it('rejects a child symlink before reading an ancestor report of the same name', () => {
    const directory = makeTemporaryDirectory();
    const reports = join(directory, 'reports');
    const current = join(reports, 'subworkflows', 'child');
    const external = join(directory, 'external');
    mkdirSync(current, { recursive: true });
    mkdirSync(external);
    mkdirSync(join(reports, 'linked'));
    writeFileSync(join(external, 'plan.md'), 'EXTERNAL');
    writeFileSync(join(reports, 'linked', 'plan.md'), 'ANCESTOR');
    symlinkSync(external, join(current, 'linked'));

    expect(() => resolveReportReferenceDetailed(current, 'linked/plan.md', {
      stepName: 'work', reportsRootDir: reports,
    })).toThrow(/symlink/);
  });

  it.each(['A', 'B'])('embeds only the current branch report when siblings share its name (%s)', (branch) => {
    const reports = join(makeTemporaryDirectory(), 'reports');
    const parent = join(reports, 'subworkflows', 'parent');
    for (const name of ['A', 'B']) {
      const directory = join(parent, 'subworkflows', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'review.md'), `REVIEW-${name}`);
    }
    writeFileSync(join(parent, 'review.md'), 'PARENT');
    const step = makeStep({ instruction: '{report:review.md}' });

    const prepared = new InstructionBuilder(step, makeInstructionContext({
      reportDir: join(parent, 'subworkflows', branch), reportsRootDir: reports,
    })).prepare();

    expect(prepared.injectedReports).toEqual([{ reference: 'review.md', scope: 'step', content: `REVIEW-${branch}` }]);
    expect(prepared.text).toContain(`REVIEW-${branch}`);
    expect(prepared.text).not.toContain(`REVIEW-${branch === 'A' ? 'B' : 'A'}`);
    expect(prepared.text).not.toContain('PARENT');
  });

  it.each(['A', 'B'])('does not fill a missing branch report from a sibling (%s)', (branch) => {
    const reports = join(makeTemporaryDirectory(), 'reports');
    const parent = join(reports, 'subworkflows', 'parent');
    const sibling = branch === 'A' ? 'B' : 'A';
    for (const name of ['A', 'B']) mkdirSync(join(parent, 'subworkflows', name), { recursive: true });
    writeFileSync(join(parent, 'subworkflows', sibling, 'review.md'), `REVIEW-${sibling}`);
    const step = makeStep({ instruction: '{report:review.md}' });

    const prepared = new InstructionBuilder(step, makeInstructionContext({
      reportDir: join(parent, 'subworkflows', branch), reportsRootDir: reports,
    })).prepare();

    expect(prepared.injectedReports).toEqual([{
      reference: 'review.md', scope: 'missing', content: formatMissingReportReference('review.md'),
    }]);
    expect(prepared.text).toContain(formatMissingReportReference('review.md'));
    expect(prepared.text).not.toContain(`REVIEW-${sibling}`);
  });

  it('leaves future report references literal during evidence preparation without injecting their bodies', () => {
    const reports = join(makeTemporaryDirectory(), 'reports');
    mkdirSync(reports);
    writeFileSync(join(reports, 'upstream.md'), 'NOT-A-PHASE1-INPUT');
    const step = makeStep({
      instruction: 'Perform work.',
      outputContracts: [{ name: 'result.md', format: '{report:result.md}\n{report:upstream.md}', order: 'Write to {report_dir}.' }],
    });
    const prepared = new InstructionBuilder(step, makeInstructionContext({ reportDir: reports })).prepare();
    expect(prepared.text).toContain('{report:result.md}');
    expect(prepared.text).toContain('{report:upstream.md}');
    expect(prepared.text).not.toContain('NOT-A-PHASE1-INPUT');
    expect(prepared.injectedReports).toEqual([]);
    expect(prepared.text).not.toContain(formatMissingReportReference('result.md'));
  });

  it.each(['after_execution_rules', 'before_instruction'] as const)('preserves rule report bodies without carrying the rule into Phase 2 (%s)', (position) => {
    const reports = join(makeTemporaryDirectory(), 'reports');
    const childReports = join(reports, 'subworkflows', 'child');
    mkdirSync(childReports, { recursive: true });
    const path = join(reports, 'requirements.md');
    writeFileSync(path, 'RULE-CONTRACT: preserve the record identity.');
    const step = makeStep({ instruction: 'Perform current work.', outputContracts: [{ name: 'result.md', format: '' }] });
    const context = makeInstructionContext({
      reportDir: childReports, reportsRootDir: reports,
      workflowRules: [{ ref: 'source-rule', position, content: 'RULE-ONLY-INSTRUCTION\n{report:requirements.md}\n{report: requirements.md }' }],
    });
    const prepared = new InstructionBuilder(step, context).prepare();
    expect(prepared.injectedReports).toEqual([{ reference: 'requirements.md', scope: 'parent-run-readonly', content: 'RULE-CONTRACT: preserve the record identity.' }]);
    const duplicated = new InstructionBuilder({ ...step, instruction: '{report:requirements.md}' }, context).prepare();
    expect(duplicated.injectedReports).toEqual(prepared.injectedReports);
    rmSync(path);
    const prompt = new ReportInstructionBuilder(step, {
      cwd: context.cwd, reportDir: childReports, stepIteration: 1, injectedReports: prepared.injectedReports,
    }).build();
    const records = prompt.split('\n').filter((line) => line.startsWith('{"reference":')).map((line) => JSON.parse(line));
    expect(records).toEqual(prepared.injectedReports);
    expect(prompt).not.toContain('RULE-ONLY-INSTRUCTION');
  });

  it('keeps the injected parent body after modification and deletion, but refreshes on new preparation', () => {
    const reports = join(makeTemporaryDirectory(), 'reports');
    const childReports = join(reports, 'subworkflows', 'child');
    mkdirSync(childReports, { recursive: true });
    const path = join(reports, 'requirements.md');
    const original = 'REQ-A: preserve work\n{report:unrelated.md}\n{{#if hidden}}literal{{/if}}';
    writeFileSync(path, original);
    const step = makeStep({ instruction: '{report:requirements.md}\n{report: requirements.md }', outputContracts: [{ name: 'result.md', format: '' }] });
    const context = makeInstructionContext({ reportDir: childReports, reportsRootDir: reports });
    const prepared = new InstructionBuilder(step, context).prepare();
    expect(prepared.injectedReports).toEqual([{ reference: 'requirements.md', scope: 'parent-run-readonly', content: original }]);
    expect(prepared.text).toContain(original);
    writeFileSync(path, 'updated requirements');
    expect(new InstructionBuilder(step, context).prepare().injectedReports[0]?.content).toBe('updated requirements');
    rmSync(path);
    const reportPrompt = new ReportInstructionBuilder(step, {
      cwd: context.cwd, reportDir: childReports, stepIteration: 1,
      injectedReports: prepared.injectedReports,
    }).build();
    const records = reportPrompt.split('\n').filter((line) => line.startsWith('{"reference":')).map((line) => JSON.parse(line));
    expect(records).toEqual(prepared.injectedReports);
  });

  it('retains missing references and does not collect preview paths or unreferenced files', () => {
    const reports = join(makeTemporaryDirectory(), 'reports');
    mkdirSync(reports);
    writeFileSync(join(reports, 'unused.md'), 'not injected');
    const step = makeStep({ instruction: '{report:absent.md}' });
    const context = makeInstructionContext({ reportDir: reports });
    const prepared = prepareTemplatePlaceholders(step.instruction, step, context);
    expect(prepared.injectedReports).toEqual([{ reference: 'absent.md', scope: 'missing', content: prepared.text }]);
    writeFileSync(join(reports, 'absent.md'), 'created later');
    expect(prepared.injectedReports[0]?.scope).toBe('missing');
    expect(prepareTemplatePlaceholders(step.instruction, step, context).injectedReports[0]?.content).toBe('created later');
    expect(prepareTemplatePlaceholders(step.instruction, step, { ...context, validateReportReferences: false }).injectedReports).toEqual([]);
    expect(prepareTemplatePlaceholders('no references', step, context).injectedReports).toEqual([]);
  });

  it.each(['en', 'ja'] as const)('leaves a report with no injected references unchanged (%s)', (language) => {
    const step = makeStep({ outputContracts: [{ name: 'result.md', format: '' }] });
    const context = { cwd: '/project', reportDir: '/project/reports', stepIteration: 1, language };
    const withoutSnapshot = new ReportInstructionBuilder(step, context).build();
    expect(new ReportInstructionBuilder(step, { ...context, injectedReports: [] }).build()).toBe(withoutSnapshot);
  });

  afterEach(() => {
    injectedFsError.operation = '';
    injectedFsError.path = '';
    injectedFsError.error = undefined;
    injectedFsError.beforeRead = undefined;
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  it.each(['ENOENT', 'ENOTDIR'])(
    '%s は欠落として分類する',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, 'reports');
      mkdirSync(reports);
      injectedFsError.operation = 'lstat';
      injectedFsError.path = join(reports, 'review.md');
      injectedFsError.error = Object.assign(new Error(`injected ${code}`), { code });

      expect(resolveReportReferenceDetailed(reports, 'review.md', {
        stepName: 'consumer',
      })).toEqual({
        content: formatMissingReportReference('review.md'),
        scope: 'missing',
      });
    },
  );

  it.each(['ENOENT', 'ENOTDIR'])(
    'realpath の %s は欠落として分類する',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, 'reports');
      const report = join(reports, 'review.md');
      mkdirSync(reports);
      writeFileSync(report, 'child report');
      injectedFsError.operation = 'realpath';
      injectedFsError.path = report;
      injectedFsError.error = Object.assign(new Error(`injected ${code}`), { code });

      expect(resolveReportReferenceDetailed(reports, 'review.md', {
        stepName: 'consumer',
      })).toEqual({
        content: formatMissingReportReference('review.md'),
        scope: 'missing',
      });
    },
  );

  it.each(['EACCES', 'EPERM', 'EIO'])(
    '%s は元エラーを伝播する',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, 'reports');
      mkdirSync(reports);
      const error = Object.assign(new Error(`injected ${code}`), { code });
      injectedFsError.operation = 'lstat';
      injectedFsError.path = join(reports, 'review.md');
      injectedFsError.error = error;

      let thrown: unknown;
      try {
        resolveReportReferenceDetailed(reports, 'review.md', { stepName: 'consumer' });
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBe(error);
    },
  );

  it.each(['EACCES', 'EPERM', 'EIO'])(
    'realpath の %s は元エラーを伝播し親成果物へフォールバックしない',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, 'reports');
      const childReports = join(reports, 'subworkflows', 'child');
      const childReport = join(childReports, 'review.md');
      mkdirSync(childReports, { recursive: true });
      writeFileSync(childReport, 'child report');
      writeFileSync(join(reports, 'review.md'), 'parent report');
      const error = Object.assign(new Error(`injected ${code}`), { code });
      injectedFsError.operation = 'realpath';
      injectedFsError.path = childReport;
      injectedFsError.error = error;

      let thrown: unknown;
      try {
        resolveReportReferenceDetailed(childReports, 'review.md', {
          stepName: 'consumer',
          reportsRootDir: reports,
        });
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBe(error);
    },
  );

  it.each(['ENOENT', 'ENOTDIR'])(
    '子 report の lstat が %s の場合だけ親成果物へフォールバックする',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, 'reports');
      const childReports = join(reports, 'subworkflows', 'child');
      mkdirSync(childReports, { recursive: true });
      writeFileSync(join(reports, 'review.md'), 'parent report');
      injectedFsError.operation = 'lstat';
      injectedFsError.path = join(childReports, 'review.md');
      injectedFsError.error = Object.assign(new Error(`injected ${code}`), { code });

      expect(resolveReportReferenceDetailed(childReports, 'review.md', {
        stepName: 'consumer',
        reportsRootDir: reports,
      })).toEqual({
        content: 'parent report',
        scope: 'parent-run-readonly',
      });
    },
  );

  it.each(['ENOENT', 'ENOTDIR'])(
    '子 report の realpath が %s の場合だけ親成果物へフォールバックする',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, 'reports');
      const childReports = join(reports, 'subworkflows', 'child');
      const childReport = join(childReports, 'review.md');
      mkdirSync(childReports, { recursive: true });
      writeFileSync(childReport, 'child report');
      writeFileSync(join(reports, 'review.md'), 'parent report');
      injectedFsError.operation = 'realpath';
      injectedFsError.path = childReport;
      injectedFsError.error = Object.assign(new Error(`injected ${code}`), { code });

      expect(resolveReportReferenceDetailed(childReports, 'review.md', {
        stepName: 'consumer',
        reportsRootDir: reports,
      })).toEqual({
        content: 'parent report',
        scope: 'parent-run-readonly',
      });
    },
  );

  it.each(['ENOENT', 'ENOTDIR'])(
    '子 report の本文読み込みが %s の場合だけ親成果物へフォールバックする',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, 'reports');
      const childReports = join(reports, 'subworkflows', 'child');
      mkdirSync(childReports, { recursive: true });
      writeFileSync(join(childReports, 'review.md'), 'child report');
      writeFileSync(join(reports, 'review.md'), 'parent report');
      injectedFsError.operation = 'readFile';
      injectedFsError.error = Object.assign(new Error(`injected ${code}`), { code });

      expect(resolveReportReferenceDetailed(childReports, 'review.md', {
        stepName: 'consumer',
        reportsRootDir: reports,
      })).toEqual({
        content: 'parent report',
        scope: 'parent-run-readonly',
      });
    },
  );

  it.each(['EACCES', 'EPERM', 'EIO'])(
    '子 report の本文読み込みの %s は親成果物へフォールバックせず伝播する',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, 'reports');
      const childReports = join(reports, 'subworkflows', 'child');
      mkdirSync(childReports, { recursive: true });
      writeFileSync(join(childReports, 'review.md'), 'child report');
      writeFileSync(join(reports, 'review.md'), 'parent report');
      const error = Object.assign(new Error(`injected ${code}`), { code });
      injectedFsError.operation = 'readFile';
      injectedFsError.error = error;

      expect(() => resolveReportReferenceDetailed(childReports, 'review.md', {
        stepName: 'consumer',
        reportsRootDir: reports,
      })).toThrow(error);
    },
  );

  it('子レポートの非欠落エラーでは親成果物へフォールバックしない', () => {
    const root = makeTemporaryDirectory();
    const reports = join(root, 'reports');
    const childReports = join(reports, 'subworkflows', 'child');
    mkdirSync(childReports, { recursive: true });
    writeFileSync(join(reports, 'review.md'), 'parent report');
    const error = Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
    injectedFsError.operation = 'lstat';
    injectedFsError.path = join(childReports, 'review.md');
    injectedFsError.error = error;

    let thrown: unknown;
    try {
      resolveReportReferenceDetailed(childReports, 'review.md', {
        stepName: 'consumer',
        reportsRootDir: reports,
      });
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);
  });

  it('子 report が非通常ファイルの場合は親成果物へフォールバックしない', () => {
    const root = makeTemporaryDirectory();
    const reports = join(root, 'reports');
    const childReports = join(reports, 'subworkflows', 'child');
    mkdirSync(join(childReports, 'review.md'), { recursive: true });
    writeFileSync(join(reports, 'review.md'), 'parent report');

    expect(() => resolveReportReferenceDetailed(childReports, 'review.md', {
      stepName: 'consumer',
      reportsRootDir: reports,
    })).toThrow(/not a regular file/);
  });

  it('resume manifest の ENOTDIR は report 欠落として続行する', () => {
    const root = makeTemporaryDirectory();
    const reports = join(root, '.takt', 'runs', 'run-1', 'reports');
    mkdirSync(reports, { recursive: true });
    injectedFsError.operation = 'lstat';
    injectedFsError.path = join(reports, 'resume-artifacts.json');
    injectedFsError.error = Object.assign(new Error('injected ENOTDIR'), { code: 'ENOTDIR' });

    expect(resolveReportReferenceDetailed(reports, 'review.md', {
      stepName: 'consumer',
      reportsRootDir: reports,
      resumeReportConsumerKey: '{"workflow":"root","step":"consumer","calls":[]}',
    })).toEqual({
      content: formatMissingReportReference('review.md'),
      scope: 'missing',
    });
  });

  it('current step に同名 report が無い場合は root の同名 report より snapshot exact mapping を優先する', () => {
    const root = makeTemporaryDirectory();
    const sourceReports = join(root, '.takt', 'runs', 'source-run', 'reports');
    const exactPath = 'subworkflows/old-peer/review-resolution.md';
    const consumerKey = '{"workflow":"review-gate","step":"final-gate","calls":[]}';
    mkdirSync(join(sourceReports, 'subworkflows', 'old-peer'), { recursive: true });
    writeFileSync(join(sourceReports, 'review-resolution.md'), 'WRONG ROOT');
    writeFileSync(join(sourceReports, ...exactPath.split('/')), 'EXACT SOURCE');
    inheritResumeReportSnapshot({
      cwd: root,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'run-1',
      resumeReportConsumers: [{
        consumerKey,
        reportDirectories: ['subworkflows/old-peer'],
        references: [{ reference: 'review-resolution.md', path: exactPath }],
      }],
    });
    const reports = join(root, '.takt', 'runs', 'run-1', 'reports');
    const currentReports = join(reports, 'subworkflows', 'new-peer');
    mkdirSync(currentReports, { recursive: true });

    expect(resolveReportReferenceDetailed(currentReports, 'review-resolution.md', {
      stepName: 'final-gate',
      reportsRootDir: reports,
      resumeReportConsumerKey: consumerKey,
    })).toEqual({
      content: 'EXACT SOURCE',
      scope: 'resume-snapshot-readonly',
    });
    const step = makeStep({ instruction: 'Perform resumed work.', outputContracts: [{ name: 'result.md', format: '' }] });
    const prepared = new InstructionBuilder(step, makeInstructionContext({
      reportDir: currentReports, reportsRootDir: reports, resumeReportConsumerKey: consumerKey,
      workflowRules: [{ ref: 'resumed-source', position: 'before_instruction', content: '{report:review-resolution.md}' }],
    })).prepare();
    expect(prepared.injectedReports).toEqual([{ reference: 'review-resolution.md', scope: 'resume-snapshot-readonly', content: 'EXACT SOURCE' }]);
    const prompt = new ReportInstructionBuilder(step, {
      cwd: root, reportDir: currentReports, stepIteration: 1, injectedReports: prepared.injectedReports,
    }).build();
    expect(prompt.split('\n').filter((line) => line.startsWith('{"reference":')).map((line) => JSON.parse(line))).toEqual(prepared.injectedReports);
  });

  it.each(['EACCES', 'EPERM', 'EIO'])(
    'resume manifest の %s は元エラーを伝播する',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, '.takt', 'runs', 'run-1', 'reports');
      mkdirSync(reports, { recursive: true });
      const error = Object.assign(new Error(`injected ${code}`), { code });
      injectedFsError.operation = 'lstat';
      injectedFsError.path = join(reports, 'resume-artifacts.json');
      injectedFsError.error = error;

      let thrown: unknown;
      try {
        resolveReportReferenceDetailed(reports, 'review.md', {
          stepName: 'consumer',
          reportsRootDir: reports,
          resumeReportConsumerKey: '{"workflow":"root","step":"consumer","calls":[]}',
        });
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBe(error);
    },
  );

  it.each(['ENOENT', 'ENOTDIR'])(
    'resume manifest 読み込みの %s は report 欠落として続行する',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, '.takt', 'runs', 'run-1', 'reports');
      mkdirSync(reports, { recursive: true });
      writeFileSync(join(reports, 'resume-artifacts.json'), '{}');
      injectedFsError.operation = 'readFile';
      injectedFsError.error = Object.assign(new Error(`injected ${code}`), { code });

      expect(resolveReportReferenceDetailed(reports, 'review.md', {
        stepName: 'consumer',
        reportsRootDir: reports,
        resumeReportConsumerKey: '{"workflow":"root","step":"consumer","calls":[]}',
      })).toEqual({
        content: formatMissingReportReference('review.md'),
        scope: 'missing',
      });
    },
  );

  it.each(['EACCES', 'EPERM', 'EIO'])(
    'resume manifest 読み込みの %s は元エラーを伝播する',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, '.takt', 'runs', 'run-1', 'reports');
      mkdirSync(reports, { recursive: true });
      writeFileSync(join(reports, 'resume-artifacts.json'), '{}');
      const error = Object.assign(new Error(`injected ${code}`), { code });
      injectedFsError.operation = 'readFile';
      injectedFsError.error = error;

      let thrown: unknown;
      try {
        resolveReportReferenceDetailed(reports, 'review.md', {
          stepName: 'consumer',
          reportsRootDir: reports,
          resumeReportConsumerKey: '{"workflow":"root","step":"consumer","calls":[]}',
        });
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBe(error);
    },
  );

  function makeTemporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'takt-report-reference-'));
    temporaryDirectories.push(directory);
    return directory;
  }

  it('step 参照の親ディレクトリにある symlink を拒否する', () => {
    const root = makeTemporaryDirectory();
    const reports = join(root, 'reports');
    const external = join(root, 'external');
    mkdirSync(reports);
    mkdirSync(external);
    writeFileSync(join(external, 'review.md'), 'outside');
    symlinkSync(external, join(reports, 'linked'));

    expect(() => resolveReportReferenceDetailed(reports, 'linked/review.md', {
      stepName: 'consumer',
    })).toThrow(/symlink/);
  });

  it('parent-run fallback の親ディレクトリにある symlink を拒否する', () => {
    const root = makeTemporaryDirectory();
    const reports = join(root, 'reports');
    const childReports = join(reports, 'subworkflows', 'child');
    const external = join(root, 'external');
    mkdirSync(childReports, { recursive: true });
    mkdirSync(external);
    writeFileSync(join(external, 'review.md'), 'outside');
    symlinkSync(external, join(reports, 'linked'));

    expect(() => resolveReportReferenceDetailed(childReports, 'linked/review.md', {
      stepName: 'consumer',
      reportsRootDir: reports,
    })).toThrow(/symlink/);
  });

  it('reports root から step reportDir までの祖先 symlink を拒否する', () => {
    const root = makeTemporaryDirectory();
    const reports = join(root, 'reports');
    const external = join(root, 'external-child');
    mkdirSync(join(reports, 'subworkflows'), { recursive: true });
    mkdirSync(external);
    writeFileSync(join(external, 'review.md'), 'outside');
    symlinkSync(external, join(reports, 'subworkflows', 'child'));

    expect(() => resolveReportReferenceDetailed(
      join(reports, 'subworkflows', 'child'),
      'review.md',
      {
        stepName: 'consumer',
        reportsRootDir: reports,
      },
    )).toThrow(/symlink/);
  });

  it('検証後に祖先が交換されても外部 report 内容を展開しない', () => {
    const root = makeTemporaryDirectory();
    const reports = join(root, 'reports');
    const originalReports = join(root, 'original-reports');
    const outsideReports = join(root, 'outside-reports');
    mkdirSync(reports);
    mkdirSync(outsideReports);
    writeFileSync(join(reports, 'review.md'), 'inside report');
    writeFileSync(join(outsideReports, 'review.md'), 'outside secret');
    injectedFsError.beforeRead = () => {
      renameSync(reports, originalReports);
      symlinkSync(outsideReports, reports, 'dir');
    };

    expect(resolveReportReferenceDetailed(reports, 'review.md', {
      stepName: 'consumer',
    })).toEqual({ content: 'inside report', scope: 'step' });
  });
});

describe('report handle removal', () => {
  const REMOVED_PLACEHOLDERS = [
    '{current_report}',
    '{previous_report}',
    '{peer_reports}',
    '{report_history}',
  ] as const;

  let reportDir: string;

  beforeEach(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'takt-report-handle-removal-'));
  });

  afterEach(() => {
    rmSync(reportDir, { recursive: true, force: true });
  });

  it('removes legacy instruction variables while retaining report content interpolation', () => {
    writeFileSync(join(reportDir, 'review.md'), 'inherited review body', 'utf-8');
    const template = REMOVED_PLACEHOLDERS.join('|');
    const legacyRendered = replaceTemplatePlaceholders(
      template,
      makeStep(),
      makeInstructionContext({ reportDir }),
    );
    const reportRendered = replaceTemplatePlaceholders(
      'Inherited report: {report:review.md}',
      makeStep(),
      makeInstructionContext({ reportDir }),
    );

    expect(legacyRendered).toBe(template);
    expect(reportRendered).toBe('Inherited report: inherited review body');
  });
});
