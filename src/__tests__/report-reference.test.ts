import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('resolveReportReferenceDetailed', () => {
  const temporaryDirectories: string[] = [];

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

      expect(() => resolveReportReferenceDetailed(reports, 'review.md', {
        stepName: 'consumer',
      })).toThrow(/has not been produced/);
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

      expect(() => resolveReportReferenceDetailed(reports, 'review.md', {
        stepName: 'consumer',
      })).toThrow(/has not been produced/);
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

  it('resume manifest の ENOTDIR は元の report 欠落エラーを維持する', () => {
    const root = makeTemporaryDirectory();
    const reports = join(root, '.takt', 'runs', 'run-1', 'reports');
    mkdirSync(reports, { recursive: true });
    injectedFsError.operation = 'lstat';
    injectedFsError.path = join(reports, 'resume-artifacts.json');
    injectedFsError.error = Object.assign(new Error('injected ENOTDIR'), { code: 'ENOTDIR' });

    expect(() => resolveReportReferenceDetailed(reports, 'review.md', {
      stepName: 'consumer',
    })).toThrow(/has not been produced/);
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
        resolveReportReferenceDetailed(reports, 'review.md', { stepName: 'consumer' });
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBe(error);
    },
  );

  it.each(['ENOENT', 'ENOTDIR'])(
    'resume manifest 読み込みの %s は元の report 欠落エラーを維持する',
    (code) => {
      const root = makeTemporaryDirectory();
      const reports = join(root, '.takt', 'runs', 'run-1', 'reports');
      mkdirSync(reports, { recursive: true });
      writeFileSync(join(reports, 'resume-artifacts.json'), '{}');
      injectedFsError.operation = 'readFile';
      injectedFsError.error = Object.assign(new Error(`injected ${code}`), { code });

      expect(() => resolveReportReferenceDetailed(reports, 'review.md', {
        stepName: 'consumer',
      })).toThrow(/has not been produced/);
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
        resolveReportReferenceDetailed(reports, 'review.md', { stepName: 'consumer' });
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
