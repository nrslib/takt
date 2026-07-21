/**
 * resume 時の run artifact（reports/）継承 — manifest 付きスナップショットの
 * 単体テスト（v3-r4 の resume 境界バグの再発防止）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

// 公開・manifest 保存境界への障害注入と、並行 resume の競合シミュレーション用の
// フック。既定は実 fs へのパススルー。
const fsControl = vi.hoisted(() => ({
  failRenameToPredicate: undefined as ((dest: string) => boolean) | undefined,
  emptyReaddirOncePath: undefined as string | undefined,
  failRmForPrefix: undefined as string | undefined,
  failLstatForPath: undefined as string | undefined,
  beforeOpenPath: undefined as string | undefined,
  beforeOpen: undefined as (() => void) | undefined,
  beforeDirectoryPublication: undefined as (() => void) | undefined,
  beforeReaddirPath: undefined as string | undefined,
  beforeReaddir: undefined as (() => void) | undefined,
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync(...args: Parameters<typeof actual.spawnSync>) {
      const commandArguments = args[1];
      const rawRequest = Array.isArray(commandArguments) ? commandArguments[2] : undefined;
      if (typeof rawRequest === 'string' && rawRequest.includes('"operation":"publish-directory"')) {
        const beforePublication = fsControl.beforeDirectoryPublication;
        fsControl.beforeDirectoryPublication = undefined;
        beforePublication?.();
        const request = JSON.parse(rawRequest) as { targetName: string };
        const options = args[2];
        if (typeof options === 'object' && options !== null && typeof options.cwd === 'string') {
          const targetPath = join(options.cwd, request.targetName);
          if (fsControl.failRenameToPredicate?.(targetPath)) {
            throw Object.assign(new Error(`injected rename failure: ${targetPath}`), { code: 'EIO' });
          }
        }
      }
      return actual.spawnSync(...args);
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((path: Parameters<typeof actual.openSync>[0], ...args: unknown[]) => {
      if (fsControl.beforeOpenPath === String(path)) {
        fsControl.beforeOpenPath = undefined;
        const beforeOpen = fsControl.beforeOpen;
        fsControl.beforeOpen = undefined;
        beforeOpen?.();
      }
      return Reflect.apply(actual.openSync, actual, [path, ...args]) as number;
    }) as typeof actual.openSync,
    lstatSync: ((path: Parameters<typeof actual.lstatSync>[0], options?: Parameters<typeof actual.lstatSync>[1]) => {
      if (fsControl.failLstatForPath === String(path)) {
        const error = new Error(`permission denied: ${String(path)}`) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return actual.lstatSync(path, options as never);
    }) as typeof actual.lstatSync,
    renameSync: ((src: Parameters<typeof actual.renameSync>[0], dest: Parameters<typeof actual.renameSync>[1]) => {
      if (fsControl.failRenameToPredicate?.(String(dest))) {
        throw new Error(`injected rename failure: ${String(dest)}`);
      }
      return actual.renameSync(src, dest);
    }) as typeof actual.renameSync,
    rmSync: ((path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
      if (fsControl.failRmForPrefix !== undefined && String(path).startsWith(fsControl.failRmForPrefix)) {
        throw new Error(`injected rm failure: ${String(path)}`);
      }
      return actual.rmSync(path, options);
    }) as typeof actual.rmSync,
    readdirSync: ((path: Parameters<typeof actual.readdirSync>[0], options?: unknown) => {
      if (fsControl.beforeReaddirPath === String(path)) {
        fsControl.beforeReaddirPath = undefined;
        const beforeReaddir = fsControl.beforeReaddir;
        fsControl.beforeReaddir = undefined;
        beforeReaddir?.();
      }
      if (fsControl.emptyReaddirOncePath !== undefined && String(path) === fsControl.emptyReaddirOncePath) {
        fsControl.emptyReaddirOncePath = undefined;
        return [];
      }
      return (actual.readdirSync as (p: unknown, o?: unknown) => unknown)(path, options);
    }) as typeof actual.readdirSync,
  };
});

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  inheritResumeReportSnapshot,
  readResumeReportSnapshotManifest,
  RESUME_ARTIFACTS_FILE_NAME,
  ResumeReportSnapshotSourceError,
} from '../core/workflow/run/resume-report-snapshot.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { writeReportFile } from '../core/workflow/report-writer.js';

const TEST_TMPDIR = realpathSync(tmpdir());

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('inheritResumeReportSnapshot', () => {
  let cwd: string;

  beforeEach(() => {
    fsControl.failRenameToPredicate = undefined;
    fsControl.emptyReaddirOncePath = undefined;
    fsControl.failRmForPrefix = undefined;
    fsControl.failLstatForPath = undefined;
    fsControl.beforeOpenPath = undefined;
    fsControl.beforeOpen = undefined;
    fsControl.beforeDirectoryPublication = undefined;
    fsControl.beforeReaddirPath = undefined;
    fsControl.beforeReaddir = undefined;
    cwd = mkdtempSync(join(TEST_TMPDIR, 'takt-resume-snapshot-'));
  });

  afterEach(() => {
    fsControl.failRenameToPredicate = undefined;
    fsControl.emptyReaddirOncePath = undefined;
    fsControl.failRmForPrefix = undefined;
    fsControl.failLstatForPath = undefined;
    fsControl.beforeOpenPath = undefined;
    fsControl.beforeOpen = undefined;
    fsControl.beforeDirectoryPublication = undefined;
    fsControl.beforeReaddirPath = undefined;
    fsControl.beforeReaddir = undefined;
    rmSync(cwd, { recursive: true, force: true });
  });

  function expectNoLeftovers(targetSlug: string): void {
    const targetPaths = buildRunPaths(cwd, targetSlug);
    if (!existsSync(targetPaths.runRootAbs)) {
      return;
    }
    const leftovers = readdirSync(targetPaths.runRootAbs)
      .filter((name) => name.startsWith('.reports-inherit-tmp-') || name.includes(`${RESUME_ARTIFACTS_FILE_NAME}.tmp-`));
    expect(leftovers).toEqual([]);
  }

  function captureError(operation: () => void): Error {
    try {
      operation();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      return error as Error;
    }
    throw new Error('Expected operation to throw');
  }

  function seedSourceRun(slug: string, files: Record<string, string>): void {
    const paths = buildRunPaths(cwd, slug);
    mkdirSync(paths.reportsAbs, { recursive: true });
    writeFileSync(join(paths.runRootAbs, 'meta.json'), '{}');
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(paths.reportsAbs, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content);
    }
  }

  it('copies every file (nested dirs and versioned history included) with matching hashes', () => {
    seedSourceRun('source-run', {
      'plan.md': 'the plan',
      'ai-antipattern-review-1st.md': 'first review',
      'ai-antipattern-review-1st.md.20260701T010101Z': 'older review',
      'nested/sub-report.md': 'nested report',
    });

    const manifest = inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    });

    const targetReports = buildRunPaths(cwd, 'target-run').reportsAbs;
    expect(readFileSync(join(targetReports, 'plan.md'), 'utf-8')).toBe('the plan');
    expect(readFileSync(join(targetReports, 'ai-antipattern-review-1st.md'), 'utf-8')).toBe('first review');
    expect(readFileSync(join(targetReports, 'ai-antipattern-review-1st.md.20260701T010101Z'), 'utf-8')).toBe('older review');
    expect(readFileSync(join(targetReports, 'nested/sub-report.md'), 'utf-8')).toBe('nested report');

    expect(manifest.version).toBe(1);
    expect(manifest.sourceRunSlug).toBe('source-run');
    expect(manifest.targetRunSlug).toBe('target-run');
    expect(manifest.files.map((f) => f.path)).toEqual([
      'ai-antipattern-review-1st.md',
      'ai-antipattern-review-1st.md.20260701T010101Z',
      'nested/sub-report.md',
      'plan.md',
    ]);
    for (const entry of manifest.files) {
      const content = readFileSync(join(targetReports, entry.path));
      expect(entry.sha256).toBe(sha256(content));
      expect(entry.size).toBe(content.length);
    }

    // manifest（SSOT）は新 run 直下に保存される。
    const persisted = readResumeReportSnapshotManifest(cwd, 'target-run');
    expect(persisted).toEqual(manifest);
  });

  it('leaves the source run untouched', () => {
    seedSourceRun('source-run', { 'plan.md': 'the plan' });
    const sourceReports = buildRunPaths(cwd, 'source-run').reportsAbs;
    const before = readdirSync(sourceReports).sort();

    inheritResumeReportSnapshot({ cwd, sourceRunSlug: 'source-run', targetRunSlug: 'target-run' });

    expect(readdirSync(sourceReports).sort()).toEqual(before);
    expect(readFileSync(join(sourceReports, 'plan.md'), 'utf-8')).toBe('the plan');
  });

  it('keeps inherited reports private without widening a read-only source file', () => {
    seedSourceRun('source-run', { 'private-review.md': 'sensitive review' });
    const sourceReport = join(
      buildRunPaths(cwd, 'source-run').reportsAbs,
      'private-review.md',
    );
    chmodSync(sourceReport, 0o400);

    inheritResumeReportSnapshot({ cwd, sourceRunSlug: 'source-run', targetRunSlug: 'target-run' });

    const targetReports = buildRunPaths(cwd, 'target-run').reportsAbs;
    expect(readFileSync(join(targetReports, 'private-review.md'), 'utf-8')).toBe('sensitive review');
    // Windows は POSIX モードを再現しない（read-only 属性のみ）ため、
    // モードの検証は POSIX ランナーでだけ行う。
    if (process.platform !== 'win32') {
      expect(statSync(targetReports).mode & 0o777).toBe(0o700);
      expect(statSync(join(targetReports, 'private-review.md')).mode & 0o777).toBe(0o400);
      expect(statSync(join(targetReports, RESUME_ARTIFACTS_FILE_NAME)).mode & 0o777).toBe(0o600);
    }
  });

  it('fails fast when the target reports directory is already non-empty', () => {
    seedSourceRun('source-run', { 'plan.md': 'the plan' });
    const targetPaths = buildRunPaths(cwd, 'target-run');
    mkdirSync(targetPaths.reportsAbs, { recursive: true });
    writeFileSync(join(targetPaths.reportsAbs, 'existing.md'), 'do not clobber');

    const error = captureError(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    }));
    expect(error).not.toBeInstanceOf(ResumeReportSnapshotSourceError);
    expect(error.message).toMatch(/already has a non-empty reports directory/);
    expect(readFileSync(join(targetPaths.reportsAbs, 'existing.md'), 'utf-8')).toBe('do not clobber');
  });

  it('rejects symlinks in the source reports tree and publishes nothing', () => {
    seedSourceRun('source-run', { 'plan.md': 'the plan' });
    const outside = join(cwd, 'outside-secret.md');
    writeFileSync(outside, 'secret');
    const sourceReports = buildRunPaths(cwd, 'source-run').reportsAbs;
    symlinkSync(outside, join(sourceReports, 'link.md'));

    const error = captureError(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    }));
    expect(error).toBeInstanceOf(ResumeReportSnapshotSourceError);
    expect(error.message).toMatch(/refusing to copy symlink/);

    const targetPaths = buildRunPaths(cwd, 'target-run');
    expect(existsSync(targetPaths.reportsAbs)).toBe(false);
    expect(existsSync(join(targetPaths.runRootAbs, RESUME_ARTIFACTS_FILE_NAME))).toBe(false);
    // 一時成果物も残さない。
    const leftovers = readdirSync(targetPaths.runRootAbs).filter((n) => n.startsWith('.reports-inherit-tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('rejects a source ancestor swap after inspection without copying outside content', () => {
    seedSourceRun('source-run', { 'plan.md': 'inside plan' });
    const sourceReports = buildRunPaths(cwd, 'source-run').reportsAbs;
    const originalReports = join(cwd, 'original-reports');
    const outsideReports = join(cwd, 'outside-reports');
    mkdirSync(outsideReports);
    writeFileSync(join(outsideReports, 'plan.md'), 'outside secret');
    fsControl.beforeOpenPath = join(sourceReports, 'plan.md');
    fsControl.beforeOpen = () => {
      renameSync(sourceReports, originalReports);
      symlinkSync(outsideReports, sourceReports, 'dir');
    };

    expect(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    })).toThrow(/identity changed/);

    expect(readFileSync(join(originalReports, 'plan.md'), 'utf-8')).toBe('inside plan');
    expect(readFileSync(join(outsideReports, 'plan.md'), 'utf-8')).toBe('outside secret');
    expect(existsSync(buildRunPaths(cwd, 'target-run').reportsAbs)).toBe(false);
  });

  it('rejects a source ancestor swap when traversal starts without publishing outside content', () => {
    seedSourceRun('source-run', { 'plan.md': 'inside plan' });
    const sourceReports = buildRunPaths(cwd, 'source-run').reportsAbs;
    const originalReports = join(cwd, 'original-reports');
    const outsideReports = join(cwd, 'outside-reports');
    mkdirSync(outsideReports);
    writeFileSync(join(outsideReports, 'plan.md'), 'outside secret');
    fsControl.beforeReaddirPath = sourceReports;
    fsControl.beforeReaddir = () => {
      renameSync(sourceReports, originalReports);
      symlinkSync(outsideReports, sourceReports, 'dir');
    };

    expect(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    })).toThrow(/identity changed/);

    expect(readFileSync(join(outsideReports, 'plan.md'), 'utf-8')).toBe('outside secret');
    expect(existsSync(buildRunPaths(cwd, 'target-run').reportsAbs)).toBe(false);
  });

  it('rejects path-traversal style run slugs', () => {
    seedSourceRun('source-run', { 'plan.md': 'the plan' });
    expect(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: '../escape',
      targetRunSlug: 'target-run',
    })).toThrow(/invalid source run slug/);
    expect(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: '../escape',
    })).toThrow(/invalid target run slug/);
  });

  // FIFO は POSIX 専用（Windows の mkfifo は成立しない）ため POSIX ランナーでのみ検証する。
  it.skipIf(process.platform === 'win32')('does not publish a partial reports directory when the copy fails midway', () => {
    seedSourceRun('source-run', {
      'a-first.md': 'copied before the failure',
      'z-last.md': 'copied after the failure',
    });
    const sourceReports = buildRunPaths(cwd, 'source-run').reportsAbs;
    // 非通常ファイル（fifo）は拒否される。辞書順で a と z の間に置き、
    // 一部コピー済みの状態で失敗させる。
    execFileSync('mkfifo', [join(sourceReports, 'm-fifo.md')]);

    expect(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    })).toThrow(/non-regular file/);

    const targetPaths = buildRunPaths(cwd, 'target-run');
    expect(existsSync(targetPaths.reportsAbs)).toBe(false);
    expect(existsSync(join(targetPaths.runRootAbs, RESUME_ARTIFACTS_FILE_NAME))).toBe(false);
    const leftovers = existsSync(targetPaths.runRootAbs)
      ? readdirSync(targetPaths.runRootAbs).filter((n) => n.startsWith('.reports-inherit-tmp-'))
      : [];
    expect(leftovers).toEqual([]);
  });

  it('produces an empty snapshot with a manifest when the source has no reports', () => {
    const sourcePaths = buildRunPaths(cwd, 'source-run');
    mkdirSync(sourcePaths.runRootAbs, { recursive: true });
    writeFileSync(join(sourcePaths.runRootAbs, 'meta.json'), '{}');

    const manifest = inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    });

    expect(manifest.files).toEqual([]);
    const targetReports = buildRunPaths(cwd, 'target-run').reportsAbs;
    expect(existsSync(targetReports)).toBe(true);
    // 空 source でも staged reports は manifest（予約名）を含む — 「空ディレクトリの
    // 公開」という窓が存在しない。
    expect(readdirSync(targetReports)).toEqual([RESUME_ARTIFACTS_FILE_NAME]);
    expect(readResumeReportSnapshotManifest(cwd, 'target-run')?.files).toEqual([]);
  });

  it('fails when the source run does not exist (no ancestor fallback)', () => {
    const error = captureError(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'missing-run',
      targetRunSlug: 'target-run',
    }));
    expect(error).toBeInstanceOf(ResumeReportSnapshotSourceError);
    expect(error.message).toMatch(/source run "missing-run" does not exist/);
  });

  it('propagates source reports access failures without publishing an empty snapshot', () => {
    seedSourceRun('source-run', { 'plan.md': 'the plan' });
    const sourceReports = buildRunPaths(cwd, 'source-run').reportsAbs;
    fsControl.failLstatForPath = sourceReports;

    const error = captureError(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    }));
    expect(error).toBeInstanceOf(ResumeReportSnapshotSourceError);
    expect(error.message).toMatch(/permission denied/);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toMatch(/permission denied/);

    expect(existsSync(buildRunPaths(cwd, 'target-run').reportsAbs)).toBe(false);
  });

  it('propagates a corrupt manifest instead of treating it as absent', () => {
    const reports = buildRunPaths(cwd, 'source-run').reportsAbs;
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, RESUME_ARTIFACTS_FILE_NAME), '{not-json');

    expect(() => readResumeReportSnapshotManifest(cwd, 'source-run')).toThrow(SyntaxError);
  });

  it.each([
    ['empty object', {}],
    ['null root', null],
    ['array root', []],
    ['missing fields', { version: 1 }],
    ['wrong version', { version: 2, sourceRunSlug: 'source-run', targetRunSlug: 'target-run', createdAt: '2026-07-17T00:00:00.000Z', files: [] }],
    ['target slug mismatch', { version: 1, sourceRunSlug: 'source-run', targetRunSlug: 'other-run', createdAt: '2026-07-17T00:00:00.000Z', files: [] }],
    ['same source and target slug', { version: 1, sourceRunSlug: 'target-run', targetRunSlug: 'target-run', createdAt: '2026-07-17T00:00:00.000Z', files: [] }],
    ['non-canonical ISO timestamp', { version: 1, sourceRunSlug: 'source-run', targetRunSlug: 'target-run', createdAt: '2026-07-17 00:00:00Z', files: [] }],
    ['normalized invalid calendar date', { version: 1, sourceRunSlug: 'source-run', targetRunSlug: 'target-run', createdAt: '2026-02-30T00:00:00.000Z', files: [] }],
    ['invalid file entry', { version: 1, sourceRunSlug: 'source-run', targetRunSlug: 'target-run', createdAt: '2026-07-17T00:00:00.000Z', files: [{ path: '../escape.md', size: -1, sha256: 'bad' }] }],
    ['extra root field', { version: 1, sourceRunSlug: 'source-run', targetRunSlug: 'target-run', createdAt: '2026-07-17T00:00:00.000Z', files: [], extra: true }],
  ])('rejects a semantically invalid manifest: %s', (_name, manifest) => {
    const reports = buildRunPaths(cwd, 'target-run').reportsAbs;
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, RESUME_ARTIFACTS_FILE_NAME), JSON.stringify(manifest));

    expect(() => readResumeReportSnapshotManifest(cwd, 'target-run')).toThrow(/Resume report snapshot: manifest/);
  });

  it('keeps chained resumes A -> B -> C inheriting only from the direct parent', () => {
    seedSourceRun('run-a', { 'plan.md': 'plan from A' });
    inheritResumeReportSnapshot({ cwd, sourceRunSlug: 'run-a', targetRunSlug: 'run-b' });

    // B が自分の実行でレポートを更新する。
    const runBReports = buildRunPaths(cwd, 'run-b').reportsAbs;
    writeReportFile(runBReports, 'plan.md', 'plan updated by B');
    writeReportFile(runBReports, 'review.md', 'review from B');

    const manifest = inheritResumeReportSnapshot({ cwd, sourceRunSlug: 'run-b', targetRunSlug: 'run-c' });

    const runCReports = buildRunPaths(cwd, 'run-c').reportsAbs;
    // C は B の更新を継承する（A の内容ではない）。
    expect(readFileSync(join(runCReports, 'plan.md'), 'utf-8')).toBe('plan updated by B');
    expect(readFileSync(join(runCReports, 'review.md'), 'utf-8')).toBe('review from B');
    expect(manifest.sourceRunSlug).toBe('run-b');
    // B の上書きで退避された履歴版も継承される。
    const historyFiles = manifest.files.filter((f) => f.path.startsWith('plan.md.'));
    expect(historyFiles.length).toBe(1);
    // 予約名（B が継承時に受け取った manifest）はコピー対象から除外され、
    // C の manifest.files にも現れない。reports 内の manifest は C 自身のもの。
    expect(manifest.files.some((f) => f.path === 'resume-artifacts.json')).toBe(false);
    expect(readResumeReportSnapshotManifest(cwd, 'run-c')?.sourceRunSlug).toBe('run-b');
  });

  it('keeps parallel resumes from the same source independent', () => {
    seedSourceRun('source-run', { 'plan.md': 'shared plan' });

    const manifestB = inheritResumeReportSnapshot({ cwd, sourceRunSlug: 'source-run', targetRunSlug: 'target-b' });
    const manifestC = inheritResumeReportSnapshot({ cwd, sourceRunSlug: 'source-run', targetRunSlug: 'target-c' });

    const reportsB = buildRunPaths(cwd, 'target-b').reportsAbs;
    const reportsC = buildRunPaths(cwd, 'target-c').reportsAbs;
    writeFileSync(join(reportsB, 'plan.md'), 'mutated by B');
    expect(readFileSync(join(reportsC, 'plan.md'), 'utf-8')).toBe('shared plan');
    expect(readFileSync(join(buildRunPaths(cwd, 'source-run').reportsAbs, 'plan.md'), 'utf-8')).toBe('shared plan');
    expect(manifestB.files).toEqual(manifestC.files);
  });

  it('versions inherited files into history when the new run regenerates them', () => {
    seedSourceRun('source-run', { 'plan.md': 'inherited plan' });
    inheritResumeReportSnapshot({ cwd, sourceRunSlug: 'source-run', targetRunSlug: 'target-run' });

    const targetReports = buildRunPaths(cwd, 'target-run').reportsAbs;
    writeReportFile(targetReports, 'plan.md', 'regenerated plan');

    expect(readFileSync(join(targetReports, 'plan.md'), 'utf-8')).toBe('regenerated plan');
    const history = readdirSync(targetReports).filter((n) => n.startsWith('plan.md.'));
    expect(history.length).toBe(1);
    expect(readFileSync(join(targetReports, history[0]!), 'utf-8')).toBe('inherited plan');
  });

  // 予約名の強制（codex 3巡目）: report-writer は予約名への書き込みを
  // 明示エラーで拒否する（防御の第二層 — 第一層は出力契約の Zod 検証）。
  it('rejects writing a report with the reserved manifest name at the writer boundary', () => {
    const reportsDir = join(cwd, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    // Windows 形式の区切り（sub\Resume-Artifacts.JSON）も basename 判定で拒否
    // される（codex 4巡目: / のみの区切りでは迂回できた）。
    for (const name of ['resume-artifacts.json', ' Resume-Artifacts.JSON ', 'sub/resume-artifacts.json', 'sub\\Resume-Artifacts.JSON']) {
      expect(() => writeReportFile(reportsDir, name, 'content')).toThrow(/reserved internal file/);
    }
    // 通常名は従来どおり書ける。
    expect(() => writeReportFile(reportsDir, 'normal-report.md', 'content')).not.toThrow();
  });

  it('rejects replacing a symlink report without changing its external target', () => {
    const reportsDir = join(cwd, 'reports');
    const outside = join(cwd, 'outside-report.md');
    mkdirSync(reportsDir);
    writeFileSync(outside, 'outside content');
    symlinkSync(outside, join(reportsDir, 'review.md'));

    expect(() => writeReportFile(reportsDir, 'review.md', 'replacement'))
      .toThrow(/not a regular file/);

    expect(readFileSync(outside, 'utf-8')).toBe('outside content');
    expect(lstatSync(join(reportsDir, 'review.md')).isSymbolicLink()).toBe(true);
  });

  // codex ブロッカー2: source の reports/ パス自体が symlink の場合、
  // 外部ディレクトリを丸ごとコピーしてしまう。
  it('rejects a source reports path that is itself a symlink', () => {
    const sourcePaths = buildRunPaths(cwd, 'source-run');
    mkdirSync(sourcePaths.runRootAbs, { recursive: true });
    writeFileSync(join(sourcePaths.runRootAbs, 'meta.json'), '{}');
    const outsideDir = join(cwd, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.md'), 'outside secret');
    symlinkSync(outsideDir, sourcePaths.reportsAbs);

    expect(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    })).toThrow(/reports path is a symlink/);

    expect(existsSync(buildRunPaths(cwd, 'target-run').reportsAbs)).toBe(false);
    expectNoLeftovers('target-run');
  });

  it('rejects a target run root symlink without writing outside the workspace', () => {
    seedSourceRun('source-run', { 'review.md': 'review' });
    const outsideTarget = join(cwd, 'outside-target');
    mkdirSync(outsideTarget);
    symlinkSync(outsideTarget, buildRunPaths(cwd, 'target-run').runRootAbs);

    expect(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    })).toThrow(/target run path contains a symlink/);

    expect(readdirSync(outsideTarget)).toEqual([]);
  });

  it('rejects a target ancestor symlink without creating the target outside the workspace', () => {
    const taktDir = join(cwd, '.takt');
    const outsideRuns = join(cwd, 'outside-runs');
    mkdirSync(taktDir);
    mkdirSync(outsideRuns);
    symlinkSync(outsideRuns, join(taktDir, 'runs'));

    expect(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    })).toThrow(/target run path contains a symlink/);

    expect(readdirSync(outsideRuns)).toEqual([]);
  });

  it('rejects a target run swap immediately before publication without changing the outside directory', () => {
    seedSourceRun('source-run', { 'review.md': 'inside review' });
    const targetPaths = buildRunPaths(cwd, 'target-run');
    const movedTarget = join(cwd, 'original-target-run');
    const outsideTarget = join(cwd, 'outside-target-run');
    mkdirSync(outsideTarget);
    writeFileSync(join(outsideTarget, 'outside.md'), 'outside content');
    fsControl.beforeDirectoryPublication = () => {
      renameSync(targetPaths.runRootAbs, movedTarget);
      symlinkSync(outsideTarget, targetPaths.runRootAbs, 'dir');
    };

    expect(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-run',
      targetRunSlug: 'target-run',
    })).toThrow(/identity changed/);

    expect(readFileSync(join(outsideTarget, 'outside.md'), 'utf-8')).toBe('outside content');
    expect(readdirSync(outsideTarget)).toEqual(['outside.md']);
    expect(existsSync(join(outsideTarget, 'reports'))).toBe(false);
  });

  // codex 2巡目裁定: 公開は単一 rename に集約（manifest は staged reports の
  // 内側の予約名）。失敗経路は staging の掃除のみで、公開済み状態に触る操作が
  // 存在しない。
  describe('single-rename publish boundary', () => {
    it('publishes nothing when the reports rename fails', () => {
      seedSourceRun('source-run', { 'plan.md': 'the plan' });
      const targetReports = buildRunPaths(cwd, 'target-run').reportsAbs;
      fsControl.failRenameToPredicate = (dest) => dest === targetReports;

      expect(() => inheritResumeReportSnapshot({
        cwd,
        sourceRunSlug: 'source-run',
        targetRunSlug: 'target-run',
      })).toThrow(/injected rename failure/);

      const targetPaths = buildRunPaths(cwd, 'target-run');
      expect(existsSync(targetPaths.reportsAbs)).toBe(false);
      expect(readResumeReportSnapshotManifest(cwd, 'target-run')).toBeUndefined();
      expectNoLeftovers('target-run');
      // source は不変。
      expect(readFileSync(join(buildRunPaths(cwd, 'source-run').reportsAbs, 'plan.md'), 'utf-8')).toBe('the plan');
    });

    it('does not touch the published pair even when the staging cleanup itself fails', () => {
      seedSourceRun('source-a', { 'plan.md': 'plan from A' });
      seedSourceRun('source-b', { 'plan.md': 'plan from B' });
      const manifestA = inheritResumeReportSnapshot({ cwd, sourceRunSlug: 'source-a', targetRunSlug: 'target-run' });
      const targetPaths = buildRunPaths(cwd, 'target-run');

      // B: pre-check を空で通過（競合）→ 公開 rename が失敗 → さらに掃除
      // （rmSync）も失敗する最悪ケース。公開済みの A の組には一切触れない。
      fsControl.emptyReaddirOncePath = targetPaths.reportsAbs;
      fsControl.failRmForPrefix = join(targetPaths.runRootAbs, '.reports-inherit-tmp-');

      expect(() => inheritResumeReportSnapshot({
        cwd,
        sourceRunSlug: 'source-b',
        targetRunSlug: 'target-run',
      })).toThrow();

      expect(readFileSync(join(targetPaths.reportsAbs, 'plan.md'), 'utf-8')).toBe('plan from A');
      expect(readResumeReportSnapshotManifest(cwd, 'target-run')).toEqual(manifestA);
    });
  });

  // codex の競合シナリオそのもの: 空 source の A と非空 source の B が同一
  // target を競い、どの失敗を注入しても「公開済みの reports+manifest は常に
  // 一方の完全な組」であること。空 source でも staged reports は manifest を
  // 含むため、空ディレクトリ経由で勝者を破壊できる窓が存在しない。
  it('keeps the published pair complete when an empty-source winner races a non-empty-source loser (codex scenario)', () => {
    const sourceAPaths = buildRunPaths(cwd, 'source-empty');
    mkdirSync(sourceAPaths.runRootAbs, { recursive: true });
    writeFileSync(join(sourceAPaths.runRootAbs, 'meta.json'), '{}');
    seedSourceRun('source-full', { 'plan.md': 'plan from B' });

    // A（空 source）が公開: reports は manifest のみの完全な組。
    const manifestA = inheritResumeReportSnapshot({ cwd, sourceRunSlug: 'source-empty', targetRunSlug: 'target-run' });
    const targetPaths = buildRunPaths(cwd, 'target-run');
    expect(readdirSync(targetPaths.reportsAbs)).toEqual([RESUME_ARTIFACTS_FILE_NAME]);

    // B（非空 source）が pre-check を空で通過した競合状況: A の reports は
    // manifest を含む非空ディレクトリなので、rmdir/rename で確実に敗退する。
    fsControl.emptyReaddirOncePath = targetPaths.reportsAbs;
    expect(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-full',
      targetRunSlug: 'target-run',
    })).toThrow();

    // 公開済みの組は A の完全な組のまま。
    expect(readdirSync(targetPaths.reportsAbs)).toEqual([RESUME_ARTIFACTS_FILE_NAME]);
    expect(readResumeReportSnapshotManifest(cwd, 'target-run')).toEqual(manifestA);
    expectNoLeftovers('target-run');
  });

  // codex ブロッカー4: 同一 target への並行 resume の競合。pre-check（target 非空
  // fail-fast）を通過してしまった敗者側でも、公開段階（rmdir/rename）で確実に
  // 失敗し、勝者の成果物と manifest を壊さない。
  it('loses cleanly when a concurrent resume already published the same target after the pre-check', () => {
    seedSourceRun('source-a', { 'plan.md': 'plan from A' });
    seedSourceRun('source-b', { 'plan.md': 'plan from B' });

    // 勝者 A が公開を完了する。
    const manifestA = inheritResumeReportSnapshot({ cwd, sourceRunSlug: 'source-a', targetRunSlug: 'target-run' });
    const targetPaths = buildRunPaths(cwd, 'target-run');

    // 敗者 B: pre-check 時点では target が空だった（= A の公開前に検査を通過した）
    // 状況を再現する。isEmptyDir の readdirSync を1回だけ空に見せる。
    fsControl.emptyReaddirOncePath = targetPaths.reportsAbs;
    expect(() => inheritResumeReportSnapshot({
      cwd,
      sourceRunSlug: 'source-b',
      targetRunSlug: 'target-run',
    })).toThrow();

    // 勝者 A の reports と manifest は無傷（B に上書き・削除されない）。
    expect(readFileSync(join(targetPaths.reportsAbs, 'plan.md'), 'utf-8')).toBe('plan from A');
    const manifest = readResumeReportSnapshotManifest(cwd, 'target-run');
    expect(manifest).toEqual(manifestA);
    expect(manifest?.sourceRunSlug).toBe('source-a');
    expectNoLeftovers('target-run');
  });
});
