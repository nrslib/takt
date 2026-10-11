import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import { WorkflowEngine } from '../index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { createPrCloneGitOperations } from '../infra/workflow/system/pr-clone-git.js';
import { createCacciaCloneGitOperations } from '../infra/workflow/system/caccia-clone-git.js';

describe('PR correction commit and push', () => {
  let root: string;
  let project: string;
  let fork: string;
  let clone: string;
  let originalHead: string;
  let server: ChildProcess | undefined;
  function git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-merge-push-'));
    project = join(root, 'project');
    fork = join(root, 'fork.git');
    clone = join(root, 'clone');
    git(root, 'init', '--initial-branch=main', project);
    git(project, 'config', 'user.name', 'Merge Test');
    git(project, 'config', 'user.email', 'merge@example.com');
    writeFileSync(join(project, 'code.txt'), 'base\n');
    git(project, 'add', 'code.txt');
    git(project, 'commit', '-m', 'base');
    git(root, 'clone', '--bare', project, fork);
    git(root, 'clone', fork, clone);
    git(clone, 'config', 'user.name', 'Merge Test');
    git(clone, 'config', 'user.email', 'merge@example.com');
    git(clone, 'checkout', '-b', 'feature/pr');
    git(clone, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
    originalHead = git(clone, 'rev-parse', 'HEAD');
  });
  afterEach(async () => {
    if (server && server.exitCode === null) {
      const stopped = once(server, 'exit'); server.kill(); await stopped;
    }
    server = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['PR', 'Caccia', 'effect'])('%sの通常HTTPS認証でfetch・pushしremote headを更新する', async (owner) => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'), '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' });
    git(fork, 'config', 'http.receivepack', 'true');
    vi.stubEnv('GIT_SSL_CAINFO', join(root, 'cert.pem'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    writeFileSync(join(root, 'global.gitconfig'), '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'global.gitconfig'));
    for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) vi.stubEnv(key, undefined);
    server = spawn(process.execPath, [join(process.cwd(), 'src/__tests__/helpers/merge-git-server.mjs')], {
      env: { ...process.env, MERGE_TEST_ROOT: root, MERGE_TEST_ROUTES: JSON.stringify([{ path: 'fork.git', credential: 'fixture:credential' }]),
        MERGE_TEST_REQUEST_LOG: join(root, 'request-log') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const [chunk] = await once(server.stdout!, 'data');
    const url = `https://fixture:credential@localhost:${Number(chunk.toString().trim())}/fork.git`;
    git(clone, 'remote', 'set-url', 'origin', url);
    const input = { cwd: clone, headRepositoryUrl: url, headRepositoryPushUrls: [url] };
    if (owner === 'effect') {
      git(clone, 'remote', 'add', 'base', url);
      const services = createDefaultSystemStepServices({ cwd: clone, projectCwd: project, task: 'Sync PR 123',
        prExecutionContext: context([url]),
      });
      const state = { workflowName: 'merge', currentStep: 'sync', iteration: 1,
        systemContexts: new Map(), effectResults: new Map() };
      expect(await Reflect.apply(services.executeEffect, services, [
        { type: 'sync_with_root', pr: 123 }, { pr: 123 }, state,
      ])).toMatchObject({ success: true });
      expect(git(clone, 'rev-parse', 'FETCH_HEAD')).toBe(originalHead);
      writeFileSync(join(clone, 'code.txt'), 'authenticated correction\n');
      expect(await commitAndPush(url)).toMatchObject({ success: true });
    } else {
      const result = owner === 'PR' ? await createPrCloneGitOperations({ ...input, baseRepositoryUrl: project })
        : await createCacciaCloneGitOperations(input);
      if (owner === 'PR') await (result.operations as Awaited<ReturnType<typeof createPrCloneGitOperations>>['operations']).fetch('origin', 'refs/heads/feature/pr');
      else await (result.operations as Awaited<ReturnType<typeof createCacciaCloneGitOperations>>['operations']).fetch('refs/heads/feature/pr');
      expect(git(clone, 'rev-parse', 'FETCH_HEAD')).toBe(originalHead);
      writeFileSync(join(clone, 'code.txt'), 'authenticated correction\n');
      git(clone, 'add', 'code.txt'); git(clone, 'commit', '-m', 'correction');
      await result.operations.push('HEAD:refs/heads/feature/pr');
    }
    expect(git(fork, 'rev-parse', 'feature/pr')).toBe(git(clone, 'rev-parse', 'HEAD'));
    expect(git(fork, 'show', 'feature/pr:code.txt')).toBe('authenticated correction');
    expect(readFileSync(join(root, 'request-log'), 'utf8')).toContain('"authenticated":true');
  });

  function context(pushUrls: readonly string[]) {
    return { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main',
      headSha: originalHead, headRepositoryUrl: fork, headRepositoryPushUrls: pushUrls };
  }

  function commitAndPush(pushUrl = fork) {
    const services = createDefaultSystemStepServices({ cwd: clone, projectCwd: project, task: 'Fix PR 123',
      prExecutionContext: context([pushUrl]),
    });
    return Reflect.apply(services.executeEffect, services, [
      { type: 'commit_and_push', pr: 123 }, { pr: 123 },
      { workflowName: 'merge', currentStep: 'push', iteration: 1, systemContexts: new Map(), effectResults: new Map() },
    ]) as Promise<Record<string, unknown>>;
  }

  it('クローンの修正をforkの対象headへcommit/pushしrootとbaseを変更しない', async () => {
    writeFileSync(join(clone, 'code.txt'), 'fixed\n');
    expect(await commitAndPush()).toMatchObject({ success: true, failed: false });
    const pushedHead = git(fork, 'rev-parse', 'refs/heads/feature/pr');
    expect(pushedHead).not.toBe(originalHead);
    expect(pushedHead).toBe(git(clone, 'rev-parse', 'HEAD'));
    expect(git(fork, 'show', 'feature/pr:code.txt')).toBe('fixed');
    expect(git(fork, 'rev-parse', 'refs/heads/main')).toBe(originalHead);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(readFileSync(join(project, 'code.txt'), 'utf8')).toBe('base\n');
    expect(git(project, 'status', '--porcelain')).toBe('');
  });

  async function enginePush(pushUrls: readonly string[]) {
    const workflow = normalizeWorkflowConfig({ name: 'public-pr-push', initial_step: 'push', steps: [
      { name: 'push', mode: 'system', effects: [{ type: 'commit_and_push', pr: 123 }], rules: [
        { condition: 'when(effect.push.commit_and_push.success == true)', next: 'accepted' },
        { condition: 'when(true)', next: 'ABORT' },
      ] },
      { name: 'accepted', mode: 'system', rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
    ] }, project);
    const engine = new WorkflowEngine(workflow, clone, 'Fix PR 123', {
      projectCwd: project, provider: 'mock', prExecutionContext: context(pushUrls),
      runPathsDirectory: join(project, '.takt/runs'),
      systemStepServicesFactory: createDefaultSystemStepServices,
    });
    return engine.run();
  }

  it('公開engineはoriginをdecoyへ変更してもcontextのforkだけへ送信する', async () => {
    const decoy = join(root, 'decoy.git');
    git(root, 'clone', '--bare', fork, decoy);
    git(clone, 'remote', 'set-url', 'origin', decoy);
    writeFileSync(join(clone, 'code.txt'), 'public API fix\n');
    const result = await enginePush([fork]);
    expect(result.status).toBe('completed');
    const effect = result.effectResults.get('push')?.commit_and_push as Record<string, unknown>;
    expect(effect).toMatchObject({ success: true, failed: false });
    expect(git(fork, 'rev-parse', 'feature/pr')).toBe(effect.headSha);
    expect(git(fork, 'show', 'feature/pr:code.txt')).toBe('public API fix');
    expect(git(decoy, 'rev-parse', 'feature/pr')).toBe(originalHead);
    expect(git(decoy, 'show', 'feature/pr:code.txt')).toBe('base');
  });

  it.each([{ urls: [] }, { urls: ['origin'] }, { urls: ['./relative.git'] }])('公開engineは送信先$urlsを確定できなければ成功分岐へ進まない', async ({ urls }) => {
    writeFileSync(join(clone, 'code.txt'), 'unsent fix\n');
    const result = await enginePush(urls);
    expect(result.status).toBe('aborted');
    expect(result.effectResults.get('push')?.commit_and_push).toMatchObject({ success: false, failed: true });
    expect(result.stepOutputs.has('accepted')).toBe(false);
    expect(git(fork, 'rev-parse', 'feature/pr')).toBe(originalHead);
    expect(git(fork, 'show', 'feature/pr:code.txt')).toBe('base');
    expect(git(clone, 'rev-parse', 'HEAD')).not.toBe(originalHead);
  });

  it.each([false, true])('公開engineは複数送信先の後続拒否=%sを全体結果へ反映する', async (rejectMirror) => {
    const mirror = join(root, 'mirror.git');
    const last = join(root, 'last.git');
    for (const remote of [mirror, last]) git(root, 'clone', '--bare', fork, remote);
    mkdirSync(join(mirror, 'hooks'), { recursive: true });
    git(mirror, 'config', 'core.hooksPath', join(mirror, 'hooks'));
    writeFileSync(join(mirror, 'hooks/pre-receive'), `#!/bin/sh\nexit ${rejectMirror ? 1 : 0}\n`, { mode: 0o755 });
    writeFileSync(join(clone, 'code.txt'), 'mirrored fix\n');
    const result = await enginePush([fork, mirror, last]);
    expect(result.status).toBe(rejectMirror ? 'aborted' : 'completed');
    expect(result.effectResults.get('push')?.commit_and_push).toMatchObject({ success: !rejectMirror, failed: rejectMirror });
    const head = git(clone, 'rev-parse', 'HEAD');
    expect(git(fork, 'rev-parse', 'feature/pr')).toBe(head);
    expect(git(fork, 'show', 'feature/pr:code.txt')).toBe('mirrored fix');
    for (const remote of [mirror, last]) {
      expect(git(remote, 'rev-parse', 'feature/pr')).toBe(rejectMirror ? originalHead : head);
      expect(git(remote, 'show', 'feature/pr:code.txt')).toBe(rejectMirror ? 'base' : 'mirrored fix');
    }
  });

  it('変更がなければ空commitを作らずPRのheadを保持する', async () => {
    expect(await commitAndPush()).toMatchObject({ success: true, failed: false });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(git(fork, 'rev-parse', 'refs/heads/feature/pr')).toBe(originalHead);
  });

  it('Cacciaの通常push拒否でも後続remoteへ送信し最初の失敗を返す', async () => {
    const mirror = join(root, 'mirror.git'); git(root, 'clone', '--bare', fork, mirror);
    mkdirSync(join(fork, 'hooks'), { recursive: true });
    git(fork, 'config', 'core.hooksPath', join(fork, 'hooks'));
    writeFileSync(join(fork, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = await createCacciaCloneGitOperations({ cwd: clone, headRepositoryUrl: fork, headRepositoryPushUrls: [fork, mirror] });
    writeFileSync(join(clone, 'code.txt'), 'Caccia correction\n');
    git(clone, 'add', 'code.txt'); git(clone, 'commit', '-m', 'correction');
    await expect(result.operations.push('HEAD:refs/heads/feature/pr')).rejects.toThrow();
    expect(git(fork, 'rev-parse', 'feature/pr')).toBe(originalHead);
    expect(git(mirror, 'rev-parse', 'feature/pr')).toBe(git(clone, 'rev-parse', 'HEAD'));
    expect(git(mirror, 'show', 'feature/pr:code.txt')).toBe('Caccia correction');
  });

  it('push失敗を成功扱いせず外部PRのheadを進めない', async () => {
    const missingRemote = join(root, 'missing.git');
    git(clone, 'remote', 'set-url', '--push', 'origin', missingRemote);
    writeFileSync(join(clone, 'code.txt'), 'fixed\n');
    const result = await commitAndPush(missingRemote);
    expect(result).toMatchObject({ success: false, failed: true });
    expect(git(fork, 'rev-parse', 'refs/heads/feature/pr')).toBe(originalHead);
    expect(git(project, 'rev-parse', 'HEAD')).toBe(originalHead);
  });

  it('同じPR cloneでbaseを同期してからforkへpushしrootとforkのbaseを保持する', async () => {
    writeFileSync(join(clone, 'pr-only.txt'), 'PR change\n');
    git(clone, 'add', 'pr-only.txt');
    git(clone, 'commit', '-m', 'PR change');
    git(clone, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
    writeFileSync(join(project, 'base-only.txt'), 'New base\n');
    git(project, 'add', 'base-only.txt');
    git(project, 'commit', '-m', 'base advance');
    const rootHead = git(project, 'rev-parse', 'HEAD');
    git(clone, 'remote', 'add', 'base', project);
    const services = createDefaultSystemStepServices({
      cwd: clone, projectCwd: project, task: 'Review PR',
      prExecutionContext: { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main',
        headSha: git(clone, 'rev-parse', 'HEAD'), headRepositoryUrl: fork, headRepositoryPushUrls: [fork] },
    });
    const state = { systemContexts: new Map(), effectResults: new Map() };
    const result = await Reflect.apply(services.executeEffect, services, [
      { type: 'sync_with_root', pr: 123 }, { pr: 123 }, state,
    ]);
    expect(result).toMatchObject({ success: true, conflicted: false });
    expect(readFileSync(join(clone, 'base-only.txt'), 'utf8')).toBe('New base\n');
    expect(readFileSync(join(clone, 'pr-only.txt'), 'utf8')).toBe('PR change\n');
    expect(await commitAndPush()).toMatchObject({ success: true });
    expect(git(fork, 'show', 'feature/pr:base-only.txt')).toBe('New base');
    expect(git(project, 'rev-parse', 'HEAD')).toBe(rootHead);
    expect(git(project, 'status', '--porcelain')).toBe('');
    expect(git(fork, 'rev-parse', 'refs/heads/main')).toBe(originalHead);
  });
});
