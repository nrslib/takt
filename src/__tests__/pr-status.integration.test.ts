import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPrStatus } from '../infra/github/pr-status.js';
import { PrStatusTimeoutError } from '../core/workflow/system/pr-execution-context.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
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
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
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
