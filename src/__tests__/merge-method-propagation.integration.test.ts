import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMerge, resolveMergeSettings } from '../features/merge/index.js';
import { invalidateAllResolvedConfigCache, resolveConfigValue } from '../infra/config/index.js';
import { initGitProvider } from '../infra/git/index.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import * as cloneExec from '../infra/task/clone-exec.js';
import { fetchPrStatus } from '../infra/github/pr-status.js';
import * as githubPr from '../infra/github/pr.js';

describe.skipIf(process.platform === 'win32')('Configured merge method through Workflow API and system effects', () => {
  let root: string;
  let project: string;
  let fork: string;
  let headSha: string;
  let cloneCwd: string | undefined;

  function git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-merge-method-'));
    project = join(root, 'project');
    fork = join(root, 'fork.git');
    cloneCwd = undefined;
    git(root, 'init', '--initial-branch=main', project);
    git(project, 'config', 'user.name', 'Merge Integration');
    git(project, 'config', 'user.email', 'merge@example.test');
    writeFileSync(join(project, 'code.txt'), 'base\n');
    git(project, 'add', 'code.txt');
    git(project, 'commit', '-m', 'base');
    git(root, 'clone', '--bare', project, fork);
    const author = join(root, 'author');
    git(root, 'clone', fork, author);
    git(author, 'config', 'user.name', 'PR Author');
    git(author, 'config', 'user.email', 'author@example.test');
    git(author, 'checkout', '-b', 'feature/pr');
    writeFileSync(join(author, 'code.txt'), 'PR change\n');
    git(author, 'add', 'code.txt');
    git(author, 'commit', '-m', 'PR change');
    git(author, 'push', 'origin', 'feature/pr');
    headSha = git(author, 'rev-parse', 'HEAD');
    mkdirSync(join(project, '.takt'));
    writeFileSync(join(project, 'merge-method.yaml'), [
      'name: configured-merge', 'initial_step: merge', 'steps:',
      '  - name: merge', '    mode: system', '    effects:',
      '      - type: merge_pr', '        pr: 123', '    rules:',
      '      - condition: when(effect.merge.merge_pr.success == true)', '        next: COMPLETE',
      '      - condition: when(true)', '        next: ABORT',
    ].join('\n') + '\n');
    vi.spyOn(GitHubProvider.prototype, 'checkCliStatus').mockReturnValue({ available: true });
    vi.spyOn(GitHubProvider.prototype, 'fetchPrDetails').mockResolvedValue({
      number: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha,
      headRepositoryUrl: fork, headRepositoryPushUrls: [fork], sameRepository: true,
    });
    vi.spyOn(GitHubProvider.prototype, 'fetchPrStatus').mockResolvedValue({
      number: 123, headSha, ci: { finished: true, passed: true }, mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged: true,
    });
    vi.spyOn(githubPr, 'fetchCodeRabbitReviewStatus').mockResolvedValue({
      headSha, hasCodeRabbitPost: false, reviewedHeadShas: [],
      ...{ hasCodeRabbitStatus: false, unresolvedThreadCount: 0 },
    });
    const clone = cloneExec.cloneAndIsolateAbortable;
    vi.spyOn(cloneExec, 'cloneAndIsolateAbortable').mockImplementation(async (...args) => {
      cloneCwd = args[1];
      return clone(...args);
    });
  });

  function cleanup() {
    try {
      for (const fileName of ['status-pids', 'final-status-pid']) {
        const pidPath = join(root, fileName);
        if (!existsSync(pidPath)) continue;
        const pids = readFileSync(pidPath, 'utf8').trim().split('\n').map(Number)
          .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      }
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      invalidateAllResolvedConfigCache();
      rmSync(root, { recursive: true, force: true });
    }
  }

  afterEach(cleanup);

  describe.each(['status-pids', 'final-status-pid'])('%sのPID記録の検証', (fileName) => {
    it.each([
      { name: '単一の有効PID', record: '12345\n', expected: [12345] },
      { name: '複数の有効PID', record: '12345\n34567\n23456', expected: [12345, 34567, 23456] },
      { name: '空文字', record: '', expected: [] },
      { name: '空白', record: ' \n', expected: [] },
      { name: 'ゼロ', record: '0', expected: [] },
      { name: '負数', record: '-1', expected: [] },
      { name: '小数', record: '1.5', expected: [] },
      { name: '非数値', record: 'bad', expected: [] },
      { name: '無限大', record: 'Infinity', expected: [] },
      { name: '安全な整数の範囲外', record: '9007199254740992', expected: [] },
      { name: '有効PID間の不正値', record: '12345\nbad\n23456', expected: [12345, 23456] },
    ])('$nameでは正の安全な整数だけへSIGKILLを送る', ({ record, expected }) => {
      const signals: Parameters<typeof process.kill>[] = [];
      vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        signals.push([pid, signal]);
        return true;
      });
      writeFileSync(join(root, fileName), record);

      cleanup();

      expect(signals).toEqual(expected.map((pid) => [pid, 'SIGKILL']));
      expect(existsSync(root)).toBe(false);
    });
  });

  it.each(['12345', ''])('先のPID記録が%jでも次のファイルの有効PIDを処理する', (record) => {
    const signals: Parameters<typeof process.kill>[] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      signals.push([pid, signal]);
      return true;
    });
    writeFileSync(join(root, 'status-pids'), record);
    writeFileSync(join(root, 'final-status-pid'), '23456');

    cleanup();

    expect(signals).toEqual(record === ''
      ? [[23456, 'SIGKILL']]
      : [[12345, 'SIGKILL'], [23456, 'SIGKILL']]);
    expect(existsSync(root)).toBe(false);
  });

  it.each(['status-pids', 'final-status-pid'])('%sに記録した稼働中の子を後処理で終了する', async (fileName) => {
    const children = Array.from({ length: fileName === 'status-pids' ? 2 : 1 }, () =>
      spawn(process.execPath, ['-e', [
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
        "process.send('ready');",
      ].join('\n')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
    const exits = children.map((child) => once(child, 'exit'));
    try {
      await Promise.all(children.map((child) => once(child, 'message')));
      const pids = children.map((child) => child.pid!);
      for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
      if (fileName === 'status-pids') {
        const exitedPid = Number(execFileSync(process.execPath,
          ['-e', 'process.stdout.write(String(process.pid));'], { encoding: 'utf8' }));
        expect(() => process.kill(exitedPid, 0)).toThrow();
        pids.unshift(exitedPid);
      }
      writeFileSync(join(root, fileName), pids.join('\n'));

      cleanup();

      await vi.waitFor(() => {
        for (const child of children) expect(child.signalCode).toBe('SIGKILL');
      });
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      expect(existsSync(root)).toBe(false);
    } finally {
      for (const child of children) child.kill('SIGKILL');
      await Promise.all(exits);
    }
  });

  it.each(['rebase', 'merge'] as const)('設定方式%sを実Workflow APIからProviderの実引数まで伝播する', async (method) => {
    writeFileSync(join(project, '.takt/config.yaml'), [
      'provider: claude', 'vcs_provider: github', 'merge:',
      '  workflow: ./merge-method.yaml', `  method: ${method}`,
    ].join('\n') + '\n');
    invalidateAllResolvedConfigCache();
    initGitProvider(project);
    const merge = vi.spyOn(GitHubProvider.prototype, 'mergePr').mockReturnValue({ success: true });
    const settings = resolveMergeSettings(resolveConfigValue(project, 'merge'));
    expect(settings.method).toBe(method);
    expect(await runMerge({ projectCwd: project, prNumber: 123, concurrency: 1, settings }))
      .toMatchObject({ processedCount: 1, mergedCount: 1, exitCode: 0 });
    expect(merge).toHaveBeenCalledExactlyOnceWith(123, project, method, headSha);
    expect(cloneCwd).toBeDefined();
    expect(cloneCwd).not.toBe(project);
    expect(existsSync(cloneCwd!)).toBe(false);
    expect(existsSync(join(project, '.takt/runs'))).toBe(true);
    expect(git(project, 'branch', '--show-current')).toBe('main');
  });

  it.each([
    { interrupted: false, rejects: false }, { interrupted: true, rejects: false },
    { interrupted: false, rejects: true }, { interrupted: true, rejects: true },
  ])('マージ前確認の中断=$interrupted・reject=$rejectsを後続effectとcleanupまで伝播する', async ({ interrupted, rejects }) => {
    writeFileSync(join(project, '.takt/config.yaml'), 'provider: claude\nvcs_provider: github\n');
    writeFileSync(join(project, 'merge-method.yaml'), [
      'name: checked-merge', 'initial_step: merge', 'steps:',
      '  - name: merge', '    mode: system', '    effects:',
      '      - type: merge_pr', '        pr: 123',
      '      - type: comment_pr', '        pr: 123', '        body: Merge check completed',
      '    rules:', '      - condition: when(effect.merge.merge_pr.success == true)', '        next: COMPLETE',
      '      - condition: when(true)', '        next: ABORT',
    ].join('\n') + '\n');
    const controller = new AbortController();
    let settle!: () => void;
    const finalCheck = new Promise<Awaited<ReturnType<typeof githubPr.fetchCodeRabbitReviewStatus>>>((resolve, reject) => {
      settle = () => rejects ? reject(new Error('status lookup failed')) : resolve({
        headSha, hasCodeRabbitPost: true, hasCodeRabbitStatus: false,
        unresolvedThreadCount: 0, reviewedHeadShas: [headSha],
      });
    });
    let started!: () => void;
    const checking = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(githubPr.fetchCodeRabbitReviewStatus).mockImplementationOnce(async () => ({
      headSha, hasCodeRabbitPost: true, hasCodeRabbitStatus: false,
      unresolvedThreadCount: 0, reviewedHeadShas: [headSha],
    })).mockImplementationOnce(() => {
      started();
      return finalCheck;
    });
    const merge = vi.spyOn(GitHubProvider.prototype, 'mergePr').mockReturnValue({ success: true });
    const comment = vi.spyOn(GitHubProvider.prototype, 'commentOnPr').mockReturnValue({ success: true });
    let merged = false;
    merge.mockImplementation(() => { merged = true; return { success: true }; });
    vi.mocked(GitHubProvider.prototype.fetchPrStatus).mockImplementation(async () => ({
      number: 123, headSha, ci: { finished: true, passed: true }, mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged,
    }));
    invalidateAllResolvedConfigCache();
    initGitProvider(project);
    const execution = runMerge({ projectCwd: project, prNumber: 123, concurrency: 1,
      settings: resolveMergeSettings({ workflow: './merge-method.yaml' }), abortSignal: controller.signal });
    await checking;
    expect(cloneCwd).toBeDefined();
    expect(existsSync(cloneCwd!)).toBe(true);

    if (interrupted) controller.abort(new Error('interrupted during merge check'));
    settle();
    const result = await execution;

    const canMerge = !interrupted && !rejects;
    expect(result).toMatchObject({ processedCount: 1, mergedCount: canMerge ? 1 : 0, exitCode: canMerge ? 0 : 1 });
    if (canMerge) expect(merge).toHaveBeenCalledExactlyOnceWith(123, project, 'squash', headSha);
    else expect(merge).not.toHaveBeenCalled();
    if (interrupted) expect(comment).not.toHaveBeenCalled();
    else expect(comment).toHaveBeenCalledExactlyOnceWith(123, 'Merge check completed', project);
    expect(existsSync(cloneCwd!)).toBe(false);
    expect(git(project, 'branch', '--show-current')).toBe('main');
  });

  it.each([
    { reviewed: false, unresolvedCount: 0, markersAbsent: true },
    { reviewed: false, unresolvedCount: 0, markersAbsent: false },
    { reviewed: true, unresolvedCount: 0, markersAbsent: false },
    { reviewed: true, unresolvedCount: 2, markersAbsent: false },
  ])(
    '同じmerge実行でpushしたheadのレビュー完了=$reviewed・未解決=$unresolvedCount・マーカー不在=$markersAbsentを再確認する', async ({ reviewed, unresolvedCount, markersAbsent }) => {
    writeFileSync(join(project, '.takt/config.yaml'), 'provider: claude\nvcs_provider: github\n');
    writeFileSync(join(project, 'merge-method.yaml'), [
      'name: push-and-merge', 'initial_step: push', 'steps:',
      '  - name: push', '    mode: system', '    effects:',
      '      - type: comment_pr', '        pr: 123', '        body: Apply correction',
      '    rules:', '      - condition: when(true)', '        next: merge',
      '  - name: merge', '    mode: system', '    effects:',
      '      - type: merge_pr', '        pr: 123', '    rules:',
      '      - condition: when(effect.merge.merge_pr.success == true)', '        next: COMPLETE',
      '      - condition: when(true)', '        next: ABORT',
    ].join('\n') + '\n');
    let currentHead = headSha;
    let merged = false;
    const observedHeads: string[] = [];
    vi.mocked(githubPr.fetchCodeRabbitReviewStatus).mockImplementation(async () => {
      observedHeads.push(currentHead);
      const initial = currentHead === headSha;
      return { headSha: currentHead, hasCodeRabbitPost: !initial && !markersAbsent,
        reviewedHeadShas: initial || reviewed ? [currentHead] : markersAbsent ? [] : [headSha],
        hasCodeRabbitStatus: initial, unresolvedThreadCount: initial ? 0 : unresolvedCount };
    });
    vi.spyOn(GitHubProvider.prototype, 'commentOnPr').mockImplementation(() => {
      if (cloneCwd === undefined) throw new Error('Expected a prepared PR clone');
      git(cloneCwd, 'config', 'user.name', 'Merge Test');
      git(cloneCwd, 'config', 'user.email', 'merge@example.test');
      writeFileSync(join(cloneCwd, 'code.txt'), 'correction\n');
      git(cloneCwd, 'add', 'code.txt');
      git(cloneCwd, 'commit', '-m', 'correction');
      git(cloneCwd, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
      currentHead = git(cloneCwd, 'rev-parse', 'HEAD');
      return { success: true };
    });
    const merge = vi.spyOn(GitHubProvider.prototype, 'mergePr').mockImplementation(() => {
      merged = true;
      return { success: true };
    });
    vi.mocked(GitHubProvider.prototype.fetchPrStatus).mockImplementation(async () => ({
      number: 123, headSha: currentHead, ci: { finished: true, passed: true }, mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merged,
    }));
    invalidateAllResolvedConfigCache();
    initGitProvider(project);

    const result = await runMerge({ projectCwd: project, prNumber: 123, concurrency: 1,
      settings: resolveMergeSettings({ workflow: './merge-method.yaml' }) });

    expect(currentHead).not.toBe(headSha);
    expect(git(fork, 'rev-parse', 'refs/heads/feature/pr')).toBe(currentHead);
    const canMerge = reviewed && unresolvedCount === 0;
    expect(result).toMatchObject({ processedCount: 1, mergedCount: canMerge ? 1 : 0, exitCode: canMerge ? 0 : 1 });
    if (canMerge) expect(merge).toHaveBeenCalledExactlyOnceWith(123, project, 'squash', currentHead);
    else expect(merge).not.toHaveBeenCalled();
    expect(observedHeads).toEqual([headSha, currentHead]);
    expect(cloneCwd).toBeDefined();
    expect(existsSync(cloneCwd!)).toBe(false);
  });

  it('停止する取得を上限まで試行しtimeout理由をコメントしてマージせずcloneを削除する', async () => {
    writeFileSync(join(project, '.takt/config.yaml'), 'provider: claude\nvcs_provider: github\n');
    writeFileSync(join(project, 'merge-method.yaml'), [
      'name: status-timeout', 'initial_step: wait_ci', 'steps:',
      '  - name: wait_ci', '    mode: system', '    system_inputs:',
      '      - type: pr_status', '        source: current_pr', '        as: status',
      '    wait:', '      until: when(context.wait_ci.status.ci.finished == true)',
      '      interval_ms: 1000', '      max_retries: 2', '      on_timeout: timeout',
      '    effects:', '      - type: merge_pr', '        pr: 123',
      '    rules:', '      - condition: when(true)', '        next: COMPLETE',
      '  - name: timeout', '    mode: system', '    effects:',
      '      - type: comment_pr', '        pr: 123', '        body: CI status acquisition timed out',
      '    rules:', '      - condition: when(true)', '        next: ABORT',
    ].join('\n') + '\n');
    const bin = join(root, 'bin');
    const callsPath = join(root, 'status-pids');
    mkdirSync(bin);
    const raw = { number: 123, headRefOid: headSha, state: 'OPEN', mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', statusCheckRollup: [] };
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const callsPath = ${JSON.stringify(callsPath)};
const previous = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8').trim().split('\\n') : [];
fs.appendFileSync(callsPath, process.pid + '\\n');
process.stdout.write(${JSON.stringify(JSON.stringify(raw))});
if (previous.length < 3) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
`, { mode: 0o755 });
    vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
    vi.mocked(GitHubProvider.prototype.fetchPrStatus).mockImplementation((number, cwd, options) =>
      fetchPrStatus(number, cwd!, options));
    const merge = vi.spyOn(GitHubProvider.prototype, 'mergePr').mockReturnValue({ success: true });
    const comment = vi.spyOn(GitHubProvider.prototype, 'commentOnPr').mockReturnValue({ success: true });
    invalidateAllResolvedConfigCache();
    initGitProvider(project);
    expect(await runMerge({ projectCwd: project, prNumber: 123, concurrency: 1,
      settings: resolveMergeSettings({ workflow: './merge-method.yaml' }) }))
      .toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    expect(comment).toHaveBeenCalledExactlyOnceWith(123, 'CI status acquisition timed out', project);
    expect(merge).not.toHaveBeenCalled();
    expect(cloneCwd).toBeDefined();
    expect(existsSync(cloneCwd!)).toBe(false);
    const pids = readFileSync(callsPath, 'utf8').trim().split('\n').map(Number);
    expect(pids).toHaveLength(4);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });

  it('最終確認の停止を既定15秒で終了させ失敗集計とcloneの後片付けへ到達する', async () => {
    writeFileSync(join(project, '.takt/config.yaml'), 'provider: claude\nvcs_provider: github\n');
    writeFileSync(join(project, 'merge-method.yaml'), [
      'name: final-status-timeout', 'initial_step: comment', 'steps:',
      '  - name: comment', '    mode: system', '    effects:',
      '      - type: comment_pr', '        pr: 123', '        body: Review completed',
      '    rules:', '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n') + '\n');
    const bin = join(root, 'bin');
    const pidPath = join(root, 'final-status-pid');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
    vi.mocked(GitHubProvider.prototype.fetchPrStatus).mockImplementation((number, cwd, options) =>
      fetchPrStatus(number, cwd!, options));
    vi.spyOn(GitHubProvider.prototype, 'commentOnPr').mockReturnValue({ success: true });
    const merge = vi.spyOn(GitHubProvider.prototype, 'mergePr').mockReturnValue({ success: true });
    invalidateAllResolvedConfigCache();
    initGitProvider(project);
    expect(await runMerge({ projectCwd: project, prNumber: 123, concurrency: 1,
      settings: resolveMergeSettings({ workflow: './merge-method.yaml' }) }))
      .toMatchObject({ processedCount: 1, mergedCount: 0, exitCode: 1 });
    expect(merge).not.toHaveBeenCalled();
    expect(cloneCwd).toBeDefined();
    expect(existsSync(cloneCwd!)).toBe(false);
    expect(existsSync(join(project, '.takt/runs'))).toBe(true);
    const pid = Number(readFileSync(pidPath, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
