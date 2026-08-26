import { lstat, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunCollection, readRunDetail } from '../features/web-ui/run-store.js';
import { createWebUiServer, listenWebUiServer } from '../features/web-ui/server.js';
import {
  acquireWebUiInstanceLock,
  readWebUiInstance,
  stopWebUiInstance,
} from '../features/web-ui/instance-lock.js';
import type { WebChatService } from '../features/web-ui/chat.js';
import { resolveStatePaths, type StatePaths } from '../core/execution/locations.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { CentralTaskRepository } from '../infra/task/centralStateRepository.js';

const servers: Server[] = [];
const temporaryDirectories = new Set<string>();

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}

function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.once('end', () => resolvePromise(response.statusCode ?? 0));
    });
    request.once('error', rejectPromise);
    request.end();
  });
}

afterEach(async () => {
  const activeServers = servers.splice(0);
  const directories = [...temporaryDirectories];
  temporaryDirectories.clear();
  try {
    await Promise.all(activeServers.map((server) => closeServer(server)));
  } finally {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }
});

async function createProject(): Promise<string> {
  return createTemporaryDirectory('takt-web-ui-');
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.add(directory);
  return directory;
}

async function createArtifactState(): Promise<StatePaths> {
  const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
  const projectDirectory = await createProject();
  const project = await registerProject({ globalConfigDirectory, projectDirectory, command: 'run' });
  return resolveStatePaths(globalConfigDirectory, project.stateId);
}

