import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPrStatus } from '../infra/github/pr-status.js';
import { PrStatusTimeoutError } from '../core/workflow/system/pr-execution-context.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import type { PrCiFailure } from '../core/workflow/system/pr-ci.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';

describe.skipIf(process.platform === 'win32')('PR status process deadline and cancellation', () => {
  let root: string;
  let callsPath: string;
  let modesPath: string;
  let clone: string;
  let headSha: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-pr-status-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    callsPath = join(root, 'calls.json');
    modesPath = join(root, 'modes.json');
    clone = join(root, 'clone');
    execFileSync('git', ['init', '--initial-branch=main', clone], { stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=Status Test', '-c', 'user.email=status@example.test',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: clone, stdio: 'pipe' });
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim();
    writeFileSync(modesPath, JSON.stringify(['success']));
    const raw = { number: 123, headRefOid: headSha, state: 'OPEN', mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', detailsUrl: null, status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const callsPath = ${JSON.stringify(callsPath)};
const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, 'utf8')) : [];
const modes = JSON.parse(fs.readFileSync(${JSON.stringify(modesPath)}, 'utf8'));
const mode = modes[Math.min(calls.length, modes.length - 1)];
calls.push({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd() });
fs.writeFileSync(callsPath, JSON.stringify(calls));
if (mode === 'failure') process.exit(1);
const raw = ${JSON.stringify(raw)};
if (mode === 'pending') raw.statusCheckRollup[0].status = 'IN_PROGRESS';
if (mode === 'delayed' || mode === 'late') setTimeout(() => process.stdout.write(JSON.stringify(raw)), mode === 'late' ? 15001 : 200);
else process.stdout.write(mode === 'invalid' ? '{' : JSON.stringify(raw));
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
`, { mode: 0o755 });
    vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
  });
  function calls(): Array<{ pid: number; args: string[]; cwd: string }> {
    return existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, 'utf8')) : [];
  }
  function modes(...values: string[]) { writeFileSync(modesPath, JSON.stringify(values)); }
  function assertStopped() {
    for (const { pid } of calls()) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }
  afterEach(() => {
    for (const { pid } of calls()) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('正常JSONを返す子プロセスの終了後に状態を返す', async () => {
    expect(await fetchPrStatus(123, root, { timeoutMs: 1000 })).toMatchObject({
      number: 123, headSha, ci: { finished: true, passed: true },
    });
    expect(calls()).toEqual([expect.objectContaining({ cwd: root, args: expect.arrayContaining(['pr', 'view', '123']) })]);
    assertStopped();
  });

  it('同じJSONを出力して停止した子プロセスを期限で終了させてから拒否する', async () => {
    modes('hang');
    await expect(fetchPrStatus(123, root, { timeoutMs: 1000 })).rejects.toBeInstanceOf(PrStatusTimeoutError);
    expect(calls()).toHaveLength(1);
    assertStopped();
  });

  it('取得中の外部中断で子プロセスを終了し期限切れと区別する', async () => {
    modes('hang');
    const controller = new AbortController();
    const running = fetchPrStatus(123, root, { timeoutMs: 5000, signal: controller.signal });
    const rejected = running.catch((error: unknown) => error);
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    controller.abort();
    expect(await rejected).toBe(controller.signal.reason);
    assertStopped();
  });

  it.each(['failure', 'invalid'])('%sを期限切れや成功へ変換しない', async (mode) => {
    modes(mode);
    const error = await fetchPrStatus(123, root, { timeoutMs: 1000 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PrStatusTimeoutError);
    assertStopped();
  });

  function engine(maxRetries: number, abortSignal?: AbortSignal, intervalMs = 1000) {
    const commentOnPr = vi.fn().mockReturnValue({ success: true });
    const mergePr = vi.fn().mockReturnValue({ success: true });
    const provider = new GitHubProvider();
    provider.commentOnPr = commentOnPr;
    provider.mergePr = mergePr;
    const config = normalizeWorkflowConfig({ name: 'status-process-wait', initial_step: 'wait_ci', steps: [
      { name: 'wait_ci', mode: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'status' }],
        wait: { until: 'when(context.wait_ci.status.ci.finished == true)', interval_ms: intervalMs,
          max_retries: maxRetries, on_timeout: 'timeout' },
        effects: [{ type: 'merge_pr', pr: 123 }], rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      { name: 'timeout', mode: 'system', effects: [{ type: 'comment_pr', pr: 123, body: 'CI status acquisition timed out' }],
        rules: [{ condition: 'when(true)', next: 'ABORT' }] },
    ] }, root);
    const instance = new WorkflowEngine(config, clone, 'Wait for PR 123', {
      projectCwd: root, provider: 'mock', abortSignal,
      structuredCaller: { judgeStatus: vi.fn(), evaluateCondition: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn() },
      prExecutionContext: { prNumber: 123, headBranch: 'feature', baseBranch: 'main', headSha,
        headRepositoryUrl: root, headRepositoryPushUrls: [root] },
      systemStepServicesFactory: (options) => createDefaultSystemStepServices({ ...options, gitProvider: provider }),
    });
    return { instance, commentOnPr, mergePr };
  }

  it.each(['delayed', 'late'])('間隔1msの初回取得を独立した15秒期限で判定する（%s）', async (mode) => {
    modes(mode);
    const h = engine(0, undefined, 1);
    expect((await h.instance.run()).status).toBe(mode === 'delayed' ? 'completed' : 'aborted');
    expect(calls()).toHaveLength(1);
    expect(h.mergePr).toHaveBeenCalledTimes(mode === 'delayed' ? 1 : 0);
    expect(h.commentOnPr).toHaveBeenCalledTimes(mode === 'delayed' ? 0 : 1);
    if (mode === 'late') expect(h.commentOnPr).toHaveBeenCalledWith(123, expect.stringMatching(/timed out/), root);
    assertStopped();
  });

  it.each(['delayed', 'late'])('100ms待機後の再取得を独立した15秒期限で判定する（%s）', async (mode) => {
    modes('pending', mode);
    const h = engine(2, undefined, 100);
    expect((await h.instance.run()).status).toBe(mode === 'delayed' ? 'completed' : 'aborted');
    expect(calls()).toHaveLength(mode === 'delayed' ? 2 : 3);
    expect(h.instance.getState().systemContexts.get('wait_ci')).toMatchObject({
      status: { ci: { finished: mode === 'delayed', passed: mode === 'delayed' } },
    });
    expect(h.mergePr).toHaveBeenCalledTimes(mode === 'delayed' ? 1 : 0);
    expect(h.commentOnPr).toHaveBeenCalledTimes(mode === 'delayed' ? 0 : 1);
    if (mode === 'late') expect(h.commentOnPr).toHaveBeenCalledWith(123, expect.stringMatching(/timed out/), root);
    assertStopped();
  });

  it.each([0, 2])('初回と%s回の再取得が停止しても理由を対象PRへコメントしマージしない', async (maxRetries) => {
    modes('hang');
    const h = engine(maxRetries);
    expect((await h.instance.run()).status).toBe('aborted');
    expect(calls()).toHaveLength(maxRetries + 1);
    expect(h.commentOnPr).toHaveBeenCalledWith(123, expect.stringMatching(/timed out/), root);
    expect(h.mergePr).not.toHaveBeenCalled();
    assertStopped();
  });

  it('初回取得の期限切れ後に同じengineが復旧した最新状態で進む', async () => {
    modes('hang', 'success');
    const h = engine(2);
    expect((await h.instance.run()).status).toBe('completed');
    expect(calls()).toHaveLength(2);
    expect(h.mergePr).toHaveBeenCalledOnce();
    expect(h.commentOnPr).not.toHaveBeenCalled();
    assertStopped();
  });

  it.each(['internal', 'external'])('%s中断をengineから取得中の子プロセスへ伝播する', async (kind) => {
    modes('hang');
    const controller = new AbortController();
    const h = engine(2, controller.signal);
    const running = h.instance.run();
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    if (kind === 'internal') h.instance.abort();
    else controller.abort();
    expect((await running).status).toBe('aborted');
    expect(calls()).toHaveLength(1);
    expect(h.mergePr).not.toHaveBeenCalled();
    expect(h.commentOnPr).not.toHaveBeenCalled();
    assertStopped();
  });
});

describe.skipIf(process.platform === 'win32')('CI failure evidence and rerun through gh', () => {
  let root: string;
  let callsPath: string;
  let controlPath: string;
  const headSha = 'a'.repeat(40);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-ci-recovery-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    callsPath = join(root, 'calls.json');
    controlPath = join(root, 'control.json');
    writeFileSync(controlPath, JSON.stringify({ mode: 'normal', rerun: false, poll: -1 }));
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const callsPath = ${JSON.stringify(callsPath)};
const controlPath = ${JSON.stringify(controlPath)};
const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, 'utf8')) : [];
const args = process.argv.slice(2);
calls.push({ pid: process.pid, args, cwd: process.cwd() });
fs.writeFileSync(callsPath, JSON.stringify(calls));
const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
const headSha = ${JSON.stringify(headSha)};
const url = 'https://github.com/org/repo/actions/runs/10';
if (args[0] === 'pr') {
  if (control.rerun) control.poll++;
  fs.writeFileSync(controlPath, JSON.stringify(control));
  const pending = control.rerun && control.poll === 1;
  const passed = control.rerun && control.poll >= 2;
  process.stdout.write(JSON.stringify({ number: 123, headRefOid: headSha, state: 'OPEN',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit',
      status: pending ? 'IN_PROGRESS' : 'COMPLETED', conclusion: passed ? 'SUCCESS' : pending ? '' : 'FAILURE',
      detailsUrl: url + '/job/20' }] }));
} else if (args[0] === 'run' && args[1] === 'rerun') {
  if (control.mode === 'rerun-denied') { process.stderr.write('HTTP 403: rerun denied'); process.exit(1); }
  control.rerun = true;
  fs.writeFileSync(controlPath, JSON.stringify(control));
} else if (args.includes('--log') || args.includes('--log-failed')) {
  if (control.mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
  else if (control.mode === 'denied') { process.stderr.write('HTTP 403: log access denied'); process.exit(1); }
  else if (control.mode === 'overflow') process.stdout.write('x'.repeat(8 * 1024 * 1024) + 'TAIL: assertion failed');
  else if (control.mode === 'blank-large') process.stdout.write(' '.repeat(8 * 1024 * 1024));
  else if (control.mode === 'excessive') process.stdout.write('x'.repeat(65 * 1024 * 1024));
  else if (control.mode !== 'empty') process.stdout.write('math.test.ts > adds\\nAssertionError: expected 2 to equal 3');
} else if (args[0] === 'run' && args[1] === 'view') {
  const attempt = control.rerun && control.poll >= 1 ? 2 : 1;
  const pending = control.rerun && control.poll === 1;
  const passed = control.rerun && control.poll >= 2 && control.mode !== 'rerun-failure-stale-rollup';
  process.stdout.write(JSON.stringify({ databaseId: 10, url, headSha, attempt,
    status: pending ? 'in_progress' : 'completed', conclusion: passed ? 'success' : pending ? '' : 'failure',
    jobs: [{ databaseId: 20, name: 'unit', url: url + '/job/20',
      status: pending ? 'in_progress' : 'completed', conclusion: passed ? 'success' : 'failure', steps: [] }] }));
} else { process.stderr.write('Unexpected gh operation: ' + JSON.stringify(args)); process.exit(2); }
`, { mode: 0o755 });
    vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
    vi.stubEnv('HOME', root);
    vi.stubEnv('GH_CONFIG_DIR', join(root, 'gh-config'));
  });

  function calls(): Array<{ pid: number; args: string[]; cwd: string }> {
    return existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, 'utf8')) : [];
  }
  function setMode(mode: string) {
    writeFileSync(controlPath, JSON.stringify({ mode, rerun: false, poll: -1 }));
  }
  function evidence(provider: GitHubProvider, options: { timeoutMs: number; signal?: AbortSignal }) {
    return provider.fetchPrCiFailure(123, headSha, root, options);
  }
  function rerun(provider: GitHubProvider, failure: PrCiFailure) {
    return provider.rerunPrCi(failure, root, { timeoutMs: 1000 });
  }
  function assertStopped() {
    for (const { pid } of calls()) expect(() => process.kill(pid, 0)).toThrow();
  }
  afterEach(() => {
    for (const { pid } of calls()) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('本番Providerから失敗run・jobのログを取得して調査に必要なテスト名とアサーションを返す', async () => {
    const result = await evidence(new GitHubProvider(), { timeoutMs: 1000 });
    expect(result).toMatchObject({ number: 123, headSha, complete: true, checks: [
      { name: 'unit', run: { id: 10, attempt: 1 },
        jobs: [{ id: 20, log: expect.stringMatching(/math\.test\.ts > adds[\s\S]*expected 2 to equal 3/) }] },
    ] });
    expect(calls().every(({ cwd }) => cwd === root)).toBe(true);
    expect(calls().some(({ args }) => args[0] === 'run' && (args.includes('--log-failed') || args.includes('--log')))).toBe(true);
    assertStopped();
  });

  it('同じProviderとHEADで旧失敗から再実行受付・旧attempt・新attempt実行中・成功まで追従する', async () => {
    const provider = new GitHubProvider();
    expect(await provider.fetchPrStatus(123, root)).toMatchObject({ ci: { finished: true, passed: false } });
    const failure = await evidence(provider, { timeoutMs: 1000 });
    const accepted = await rerun(provider, failure);
    expect(accepted).toMatchObject({ success: true, number: 123, headSha, runs: [{ id: 10, attempt: 1 }] });
    const status = () => provider.fetchPrStatus(123, root, { timeoutMs: 1000, rerun: accepted });
    expect(await status()).toMatchObject({ headSha, ci: { finished: false, passed: false } });
    expect(await status()).toMatchObject({ headSha, ci: { finished: false, passed: false } });
    expect(await status()).toMatchObject({ headSha, ci: { finished: true, passed: true } });
    const reruns = calls().filter(({ args }) => args[0] === 'run' && args[1] === 'rerun');
    expect(reruns).toHaveLength(1);
    expect(reruns[0]?.args).toContain('10');
    assertStopped();
  });

  it.each(['denied', 'empty', 'blank-large', 'excessive'])('ログ取得の%sを無言で切り捨てず証拠不足として返す', async (mode) => {
    setMode(mode);
    expect(await evidence(new GitHubProvider(), { timeoutMs: 5000 })).toMatchObject({ complete: false,
      unavailable: expect.arrayContaining([expect.objectContaining({ reason: expect.any(String) })]) });
    expect(calls().some(({ args }) => args.includes('--log-failed') || args.includes('--log'))).toBe(true);
    assertStopped();
  });

  it('1 MiBを超える失敗ログの末尾だけを切り詰めた印とともに保持する', async () => {
    setMode('overflow');
    const result = await evidence(new GitHubProvider(), { timeoutMs: 5000 });
    expect(result.complete).toBe(true);
    const log = result.checks[0]?.jobs[0]?.log;
    expect(log).toMatch(/^\[truncated: last 200000 characters\]\n/);
    expect(log).toMatch(/TAIL: assertion failed$/);
    expect(log?.length).toBeLessThan(201_000);
    assertStopped();
  });

  it('再実行後のrollupが旧成功を返しても新attemptの失敗状態とログを調査へ渡す', async () => {
    setMode('rerun-failure-stale-rollup');
    const provider = new GitHubProvider();
    const failure = await provider.fetchPrCiFailure(123, headSha, root, { timeoutMs: 1000 });
    const accepted = await provider.rerunPrCi(failure, root, { timeoutMs: 1000 });
    const options = { timeoutMs: 1000, rerun: accepted };
    expect((await provider.fetchPrStatus(123, root, options)).ci.finished).toBe(false);
    expect((await provider.fetchPrStatus(123, root, options)).ci.finished).toBe(false);
    expect((await provider.fetchPrStatus(123, root, options)).ci).toMatchObject({ finished: true, passed: false });
    const latest = await provider.fetchPrCiFailure(123, headSha, root, options);
    expect(latest).toMatchObject({ complete: true, checks: [{ run: { id: 10, attempt: 2 },
      jobs: [{ id: 20, log: expect.stringContaining('expected 2 to equal 3') }] }] });
    const logCalls = calls().filter(({ args }) => args.includes('--log-failed'));
    expect(logCalls.at(-1)?.args).toEqual(expect.arrayContaining(['--attempt', '2', '--job', '20']));
    assertStopped();
  });

  it('失敗ログ取得の期限で子プロセスを終了して証拠不足を報告する', async () => {
    setMode('hang');
    expect(await evidence(new GitHubProvider(), { timeoutMs: 1000 })).toMatchObject({ complete: false,
      unavailable: expect.arrayContaining([expect.objectContaining({ reason: expect.any(String) })]) });
    expect(calls().some(({ args }) => args.includes('--log-failed') || args.includes('--log'))).toBe(true);
    assertStopped();
  });

  it('失敗ログ取得中の中断を伝播して子プロセスを終了する', async () => {
    setMode('hang');
    const controller = new AbortController();
    const running = evidence(new GitHubProvider(), { timeoutMs: 5000, signal: controller.signal });
    const rejected = running.catch((error: unknown) => error);
    await vi.waitFor(() => expect(calls().some(({ args }) => args.includes('--log-failed') || args.includes('--log'))).toBe(true));
    controller.abort();
    expect(await rejected).toBe(controller.signal.reason);
    assertStopped();
  });

  it('再実行APIの権限不足を成功へ変換しない', async () => {
    const provider = new GitHubProvider();
    const failure = await evidence(provider, { timeoutMs: 1000 });
    setMode('rerun-denied');
    expect(await rerun(provider, failure)).toMatchObject({ success: false });
    expect(calls().filter(({ args }) => args[0] === 'run' && args[1] === 'rerun')).toHaveLength(1);
    assertStopped();
  });
});
