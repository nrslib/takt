import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { executeTaskAndCompleteWithDetails, executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { setGoalExecutionStatus } from '../infra/goals/execution.js';
import { GoalStore } from '../infra/goals/store.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { CloneManager } from '../infra/task/clone.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { ManagerImageAttachments, managerImageDirectory } from '../features/manager/imageAttachments.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { createSessionImageAttachmentStore } from '../features/interactive/imageAttachments.js';
import { conversationId } from '../infra/conversations/identity.js';
import { FileEventStore } from '../infra/daemon/eventStore.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { MockProvider } from '../infra/providers/mock.js';
import type { ProviderCallOptions } from '../infra/providers/types.js';
import { resolveCodexSdkCli } from '../infra/codex/cli-runtime.js';
import { turnStart } from './helpers/daemon-turn.js';
import { enqueueTaktGoalTask } from '../features/mcp/goalOperations.js';
import { saveEnqueuedTaskFile } from '../infra/task/enqueuedTaskFile.js';
import { ConversationImageStore } from '../infra/conversations/imageAttachments.js';
import * as privateFiles from '../infra/daemon/privateFile.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { resolveTaskSpecForExecution, stageTaskSpecForExecution, restageTaskSpecForExecution } from '../features/tasks/execute/taskSpecContext.js';

describe('clone 準備中に停止したゴールのタスクを manager MCP から再試行する', () => {
  let root: string;
  let cwd: string;
  let client: Client;
  let server: ReturnType<typeof createTaktMcpServer>;
  const taskDir = '.takt/tasks/paused-task';

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-pause-retry-')));
    cwd = join(root, 'project');
    const globalDirectory = join(root, 'global');
    mkdirSync(join(cwd, taskDir), { recursive: true });
    mkdirSync(join(globalDirectory, 'workflows', 'personas'), { recursive: true });
    vi.stubEnv('TAKT_CONFIG_DIR', globalDirectory);
    writeFileSync(join(globalDirectory, 'config.yaml'), 'provider: mock\nlanguage: en\n');
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
    writeFileSync(join(cwd, taskDir, 'order.md'), 'Original instructions.');
    writeFileSync(join(globalDirectory, 'workflows', 'personas', 'worker.md'), 'Execute the task.');
    writeFileSync(join(globalDirectory, 'workflows', 'pause-retry.yaml'), stringify({
      name: 'pause-retry', initial_step: 'work', max_steps: 1,
      steps: [{ name: 'work', persona: './personas/worker.md', instruction: '{task}',
        rules: [{ condition: 'when(true)', next: 'ABORT' }] }],
    }));
    const git = (args: string[], input?: string) => execFileSync('git', args,
      { cwd, encoding: 'utf8', stdio: 'pipe', input }).trim();
    git(['init', '--quiet', '--initial-branch=main']);
    const tree = git(['mktree'], '');
    const sha = git(['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.test', 'commit-tree', tree, '-m', 'fixture']);
    git(['update-ref', 'refs/heads/main', sha]);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    await new GoalStore(cwd).create(goalRecord());
    server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    client = new Client({ name: 'pause-retry-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetScenario();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('selected screenshot')]);

  async function prepareManagerImage() {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n  workflows: [pause-retry]\n');
    invalidateAllResolvedConfigCache();
    execFileSync('git', ['update-ref', `refs/heads/${goalRecord().branch}`, 'HEAD'], { cwd, stdio: 'pipe' });
    const id = conversationId({ kind: 'repository', repositoryDirectory: cwd });
    const events = new FileEventStore(getGlobalConfigDir());
    const images = new ManagerImageAttachments(events);
    const owner = randomUUID();
    const temporary = createSessionImageAttachmentStore(cwd);
    const source = await temporary.saveImage(png, 'image/png');
    const image = await images.prepare(cwd, id, owner, source.tempPath);
    const start = turnStart();
    const event = { ...start.event, conversationId: id, event: { kind: 'human_command' as const,
      command: { kind: 'message' as const, text: 'Inspect ' + image.placeholder, imageAttachmentIds: [image.id] },
      speaker: { namespace: 'local', id: 'operator' } } };
    const turn = { ...start.turn, conversationId: id };
    await images.accept(cwd, id, owner, event.event.command.text, [image.id], () => events.accept(event));
    await events.markStarted(event.eventId, turn);
    const result = { ...turn, event, outcome: { kind: 'completed' as const,
      result: { kind: 'reply' as const, message: 'Image received' } } };
    await events.saveResult(event.eventId, result);
    await events.markSettled(event.eventId, result);
    temporary.cleanup();
    return { image, images, id, owner };
  }

  async function enqueueImageTask(task: string, purpose: string) {
    const result = await client.callTool({ name: 'takt_enqueue_goal_task', arguments: {
      cwd, goalId, purpose, task, workflow: 'pause-retry',
    } });
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
    const { taskName } = JSON.parse(firstTextContent(result.content)) as { taskName: string };
    const saved = new TaskRunner(cwd).listAllTaskItems().find((item) => item.name === taskName);
    if (saved?.taskDir === undefined) throw new Error('Enqueued task has no canonical task directory');
    return saved;
  }

  function observeWorkflowReads(sandbox: boolean) {
    const reads: { cwd: string; order: string; imagePath?: string; bytes?: Buffer; sandboxDigest?: string; options: ProviderCallOptions }[] = [];
    const setup = MockProvider.prototype.setup;
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      const agent = setup.call(this, config);
      if (config.name !== 'worker') return agent;
      return { call: async (prompt, options) => {
        const orderRef = /Primary spec: `([^`]+)`/u.exec(prompt)?.[1];
        if (orderRef === undefined) throw new Error('Workflow did not receive its task spec');
        const order = readFileSync(resolve(options.cwd, orderRef), 'utf8');
        const imageRef = /Inspect image: `([^`]+)`/u.exec(order)?.[1];
        const imagePath = imageRef === undefined ? undefined : resolve(options.cwd, imageRef);
        const bytes = imagePath === undefined ? undefined : readFileSync(imagePath);
        let sandboxDigest: string | undefined;
        if (sandbox && imagePath !== undefined) {
          const home = join(root, 'sandbox-home');
          mkdirSync(home, { recursive: true });
          const script = `const fs = require('node:fs'); const crypto = require('node:crypto');
            const data = fs.readFileSync(process.argv[1]);
            try { fs.writeFileSync('sandbox-write-must-fail', 'x'); process.exit(2); }
            catch (error) { if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error; }
            process.stdout.write(crypto.createHash('sha256').update(data).digest('hex'));`;
          sandboxDigest = execFileSync(resolveCodexSdkCli(undefined).executablePath,
            ['sandbox', '-c', 'sandbox_mode="read-only"', '--', process.execPath, '-e', script, imagePath], {
              cwd: options.cwd, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
              encoding: 'utf8', stdio: 'pipe', timeout: 15000,
            }).trim();
        }
        reads.push({ cwd: options.cwd, order, imagePath, bytes, sandboxDigest, options });
        return agent.call(prompt, options);
      } };
    });
    return reads;
  }

  async function executeEnqueuedTask() {
    setMockScenario([{ persona: 'worker', status: 'done', content: 'Image inspected.' }]);
    const runner = new TaskRunner(cwd);
    const task = runner.claimNextTasks(1)[0];
    if (task === undefined) throw new Error('No pending task');
    const result = await executeTaskAndCompleteWithDetails(task, runner, cwd, executeTaskWithResult,
      { provider: 'mock' }, { outputMode: 'silent' });
    expect(result).toMatchObject({ success: false, completion: { workflowResult: 'aborted', interrupted: false } });
    return new TaskStore(cwd).read().tasks.find((saved) => saved.name === task.name)!;
  }

  it('reads only the selected manager image from a private clone copy in a read-only sandbox through retry and requeue', async () => {
    const f = await prepareManagerImage();
    execFileSync('git', ['check-ignore', '--', relative(cwd, f.image.path)], { cwd, stdio: 'pipe' });
    const anotherSource = await createSessionImageAttachmentStore(cwd).saveImage(Buffer.concat([png, Buffer.from('other')]), 'image/png');
    const another = await f.images.prepare(cwd, f.id, f.owner, anotherSource.tempPath);
    const task = `# Inspect screen\n\nInspect image: \`${f.image.path}\``;
    const saved = await enqueueImageTask(task, 'Inspect selected screen');
    const reads = observeWorkflowReads(true);
    let clone: string | undefined;

    for (const action of ['initial', 'retry', 'requeue'] as const) {
      if (action !== 'initial') {
        const result = await client.callTool({ name: `takt_${action}_goal_task`, arguments: {
          cwd, goalId, taskName: saved.name, startStep: 'work', ...(action === 'retry' ? { task } : {}),
        } });
        expect(result.isError, firstTextContent(result.content)).not.toBe(true);
      }
      await f.images.release(cwd, f.id, f.owner);
      expect(readFileSync(f.image.path)).toEqual(png);
      const finished = await executeEnqueuedTask();
      const read = reads.at(-1);
      expect(reads).toHaveLength(action === 'initial' ? 1 : action === 'retry' ? 2 : 3);
      expect(read?.bytes).toEqual(png);
      expect(read?.sandboxDigest).toBe(createHash('sha256').update(png).digest('hex'));
      expect(read?.options.imageAttachments).toBeUndefined();
      expect(read?.cwd).toBe(finished.worktree_path);
      if (clone !== undefined) expect(finished.worktree_path).toBe(clone);
      clone = finished.worktree_path;
      const imagePath = read!.imagePath!;
      expect(relative(read!.cwd, imagePath)).toMatch(/^\.takt[/\\]runs[/\\]/u);
      expect(imagePath).not.toBe(f.image.path);
      expect(statSync(imagePath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(imagePath)).mode & 0o777).toBe(0o700);
      expect(readdirSync(dirname(imagePath))).toEqual(['image-1.png']);
      expect(execFileSync('git', ['ls-files', '--', relative(read!.cwd, imagePath)], { cwd: read!.cwd, encoding: 'utf8' })).toBe('');
      execFileSync('git', ['check-ignore', '--', relative(read!.cwd, imagePath)], { cwd: read!.cwd, stdio: 'pipe' });
      expect(read!.order).not.toContain(another.path);
    }
    const canonical = join(cwd, saved.taskDir!, 'attachments', 'image-1.png');
    expect(readFileSync(canonical)).toEqual(png);
    expect(statSync(canonical).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(canonical)).mode & 0o777).toBe(0o700);
    execFileSync('git', ['check-ignore', '--', relative(cwd, canonical)], { cwd, stdio: 'pipe' });
    const removed = await client.callTool({ name: 'takt_remove_goal_task', arguments: {
      cwd, goalId, taskName: saved.name, reason: 'No further retry is needed',
    } });
    expect(removed.isError, firstTextContent(removed.content)).not.toBe(true);
    await f.images.release(cwd, f.id, f.owner);
    expect(existsSync(f.image.path)).toBe(false);
    expect(existsSync(canonical)).toBe(false);
    for (const read of reads) expect(existsSync(read.imagePath!)).toBe(false);
  });

  it('distinguishes same-named images from repository and workspace stores while reusing identical selections', async () => {
    const first = await prepareManagerImage();
    const purpose = 'Inspect selected screen';
    const firstTask = `Inspect image: \`${first.image.path}\``;
    const savedFirst = await enqueueImageTask(firstTask, purpose);
    const firstMetadata = await new ConversationImageStore(cwd, first.id).read();
    expect((await enqueueImageTask(firstTask, purpose)).name).toBe(savedFirst.name);
    expect(new TaskStore(cwd).read().tasks).toHaveLength(1);
    expect((await new GoalStore(cwd).get(goalId)).workLog).toHaveLength(1);
    expect(await new ConversationImageStore(cwd, first.id).read()).toEqual(firstMetadata);

    const workspace = await createWorkspace({ globalConfigDirectory: getGlobalConfigDir(), name: 'Image inspection', repositoryDirectories: [cwd] });
    const assignment = { kind: 'workspace' as const, workspaceId: workspace.id };
    const workspaceRoot = await managerImageDirectory(assignment, getGlobalConfigDir());
    const workspaceId = conversationId(assignment);
    const temporary = createSessionImageAttachmentStore(workspaceRoot);
    const secondBytes = Buffer.concat([png, Buffer.from('workspace screenshot')]);
    let secondImage;
    try {
      const source = await temporary.saveImage(secondBytes, 'image/png');
      secondImage = await first.images.prepare(workspaceRoot, workspaceId, randomUUID(), source.tempPath);
    } finally { temporary.cleanup(); }
    expect(first.image.path.endsWith('/image-1.png')).toBe(true);
    expect(secondImage.path.endsWith('/image-1.png')).toBe(true);
    expect(secondImage.path).not.toBe(first.image.path);
    await client.close(); await server.close();
    server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd, managerAssignment: assignment });
    client = new Client({ name: 'workspace-image-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);

    const secondTask = `Inspect image: \`${secondImage.path}\``;
    const savedSecond = await enqueueImageTask(secondTask, purpose);
    expect(savedSecond.name).not.toBe(savedFirst.name);
    expect(readFileSync(join(cwd, savedFirst.taskDir!, 'order.md'), 'utf8'))
      .toBe(readFileSync(join(cwd, savedSecond.taskDir!, 'order.md'), 'utf8'));
    expect(readFileSync(join(cwd, savedFirst.taskDir!, 'attachments', 'image-1.png'))).toEqual(png);
    expect(readFileSync(join(cwd, savedSecond.taskDir!, 'attachments', 'image-1.png'))).toEqual(secondBytes);
    const workspaceMetadata = await new ConversationImageStore(workspaceRoot, workspaceId).read();
    const directories = readdirSync(join(cwd, '.takt', 'tasks'));
    expect((await enqueueImageTask(secondTask, purpose)).name).toBe(savedSecond.name);
    expect(new TaskStore(cwd).read().tasks).toHaveLength(2);
    expect((await new GoalStore(cwd).get(goalId)).workLog).toHaveLength(2);
    expect(readdirSync(join(cwd, '.takt', 'tasks'))).toEqual(directories);
    expect(await new ConversationImageStore(workspaceRoot, workspaceId).read()).toEqual(workspaceMetadata);
    expect(await new ConversationImageStore(cwd, first.id).read()).toEqual(firstMetadata);

    const reads = observeWorkflowReads(false);
    await executeEnqueuedTask();
    await executeEnqueuedTask();
    expect(reads.map((read) => read.bytes)).toEqual([png, secondBytes]);
    for (const read of reads) expect(relative(read.cwd, read.imagePath!)).toMatch(/^\.takt[/\\]runs[/\\]/u);
  });

  it('retains a completed task image and deletes only its run copies while a provider session still owns the original', async () => {
    const f = await prepareManagerImage();
    const state = new ConversationStateStore(getGlobalConfigDir());
    await state.create({ ...conversationRecord(cwd), sessionId: 'image-session', sessionImageAttachmentIds: [f.image.id] });
    const setSession = async (sessionId: string | null) => {
      const current = (await state.read(f.id))!.state;
      expect(await state.save({ conversationId: f.id, operationId: randomUUID(), generation: 1 }, {
        operationId: randomUUID(), expectedVersion: current.version,
        session: { ...current.session, sessionId, imageAttachmentIds: sessionId === null ? [] : [f.image.id] },
      }, new AbortController().signal)).toMatchObject({ kind: 'state_saved' });
    };
    await f.images.release(cwd, f.id, f.owner);
    expect(readFileSync(f.image.path)).toEqual(png);
    const workflow = join(getGlobalConfigDir(), 'workflows', 'pause-retry.yaml');
    writeFileSync(workflow, readFileSync(workflow, 'utf8').replace('next: ABORT', 'next: COMPLETE'));
    invalidateAllResolvedConfigCache();
    const saved = await enqueueImageTask(`Inspect image: \`${f.image.path}\``, 'Complete image inspection');
    const reads = observeWorkflowReads(false);
    setMockScenario([{ persona: 'worker', status: 'done', content: 'Image inspected.' }]);
    const runner = new TaskRunner(cwd);
    const claimed = runner.claimNextTasks(1)[0]!;
    const result = await executeTaskAndCompleteWithDetails(claimed, runner, cwd, executeTaskWithResult,
      { provider: 'mock' }, { outputMode: 'silent' });
    expect(result.success).toBe(true);
    expect(new TaskStore(cwd).read().tasks.find(({ name }) => name === saved.name)?.status).toBe('completed');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.bytes).toEqual(png);
    const copy = reads[0]!.imagePath!;
    const canonical = join(cwd, saved.taskDir!, 'attachments', 'image-1.png');

    await setSession(null);
    await f.images.release(cwd, f.id, f.owner);
    expect(readFileSync(f.image.path)).toEqual(png);
    expect(readFileSync(canonical)).toEqual(png);
    expect(readFileSync(copy)).toEqual(png);

    await setSession('resumed-image-session');
    const removed = await client.callTool({ name: 'takt_remove_goal_task', arguments: {
      cwd, goalId, taskName: saved.name, reason: 'Image inspection completed',
    } });
    expect(removed.isError, firstTextContent(removed.content)).not.toBe(true);
    await f.images.release(cwd, f.id, f.owner);
    expect(existsSync(canonical)).toBe(false);
    expect(existsSync(copy)).toBe(false);
    expect((await new ConversationImageStore(cwd, f.id).read()).workflows).toEqual([]);
    expect(readFileSync(f.image.path)).toEqual(png);

    await setSession(null);
    await f.images.release(cwd, f.id, f.owner);
    expect(existsSync(f.image.path)).toBe(false);
  });

  it.each([0, 6000, 0, 6000])('keeps saved task, work log and MCP success consistent after a %d ms successful summary', async (delay) => {
    const f = await prepareManagerImage();
    writeFileSync(join(cwd, '.takt', 'config.yaml'), readFileSync(join(cwd, '.takt', 'config.yaml'), 'utf8') + '\nbranch_name_strategy: ai\n');
    invalidateAllResolvedConfigCache();
    const setup = MockProvider.prototype.setup;
    const summary = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(delay);
      return { persona: 'summarizer', status: 'done' as const, content: 'inspect-screen', timestamp: new Date() };
    });
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      return config.name === 'summarizer' ? { call: summary } : setup.call(this, config);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = await enqueueTaktGoalTask({ cwd, goalId, purpose: 'Inspect selected screen',
      task: `Inspect image: \`${f.image.path}\``, workflow: 'pause-retry' }, {
      managerImageSource: { root: cwd, conversationId: f.id },
    }, new AbortController().signal);
    const records = new TaskStore(cwd).read().tasks;
    expect(summary).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
    expect((await new GoalStore(cwd).get(goalId)).workLog).toHaveLength(1);
    expect((await new ConversationImageStore(cwd, f.id).read()).workflows).toHaveLength(1);
    expect(readFileSync(join(cwd, records[0]!.task_dir!, 'attachments', 'image-1.png'))).toEqual(png);
    expect(result.isError, firstTextContent(result.content)).not.toBe(true);
  });

  it.each([0, 6000, 0, 6000])('keeps publication, work log and MCP success consistent after %d ms of image processing', async (delay) => {
    const f = await prepareManagerImage();
    writeFileSync(join(cwd, '.takt', 'config.yaml'), readFileSync(join(cwd, '.takt', 'config.yaml'), 'utf8') + '\nbranch_name_strategy: romaji\n');
    invalidateAllResolvedConfigCache();
    const read = privateFiles.readPrivateFile;
    const imageReads = vi.fn();
    vi.spyOn(privateFiles, 'readPrivateFile').mockImplementation(async (path, limit) => {
      if (path === f.image.path) { imageReads(); await vi.advanceTimersByTimeAsync(delay); }
      return read(path, limit);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = await enqueueTaktGoalTask({ cwd, goalId, purpose: 'Inspect selected screen',
      task: `Inspect image: \`${f.image.path}\``, workflow: 'pause-retry' }, {
      managerImageSource: { root: cwd, conversationId: f.id },
    }, new AbortController().signal);
    const records = new TaskStore(cwd).read().tasks;
    const metadata = await new ConversationImageStore(cwd, f.id).read();
    expect(imageReads).toHaveBeenCalledOnce();
    expect({ taskCount: records.length, workLogCount: (await new GoalStore(cwd).get(goalId)).workLog.length,
      referenceCount: metadata.workflows?.length, isError: result.isError === true,
      copyMatches: records.length === 1 && readFileSync(join(cwd, records[0]!.task_dir!, 'attachments', 'image-1.png')).equals(png),
    }, firstTextContent(result.content)).toEqual({ taskCount: 1, workLogCount: 1, referenceCount: 1, isError: false, copyMatches: true });
  });

  it.each(['purpose only', 'filename suffix', 'placeholder only'] as const)(
    'does not distribute manager images to a separate workflow when the reference is %s', async (kind) => {
      const { image } = await prepareManagerImage();
      const task = kind === 'filename suffix' ? `Inspect backup \`${image.path}.bak\``
        : kind === 'placeholder only' ? 'Discuss [Image #1] without selecting a saved path' : 'Check README spelling';
      const saved = await enqueueImageTask(task, `Image available at ${image.path}`);
      const reads = observeWorkflowReads(false);
      const finished = await executeEnqueuedTask();

      expect(reads).toHaveLength(1);
      expect(reads[0]!.order).toBe(task);
      expect(reads[0]!.options.imageAttachments).toBeUndefined();
      expect(existsSync(join(cwd, saved.taskDir!, 'attachments'))).toBe(false);
      expect(existsSync(join(finished.worktree_path!, '.takt', 'runs', finished.run_slug!, 'context', 'task', 'attachments'))).toBe(false);
    });

  it('rejects a deleted manager image path before publishing a workflow task', async () => {
    const f = await prepareManagerImage();
    rmSync(f.image.path);
    const before = new TaskStore(cwd).read().tasks;

    const result = await client.callTool({ name: 'takt_enqueue_goal_task', arguments: {
      cwd, goalId, purpose: 'Inspect deleted image', task: `Inspect image: \`${f.image.path}\``, workflow: 'pause-retry',
    } });

    expect(result.isError).toBe(true);
    expect(new TaskStore(cwd).read().tasks).toEqual(before);
  });

  it.each(['before publication', 'after publication'] as const)('reconciles manager image reservations when enqueue fails %s', async (phase) => {
    const f = await prepareManagerImage();
    if (phase === 'after publication') vi.spyOn(GoalStore.prototype, 'update').mockImplementationOnce(async () => {
      expect(existsSync(join(cwd, '.takt', 'manager-images', f.id, '.lock'))).toBe(false);
      throw new Error('Injected work log failure');
    });
    const result = await enqueueTaktGoalTask({ cwd, goalId, purpose: 'Inspect selected screen',
      task: `Inspect image: \`${f.image.path}\``, workflow: 'pause-retry' }, {
      managerImageSource: { root: cwd, conversationId: f.id },
      saveTaskFile: async (...args) => {
        if (phase === 'after publication') return saveEnqueuedTaskFile(...args);
        const scope = args[5];
        if (scope === undefined) throw new Error('Missing publication scope');
        return scope(() => { throw new Error('Injected enqueue publication failure'); });
      },
    }, new AbortController().signal);
    expect(result.isError).toBe(true);
    const records = new TaskStore(cwd).read().tasks;
    const metadata = await new ConversationImageStore(cwd, f.id).read();
    if (phase === 'before publication') {
      expect(records).toEqual([]);
      expect(metadata.workflows).toEqual([]);
      expect(readdirSync(join(cwd, '.takt', 'tasks'))).toEqual(['paused-task']);
    } else {
      expect(records).toHaveLength(1);
      expect(metadata.workflows).toHaveLength(1);
      await f.images.release(cwd, f.id, f.owner);
      expect(readFileSync(f.image.path)).toEqual(png);
      expect(readFileSync(join(cwd, records[0]!.task_dir!, 'attachments', 'image-1.png'))).toEqual(png);
    }
  });

  it('serializes manager image selection with cleanup so no published task has a deleted attachment', async () => {
    const f = await prepareManagerImage();
    const [result] = await Promise.all([
      client.callTool({ name: 'takt_enqueue_goal_task', arguments: { cwd, goalId, purpose: 'Concurrent image selection',
        task: `Inspect image: \`${f.image.path}\``, workflow: 'pause-retry' } }),
      f.images.release(cwd, f.id, f.owner),
    ]);
    const records = new TaskStore(cwd).read().tasks;
    if (result.isError) expect(records).toEqual([]);
    else {
      expect(records).toHaveLength(1);
      expect(readFileSync(f.image.path)).toEqual(png);
      expect(readFileSync(join(cwd, records[0]!.task_dir!, 'attachments', 'image-1.png'))).toEqual(png);
    }
  });

  it.each(['task directory', 'attachments directory'] as const)('rejects a symlinked manager image %s before writing outside the run context', async (kind) => {
    const f = await prepareManagerImage();
    const saved = await enqueueImageTask(`Inspect image: \`${f.image.path}\``, 'Safe image copy');
    const paths = buildRunPaths(cwd, 'unsafe-image-copy');
    const outside = join(root, 'outside'); mkdirSync(outside);
    const protectedFile = join(outside, 'image-1.png'); writeFileSync(protectedFile, 'untouched');
    const target = kind === 'task directory' ? paths.contextTaskAbs : join(paths.contextTaskAbs, 'attachments');
    mkdirSync(dirname(target), { recursive: true }); symlinkSync(outside, target, 'dir');
    const spec = resolveTaskSpecForExecution(cwd, cwd, saved.taskDir!, paths.slug);

    expect(() => stageTaskSpecForExecution(spec, paths)).toThrow();
    expect(readFileSync(protectedFile, 'utf8')).toBe('untouched');
    expect(readdirSync(outside)).toEqual(['image-1.png']);
  });

  it('restages manager instructions without replacing private image bytes and rejects changed canonical image bytes', async () => {
    const f = await prepareManagerImage();
    const saved = await enqueueImageTask(`Inspect image: \`${f.image.path}\``, 'Restage image task');
    const paths = buildRunPaths(cwd, 'restage-image-copy');
    stageTaskSpecForExecution(resolveTaskSpecForExecution(cwd, cwd, saved.taskDir!, paths.slug), paths);
    const order = join(cwd, saved.taskDir!, 'order.md');
    writeFileSync(order, readFileSync(order, 'utf8') + '\nAdditional instructions');
    restageTaskSpecForExecution(resolveTaskSpecForExecution(cwd, cwd, saved.taskDir!, paths.slug), paths);
    const stagedImage = join(paths.contextTaskAbs, 'attachments', 'image-1.png');
    expect(readFileSync(stagedImage)).toEqual(png);
    expect(statSync(stagedImage).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(stagedImage)).mode & 0o777).toBe(0o700);
    expect(readFileSync(paths.contextTaskOrderAbs, 'utf8')).toContain('Additional instructions');

    writeFileSync(join(cwd, saved.taskDir!, 'attachments', 'image-1.png'), Buffer.concat([png, Buffer.from('changed')]));
    const next = buildRunPaths(cwd, 'changed-image-copy');
    const changed = resolveTaskSpecForExecution(cwd, cwd, saved.taskDir!, next.slug);
    expect(() => stageTaskSpecForExecution(changed, next)).toThrow();
    expect(readFileSync(stagedImage)).toEqual(png);
  });

  it.each((['paused', 'aborted'] as const).flatMap((status) =>
    (['before clone', 'after clone'] as const).flatMap((phase) =>
      (['retry', 'requeue'] as const).map((action) => ({ status, phase, action })))))(
    '$phase で $status にしたタスクの $action を実際の保存状態から処理する', async ({ status, phase, action }) => {
      const runner = new TaskRunner(cwd);
      const store = new TaskStore(cwd);
      runner.addTask('Prepare a clone', { goal_id: goalId, task_dir: taskDir, worktree: true,
        workflow: 'pause-retry', slug: 'paused-task', base_branch: 'main' });
      const task = runner.claimNextTasks(1)[0]!;
      const createClone = CloneManager.prototype.createSharedCloneAbortable;
      const clone = vi.spyOn(CloneManager.prototype, 'createSharedCloneAbortable').mockImplementationOnce(async function (
        this: CloneManager, projectDir, options, signal,
      ) {
        const result = phase === 'after clone' ? await createClone.call(this, projectDir, options, signal) : undefined;
        await setGoalExecutionStatus(cwd, goalId, status, new AbortController().signal);
        await vi.waitFor(() => expect(signal!.aborted).toBe(true), { timeout: 3000 });
        if (result === undefined) signal!.throwIfAborted();
        return result!;
      });
      const executor = vi.fn(executeTaskWithResult);
      const stopped = await executeTaskAndCompleteWithDetails(task, runner, cwd, executor, { provider: 'mock' }, { outputMode: 'silent' });
      const saved = store.read().tasks[0]!;
      expect(stopped).toMatchObject({ success: false, runSlug: expect.stringMatching(/^setup-/),
        completion: { interrupted: true, workflowResult: 'error' } });
      expect(executor).not.toHaveBeenCalled();
      expect(saved).toMatchObject({ status: 'failed', owner_pid: null });
      expect(saved.failure!.retryable === false).toBe(status === 'aborted');
      expect(saved.run_slug).toEqual(status === 'paused' ? undefined : stopped.runSlug);
      if (phase === 'after clone') expect(existsSync(join(saved.worktree_path!, '.git', 'HEAD'))).toBe(true);
      else expect(saved.worktree_path).toBeUndefined();
      if (status === 'paused') await setGoalExecutionStatus(cwd, goalId, 'active', new AbortController().signal);
      const result = await client.callTool({ name: `takt_${action}_goal_task`, arguments: {
        cwd, goalId, taskName: task.name, ...(action === 'retry' ? { task: 'Revised instructions.' } : {}),
      } });
      if (status === 'aborted') {
        expect(result.isError).toBe(true);
        expect(store.read().tasks[0]).toEqual(saved);
        return;
      }
      expect(result.isError, firstTextContent(result.content)).not.toBe(true);
      expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ status: 'pending' });
      const pending = store.read().tasks[0]!;
      expect(pending.worktree_path).toBe(saved.worktree_path);
      expect(pending.source_run_slug).toBeUndefined();
      expect(readFileSync(join(cwd, taskDir, 'order.md'), 'utf8')).toBe(
        action === 'retry' ? 'Revised instructions.' : 'Original instructions.');
      setMockScenario([{ persona: 'worker', status: 'done', content: 'Retried in a real clone.' }]);
      const retried = runner.claimNextTasks(1)[0]!;
      const completed = await executeTaskAndCompleteWithDetails(retried, runner, cwd, executor, { provider: 'mock' }, { outputMode: 'silent' });
      expect(executor).toHaveBeenCalledOnce();
      expect(completed).toMatchObject({ success: false, completion: { workflowResult: 'aborted', interrupted: false } });
      expect(clone).toHaveBeenCalledTimes(phase === 'before clone' ? 2 : 1);
      const finished = store.read().tasks[0]!;
      if (phase === 'after clone') expect(finished.worktree_path).toBe(saved.worktree_path);
      expect(existsSync(join(finished.worktree_path!, '.takt', 'runs', finished.run_slug!, 'meta.json'))).toBe(true);
    });
});