async function writeRun(
  statePaths: StatePaths,
  slug: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const runRoot = join(statePaths.runsDirectory, slug);
  await mkdir(join(runRoot, 'reports'), { recursive: true });
  await mkdir(join(runRoot, 'logs'), { recursive: true });
  const meta = {
    task: `Task for ${slug}`,
    workflow: 'default',
    runSlug: slug,
    runRoot: `runs/${slug}`,
    reportDirectory: `runs/${slug}/reports`,
    contextDirectory: `runs/${slug}/context`,
    logsDirectory: `runs/${slug}/logs`,
    status: 'running',
    startTime: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
  await writeFile(join(runRoot, 'meta.json'), JSON.stringify(meta));
  return runRoot;
}

describe('Web UI run artifacts', () => {
  it('lists runs newest first and ignores directories without meta', async () => {
    const statePaths = await createArtifactState();
    await writeRun(statePaths, 'older', { startTime: '2026-08-23T00:00:00.000Z' });
    await writeRun(statePaths, 'newer', { startTime: '2026-08-24T00:00:00.000Z' });
    await mkdir(join(statePaths.runsDirectory, 'debug-output'));

    const result = await readRunCollection(statePaths);

    expect(result.runs.map((run) => run.slug)).toEqual(['newer', 'older']);
    expect(result.warnings).toEqual([]);
  });

  it('returns reports and concise live session events without sidecars', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'detail', {
      currentStep: 'implement',
      currentIteration: 3,
    });
    await writeFile(join(runRoot, 'reports', 'implementation.md'), '# Result\nDone');
    await writeFile(join(runRoot, 'logs', 'session.jsonl'), [
      JSON.stringify({
        type: 'phase_start',
        step: 'implement',
        phaseName: 'execute',
        timestamp: '2026-08-24T00:00:01.000Z',
        systemPrompt: 'must not be exposed',
      }),
      JSON.stringify({
        type: 'phase_complete',
        step: 'implement',
        phaseName: 'execute',
        status: 'done',
        content: 'Implemented',
        timestamp: '2026-08-24T00:00:02.000Z',
      }),
      '',
    ].join('\n'));
    await writeFile(
      join(runRoot, 'logs', 'session-provider-events.jsonl'),
      JSON.stringify({ type: 'provider_secret', content: 'ignored' }),
    );

    const detail = await readRunDetail(statePaths, 'detail');

    expect(detail.reports).toEqual([{
      filename: 'implementation.md',
      content: '# Result\nDone',
      omitted: false,
    }]);
    expect(detail.events).toEqual([
      {
        type: 'phase_complete',
        step: 'implement',
        phaseName: 'execute',
        status: 'done',
        content: 'Implemented',
        timestamp: '2026-08-24T00:00:02.000Z',
      },
      {
        type: 'phase_start',
        step: 'implement',
        phaseName: 'execute',
        timestamp: '2026-08-24T00:00:01.000Z',
      },
    ]);
  });

  it('rejects artifact directories outside the selected run', async () => {
    const statePaths = await createArtifactState();
    await writeRun(statePaths, 'unsafe', { logsDirectory: 'runs' });

    await expect(readRunDetail(statePaths, 'unsafe')).rejects.toThrow(
      'Logs directory is outside the run directory',
    );
  });

  it('warns and ignores a symlinked run root', async () => {
    const statePaths = await createArtifactState();
    const target = await writeRun(statePaths, 'target');
    await symlink(target, join(statePaths.runsDirectory, 'linked'));

    const result = await readRunCollection(statePaths);

    expect(result.runs.map((run) => run.slug)).toEqual(['target']);
    expect(result.warnings).toContain('linked: run root must not be a symbolic link');
  });

  it('rejects a symlinked runs collection root before enumeration', async () => {
    const statePaths = await createArtifactState();
    await mkdir(statePaths.stateDirectory, { recursive: true });
    const outside = await createTemporaryDirectory('takt-web-ui-runs-outside-');
    await symlink(outside, statePaths.runsDirectory);

    await expect(readRunCollection(statePaths)).rejects.toThrow(/symbolic link|runs directory/i);
  });

  it('rejects an ordinary runs-root replacement with the expected inode', async () => {
    const statePaths = await createArtifactState();
    await mkdir(statePaths.runsDirectory, { recursive: true });
    const original = await lstat(statePaths.runsDirectory);
    const pinned = {
      ...statePaths,
      runsRootFingerprint: { dev: original.dev, ino: original.ino },
    };
    // Create the replacement while the original is still present. This makes
    // the differing inode deterministic on filesystems that eagerly reuse
    // deleted directory inodes.
    const replacementPath = join(statePaths.stateDirectory, 'runs-replacement');
    await mkdir(replacementPath);
    await rm(statePaths.runsDirectory, { recursive: true, force: true });
    await rename(replacementPath, statePaths.runsDirectory);
    const replacement = await lstat(statePaths.runsDirectory);
    expect(replacement.ino).not.toBe(original.ino);

    await expect(readRunCollection(pinned)).rejects.toThrow(/fingerprint|identity/i);
  });

  it('rejects a symlinked report root before reading outside the run', async () => {
    const statePaths = await createArtifactState();
    const runRoot = await writeRun(statePaths, 'symlink-report');
    const outside = await createTemporaryDirectory('takt-web-ui-outside-');
    await rm(join(runRoot, 'reports'), { recursive: true, force: true });
    await symlink(outside, join(runRoot, 'reports'));

    await expect(readRunDetail(statePaths, 'symlink-report')).rejects.toThrow(/symbolic link/i);
  });
});

describe('Web UI HTTP boundary', () => {
  it('gracefully stops the owned Web UI through its private control endpoint', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const projectDirectory = await createProject();
    const project = await registerProject({ globalConfigDirectory, projectDirectory, command: 'ui' });
    const repository = await CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    });
    const execution = await repository.enqueueAndClaim({
      task: 'keep running across UI restart',
      workflow: 'default',
      worktree: false,
    });
    await repository.setStartingPid({
      taskId: execution.task.taskId,
      generation: execution.task.generation,
      executionId: execution.executionId,
      ownerToken: execution.ownerToken,
      pid: process.pid,
      runId: execution.runId,
    });
    const lock = await acquireWebUiInstanceLock(globalConfigDirectory, 0);
    let server: Server | undefined;
    server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
      control: {
        token: lock.controlToken,
        onStopRequested: () => server?.close(),
      },
    });
    servers.push(server);
    server.once('close', () => {
      void lock.release();
    });
    const origin = await listenWebUiServer(server, 0);
    await lock.publishOrigin(origin);

    await expect(fetch(`${origin}/api/control/stop`, { method: 'POST' }))
      .resolves.toMatchObject({ status: 403 });
    await expect(stopWebUiInstance(globalConfigDirectory)).resolves.toMatchObject({
      disposition: 'stopped',
      instance: { origin, pid: process.pid },
    });

    expect(server.listening).toBe(false);
    await expect(readWebUiInstance(globalConfigDirectory)).resolves.toBeUndefined();
    await expect(repository.readTask(execution.task.taskId)).resolves.toMatchObject({
      status: 'starting',
      activeExecution: { pid: process.pid, runId: execution.runId },
    });
    servers.splice(servers.indexOf(server), 1);
  });

  it('rejects non-loopback Host and Origin before exposing the session token', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    await expect(requestStatus(`${origin}/api/session`, { Host: 'attacker.example' }))
      .resolves.toBe(403);
    await expect(fetch(`${origin}/api/session`, { headers: { Origin: 'http://attacker.example' } }))
      .resolves.toMatchObject({ status: 403 });
  });

  it('serves a chat-only composer with header execution context', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    const response = await fetch(origin);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<details id="execution-context" class="execution-context" open>');
    expect(html.indexOf('id="execution-context"')).toBeLessThan(html.indexOf('<main'));
    expect(html).toContain('<section id="chat-panel" class="chat-panel">');
    expect(html).toContain('rows="1"');
    expect(html).toContain('aria-keyshortcuts="Meta+Enter Control+Enter"');
    expect(html).toContain('id="chat-go-button"');
    expect(html).toContain('id="chat-setup-button"');
    expect(html).toContain('id="watch-button"');
    expect(html).toContain('id="refresh-button"');
    expect(html).toContain('id="chat-new-button"');
    expect(html).toContain('>新しい会話</button>');
    expect(html).toContain('id="chat-thinking"');
    expect(html).toContain('id="chat-thinking-content"');
    expect(html).toContain('id="chat-collapse-button"');
    expect(html).toContain('id="chat-resizer"');
    expect(html).toContain('role="separator"');
    expect(html).not.toContain('data-composer-mode');
    expect(html).not.toContain('id="run-form"');

    const uiStateResponse = await fetch(`${origin}/ui-state.js`);
    expect(uiStateResponse.status).toBe(200);
  });

  it('browses and registers an unregistered execution directory', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const parentDirectory = await createTemporaryDirectory('takt-directory-browser-');
    const projectDirectory = join(parentDirectory, 'new-project');
    await mkdir(projectDirectory);
    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
      pickNativeDirectory: async () => ({ cancelled: false, path: projectDirectory }),
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    const logoResponse = await fetch(`${origin}/takt-logo.svg`);
    expect(logoResponse.status).toBe(200);
    expect(logoResponse.headers.get('content-type')).toBe('image/svg+xml');
    expect(await logoResponse.text()).toContain('#5bbb91');

    const unauthorized = await fetch(`${origin}/api/directories/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: parentDirectory }),
    });
    expect(unauthorized.status).toBe(403);

    const token = (await (await fetch(`${origin}/api/session`)).json() as { token: string }).token;
    const nativePickerResponse = await fetch(`${origin}/api/directories/native-picker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: '{}',
    });
    expect(nativePickerResponse.status).toBe(200);
    await expect(nativePickerResponse.json()).resolves.toMatchObject({
      cancelled: false,
      directory: { path: projectDirectory },
    });

    const browseResponse = await fetch(`${origin}/api/directories/browse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ path: parentDirectory }),
    });
    expect(browseResponse.status).toBe(200);
    await expect(browseResponse.json()).resolves.toMatchObject({
      path: parentDirectory,
      directories: [{ name: 'new-project', path: projectDirectory }],
    });

    const registerResponse = await fetch(`${origin}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ projectDirectory }),
    });
    expect(registerResponse.status).toBe(201);
    const registered = await registerResponse.json() as { id: string };

    await expect((await fetch(`${origin}/api/projects`)).json()).resolves.toMatchObject({
      projects: [{ id: registered.id, projectDirectory, lastCommand: 'ui', available: true }],
    });

    const relativePath = await fetch(`${origin}/api/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ projectDirectory: 'relative/project' }),
    });
    expect(relativePath.status).toBe(400);
  });

  it('serves runs and accepts token-authenticated launches', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const projectDirectory = await createProject();
    const project = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'run',
    });
    const central = await CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    });
    const centralTask = await central.enqueueAndClaim({
      task: 'Task for 20260824-example',
      workflow: 'default',
      worktree: false,
    });
    await writeRun(central.paths, centralTask.runId);
    const launches: unknown[] = [];
    const requeues: unknown[] = [];
    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async (directory, request) => {
        launches.push({ directory, request });
        return { pid: 9001, disposition: 'started' as const, mode: 'run' as const };
      },
      requeue: async (directory, taskId) => {
        requeues.push({ directory, taskId });
        return { pid: 9002, disposition: 'started' as const, mode: 'run' as const };
      },
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    const listResponse = await fetch(`${origin}/api/tasks`);
    expect(listResponse.status).toBe(200);
    const tasks = (await listResponse.json() as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: centralTask.task.taskId,
      projectId: project.id,
      projectDirectory,
      runs: [{ slug: centralTask.runId, attempt: 1 }],
    });

    const projectsResponse = await fetch(`${origin}/api/projects`);
    expect(projectsResponse.status).toBe(200);
    await expect(projectsResponse.json()).resolves.toMatchObject({
      projects: [{ id: project.id, projectDirectory, available: true }],
    });

    const rejected = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, prompt: 'Build it', workflow: 'default' }),
    });
    expect(rejected.status).toBe(403);

    const token = (await (await fetch(`${origin}/api/session`)).json() as { token: string }).token;
    const invalidProject = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({
        projectId: 'f'.repeat(64),
        prompt: 'Build it',
        workflow: 'default',
      }),
    });
    expect(invalidProject.status).toBe(400);

    const accepted = await fetch(`${origin}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ projectId: project.id, prompt: 'Build it', workflow: 'default' }),
    });
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({
      pid: 9001,
      disposition: 'started',
      mode: 'run',
    });
    expect(launches).toEqual([{
      directory: projectDirectory,
      request: {
        prompt: 'Build it',
        workflow: 'default',
        worktree: true,
        autoPr: false,
        draftPr: false,
      },
    }]);

    const requeueResponse = await fetch(`${origin}/api/tasks/${centralTask.task.taskId}/requeue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(requeueResponse.status).toBe(202);
    await expect(requeueResponse.json()).resolves.toEqual({
      pid: 9002,
      disposition: 'started',
      mode: 'run',
    });
    expect(requeues).toEqual([{ directory: projectDirectory, taskId: centralTask.task.taskId }]);
  });

  it('joins project discovery with central consumer status without stale cleanup', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const projectDirectory = await createProject();
    const project = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'run',
    });
    const central = await CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    });
    const acquired = await central.enqueueAndClaim({ task: 'watch', workflow: 'default', worktree: false });
    await central.setStartingPid({
      taskId: acquired.task.taskId,
      generation: acquired.task.generation,
      executionId: acquired.executionId,
      ownerToken: acquired.ownerToken,
      pid: process.pid,
    });

    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'reused' as const, mode: 'watch' as const }),
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    await expect((await fetch(`${origin}/api/projects`)).json()).resolves.toMatchObject({
      projects: [{
        id: project.id,
        state: { stateId: project.stateId, status: 'starting' },
      }],
    });
  });

  it('serves categorized workflows and token-authenticated chat messages', async () => {
    const globalConfigDirectory = await createTemporaryDirectory('takt-web-ui-global-');
    const projectDirectory = await createProject();
    const project = await registerProject({
      globalConfigDirectory,
      projectDirectory,
      command: 'run',
    });
    const messages: Array<{ sessionId: string; text: string }> = [];
    const settings: Array<{ sessionId: string; workflow: string; mode: string }> = [];
    const restarts: string[] = [];
    const chat: WebChatService = {
      create: (_directory, request) => ({
        id: 'chat-session-1',
        ...request,
        intro: '相談内容を教えてください。',
        provider: 'codex',
        model: 'gpt-5',
      }),
      reconfigure: (sessionId, request) => {
        settings.push({ sessionId, ...request });
        return {
          id: sessionId,
          ...request,
          intro: '切り替えました。',
          provider: 'codex',
          model: 'gpt-5',
        };
      },
      restart: (sessionId) => {
        restarts.push(sessionId);
        return {
          id: sessionId,
          workflow: 'review',
          mode: 'grill-me',
          intro: '新しい会話です。',
          provider: 'codex',
          model: 'gpt-5',
        };
      },
      send: async (sessionId, text, onThinking) => {
        messages.push({ sessionId, text });
        onThinking?.('確認しています。');
        if (text === '失敗する') throw new Error('provider failed');
        return { kind: 'assistant_response', content: '回答です。' };
      },
    };
    const server = await createWebUiServer({
      globalConfigDirectory,
      launch: async () => ({ pid: 9001, disposition: 'started' as const, mode: 'run' as const }),
      getWorkflowCatalog: () => ({
        categories: [{
          id: 'development',
          label: '開発',
          workflows: [{ id: 'default', description: '標準', source: 'builtin' }],
        }],
        warnings: [],
      }),
      chat,
    });
    servers.push(server);
    const origin = await listenWebUiServer(server, 0);

    await expect((await fetch(`${origin}/api/workflows?project=${project.id}`)).json()).resolves.toEqual({
      categories: [{
        id: 'development',
        label: '開発',
        workflows: [{ id: 'default', description: '標準', source: 'builtin' }],
      }],
      warnings: [],
    });

    const unauthorized = await fetch(`${origin}/api/chat/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, workflow: 'default', mode: 'assistant' }),
    });
    expect(unauthorized.status).toBe(403);

    const token = (await (await fetch(`${origin}/api/session`)).json() as { token: string }).token;
    const created = await fetch(`${origin}/api/chat/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ projectId: project.id, workflow: 'default', mode: 'assistant' }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      id: 'chat-session-1',
      workflow: 'default',
      mode: 'assistant',
    });

    const reconfigured = await fetch(`${origin}/api/chat/sessions/chat-session-1/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ workflow: 'review', mode: 'grill-me' }),
    });
    expect(reconfigured.status).toBe(200);
    await expect(reconfigured.json()).resolves.toMatchObject({
      id: 'chat-session-1',
      workflow: 'review',
      mode: 'grill-me',
    });
    expect(settings).toEqual([{
      sessionId: 'chat-session-1',
      workflow: 'review',
      mode: 'grill-me',
    }]);

    const restarted = await fetch(`${origin}/api/chat/sessions/chat-session-1/restart`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: '{}',
    });
    expect(restarted.status).toBe(200);
    await expect(restarted.json()).resolves.toMatchObject({
      id: 'chat-session-1',
      workflow: 'review',
      mode: 'grill-me',
    });
    expect(restarts).toEqual(['chat-session-1']);

    const response = await fetch(`${origin}/api/chat/sessions/chat-session-1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ text: '相談したい' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    const records = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(records).toEqual([
      { type: 'thinking', content: '確認しています。' },
      { type: 'reply', reply: { kind: 'assistant_response', content: '回答です。' } },
    ]);
    expect(messages).toEqual([{ sessionId: 'chat-session-1', text: '相談したい' }]);

    const failedResponse = await fetch(`${origin}/api/chat/sessions/chat-session-1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TAKT-Web-Token': token,
      },
      body: JSON.stringify({ text: '失敗する' }),
    });
    const failedRecords = (await failedResponse.text()).trim().split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(failedRecords).toEqual([
      { type: 'thinking', content: '確認しています。' },
      { type: 'error', message: 'provider failed' },
    ]);
  });
});
