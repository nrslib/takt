import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
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
import { buildRunPaths, buildRunPathsFromRunsDirectory } from '../core/workflow/run/run-paths.js';
import { resolveTaskSpecForExecution, stageTaskSpecForExecution, restageTaskSpecForExecution } from '../features/tasks/execute/taskSpecContext.js';
import { registerManagerImageRun } from '../features/tasks/managerImageAttachments.js';

type SandboxResult = Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'error' | 'stdout' | 'stderr'>;
const sandboxProbeOutput = 'takt-sandbox-probe-ok';
const unavailableSandbox: SandboxResult = {
  status: 71, signal: null, stdout: '', stderr: 'sandbox-exec: sandbox_apply: Operation not permitted\n',
};
const outputlessSandbox: SandboxResult = {
  status: 0, signal: null, stdout: '',
  stderr: 'WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "/tmp" (codex_home: AbsolutePathBuf("/tmp/takt-goal-pause-retry-fixture/sandbox-home"))\n',
};

function sandboxUnavailableReason(result: SandboxResult): string | undefined {
  // Observed when Codex's Seatbelt sandbox is started inside another Seatbelt sandbox.
  if (process.platform === 'darwin' && result.error === undefined && result.signal === null && result.status === 71 && result.stdout === ''
    && result.stderr.trim() === unavailableSandbox.stderr.trim()) {
    return result.stderr.trim();
  }
  return undefined;
}

function expectSandboxImageRead(
  probe: SandboxResult | undefined, image: SandboxResult | undefined, expected: string, context: string,
): string | undefined {
  const reason = probe === undefined ? undefined : sandboxUnavailableReason(probe);
  if (reason !== undefined) {
    expect(image, `${context}: image sandbox must not run after a denied probe`).toBeUndefined();
    return `${reason}; status=${probe!.status}, signal=${probe!.signal}, stderr=${JSON.stringify(probe!.stderr)}`;
  }
  expectSandboxOutput(probe, sandboxProbeOutput, `${context}: sandbox probe`);
  expectSandboxOutput(image, expected, `${context}: sandbox image read`);
  return undefined;
}

function expectSandboxOutput(result: SandboxResult | undefined, expected: string, context: string): void {
  if (result === undefined) throw new Error(`Sandbox did not run: ${context}`);
  const diagnostic = `${context}: ${JSON.stringify({
    status: result.status, signal: result.signal, error: result.error?.message,
    stdout: result.stdout, stderr: result.stderr,
  })}`;
  expect(result.error, diagnostic).toBeUndefined();
  expect(result.signal, diagnostic).toBeNull();
  expect(result.status, diagnostic).toBe(0);
  expect(result.stdout.trim(), diagnostic).toBe(expected);
}

describe('sandbox subprocess diagnostics', () => {
  const expected = createHash('sha256').update('selected screenshot').digest('hex');
  const result = (overrides: Partial<SandboxResult>): SandboxResult => ({
    status: 0, signal: null, stdout: `${expected}\n`, stderr: '', ...overrides,
  });

  it('accepts a successful process only when its output matches the expected digest', () => {
    expect(() => expectSandboxOutput(result({}), expected, 'image read')).not.toThrow();
  });

  it.each(['', ' \n', 'different digest'])(
    'reports exit status and stderr when a successful process returns invalid output %j', (stdout) => {
      const failed = result({ stdout, stderr: 'output diagnostic' });
      expect(() => expectSandboxOutput(failed, expected, 'image read'))
        .toThrow(/image read.*"status":0.*"stderr":"output diagnostic"/u);
    });

  it('rejects a nonzero exit even when stdout contains the expected digest', () => {
    expect(() => expectSandboxOutput(result({ status: 3, stderr: 'image read denied' }), expected, 'clone image'))
      .toThrow(/clone image.*"status":3.*"stderr":"image read denied"/u);
  });

  it('reports a process signal instead of accepting its partial output', () => {
    expect(() => expectSandboxOutput(result({ status: null, signal: 'SIGTERM', stderr: 'interrupted' }), expected, 'image read'))
      .toThrow(/"status":null.*"signal":"SIGTERM".*"stderr":"interrupted"/u);
  });

  it('reports a launch error instead of accepting an unstarted process', () => {
    expect(() => expectSandboxOutput(result({ status: null, error: new Error('spawn ENOENT'), stdout: '', stderr: '' }), expected, 'image read'))
      .toThrow(/"status":null.*"error":"spawn ENOENT".*"stderr":""/u);
  });

  it('recognizes the observed sandbox initialization denial and preserves its reason', () => {
    if (process.platform === 'darwin') {
      expect(sandboxUnavailableReason(unavailableSandbox)).toBe(unavailableSandbox.stderr.trim());
      expect(expectSandboxImageRead(unavailableSandbox, undefined, expected, 'image read'))
        .toContain(unavailableSandbox.stderr.trim());
    } else {
      expect(sandboxUnavailableReason(unavailableSandbox)).toBeUndefined();
      expect(() => expectSandboxImageRead(unavailableSandbox, undefined, expected, 'image read')).toThrow();
    }
  });

  it.each(['', ' \n', 'unexpected probe output'].flatMap((stdout) =>
    ['', outputlessSandbox.stderr].map((stderr) => ({ stdout, stderr }))))(
    'rejects a zero-exit probe with invalid output: %j', ({ stdout, stderr }) => {
      const probe = result({ stdout, stderr });
      expect(sandboxUnavailableReason(probe)).toBeUndefined();
      expect(() => expectSandboxImageRead(probe, undefined, expected, 'image read')).toThrow();
    });

  it.each([
    { status: 0, signal: 'SIGTERM' as const, stdout: '', stderr: outputlessSandbox.stderr },
    { status: 0, error: new Error('spawn failed'), stdout: '', stderr: outputlessSandbox.stderr },
    { status: 1, stdout: '', stderr: 'EPERM: image read denied' },
    { status: 71, stdout: '', stderr: 'unknown sandbox failure' },
    { status: 71, stdout: sandboxProbeOutput, stderr: unavailableSandbox.stderr },
    { status: null, signal: 'SIGTERM' as const, stdout: '', stderr: unavailableSandbox.stderr },
    { status: 71, error: new Error('spawn failed'), stdout: '', stderr: unavailableSandbox.stderr },
  ])('does not classify an unknown or partial probe failure as an unavailable sandbox: %j', (overrides) => {
    const probe = result(overrides);
    expect(sandboxUnavailableReason(probe)).toBeUndefined();
    expect(() => expectSandboxImageRead(probe, undefined, expected, 'image read')).toThrow();
  });

  it.each([sandboxProbeOutput, `${sandboxProbeOutput}\n`])(
    'requires the image digest after a successful independent sandbox probe with output %j', (stdout) => {
      const probe = result({ stdout, stderr: outputlessSandbox.stderr });
      expect(sandboxUnavailableReason(probe)).toBeUndefined();
      expect(expectSandboxImageRead(probe, result({}), expected, 'image read')).toBeUndefined();
    });

  it('does not treat an empty image result after a successful probe as sandbox unavailability', () => {
    const probe = result({ stdout: sandboxProbeOutput });
    expect(() => expectSandboxImageRead(probe, outputlessSandbox, expected, 'image read'))
      .toThrow(/sandbox image read.*"status":0.*"stdout":""/u);
  });

  it('does not treat an image read failure after a successful probe as sandbox unavailability', () => {
    const probe = result({ stdout: sandboxProbeOutput });
    expect(() => expectSandboxImageRead(probe, unavailableSandbox, expected, 'image read'))
      .toThrow(/sandbox image read.*"status":71.*sandbox_apply/u);
  });
});

describe('clone 準備中に停止したゴールのタスクを manager MCP から再試行する', () => {
  let root: string;
  let cwd: string;
  let client: Client;
  let server: ReturnType<typeof createTaktMcpServer>;
  let sandboxHomes: Set<string>;
  const taskDir = '.takt/tasks/paused-task';

  beforeEach(async () => {
    sandboxHomes = new Set();
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

  async function cleanup() {
    try {
      await client?.close();
      await server?.close();
    } finally {
      try {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        resetScenario();
        invalidateGlobalConfigCache();
        invalidateAllResolvedConfigCache();
        rmSync(root, { recursive: true, force: true });
      } finally {
        for (const home of sandboxHomes) rmSync(home, { recursive: true, force: true });
        for (const home of sandboxHomes) expect(existsSync(home), `sandbox home must be removed: ${home}`).toBe(false);
      }
    }
  }

  afterEach(cleanup);

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

  it('keeps the turn image source when a workspace is created before task registration', async () => {
    const f = await prepareManagerImage();
    const second = join(root, 'second-project');
    mkdirSync(second);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: second, stdio: 'pipe' });
    const added = await client.callTool({ name: 'takt_add_workspace_repository', arguments: { repositoryDirectory: second } });
    expect(added.isError, firstTextContent(added.content)).not.toBe(true);
    const saved = await enqueueImageTask(`Inspect image: \`${f.image.path}\``, 'Inspect the supplied image');
    const workflow = (await new ConversationImageStore(cwd, f.id).read()).workflows?.[0];
    expect(workflow?.imageIds).toEqual([f.image.id]);
    expect(readFileSync(join(cwd, saved.taskDir!, 'attachments', 'image-1.png'))).toEqual(png);
  });

  it('registers and stages manager images in a custom runs directory', async () => {
    const f = await prepareManagerImage();
    const saved = await enqueueImageTask(`Inspect image: \`${f.image.path}\``, 'Inspect in central run');
    const paths = buildRunPathsFromRunsDirectory(join(root, 'central-runs'), 'custom-image-run');
    const sourceTaskDir = join(cwd, saved.taskDir!);
    await registerManagerImageRun(sourceTaskDir, paths);
    stageTaskSpecForExecution(resolveTaskSpecForExecution(cwd, cwd, saved.taskDir!, paths.slug, paths), paths);
    expect((await new ConversationImageStore(cwd, f.id).read()).workflows?.[0]?.copies)
      .toEqual([{ root: paths.runRootAbs, taskDirectory: paths.contextTaskAbs }]);
    expect(readFileSync(join(paths.contextTaskAbs, 'attachments', 'image-1.png'))).toEqual(png);
  });

  it('rejects retry instructions that reference a new manager image before changing the saved task', async () => {
    const f = await prepareManagerImage();
    const saved = await enqueueImageTask(`Inspect image: \`${f.image.path}\``, 'Inspect the supplied image');
    await executeEnqueuedTask();
    const temporary = createSessionImageAttachmentStore(cwd);
    const source = await temporary.saveImage(Buffer.concat([png, Buffer.from('new')]), 'image/png');
    const newImage = await f.images.prepare(cwd, f.id, f.owner, source.tempPath);
    temporary.cleanup();
    const taskDirectory = join(cwd, saved.taskDir!);
    const orderPath = join(taskDirectory, 'order.md');
    const imageMetadataPath = join(taskDirectory, '.manager-images.json');
    const beforeOrder = readFileSync(orderPath);
    const beforeMetadata = readFileSync(imageMetadataPath);

    const retry = await client.callTool({ name: 'takt_retry_goal_task', arguments: {
      cwd, goalId, taskName: saved.name, startStep: 'work', task: `Inspect image: \`${newImage.path}\``,
    } });

    expect(retry.isError).toBe(true);
    expect(firstTextContent(retry.content)).toContain('not saved with this task');
    expect(readFileSync(orderPath)).toEqual(beforeOrder);
    expect(readFileSync(imageMetadataPath)).toEqual(beforeMetadata);
    expect(new TaskRunner(cwd).listTaskStateItems().find((task) => task.name === saved.name)?.status).toBe('failed');
  });

  function observeWorkflowReads(sandbox: boolean, probeOverride?: SandboxResult) {
    let home: string | undefined;
    const reads: { cwd: string; order: string; imagePath?: string; bytes?: Buffer; sandboxProbe?: SandboxResult; sandboxResult?: SandboxResult; options: ProviderCallOptions }[] = [];
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
        let sandboxProbe: SandboxResult | undefined;
        let sandboxResult: SandboxResult | undefined;
        if (sandbox && imagePath !== undefined) {
          if (home === undefined) {
            // Codex release builds refuse helper aliases when CODEX_HOME is under the OS temporary directory.
            home = mkdtempSync(join(homedir(), '.takt-goal-pause-retry-sandbox-'));
            sandboxHomes.add(home);
          }
          const sandboxHome = realpathSync(home);
          const script = `const fs = require('node:fs'); const crypto = require('node:crypto');
            const data = fs.readFileSync(process.argv[1]);
            try { fs.writeFileSync('sandbox-write-must-fail', 'x'); process.exit(2); }
            catch (error) { if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error; }
            fs.writeSync(1, crypto.createHash('sha256').update(data).digest('hex'));`;
          const runtime = resolveCodexSdkCli(undefined);
          const args = ['sandbox', '-c', 'sandbox_mode="read-only"', '--', process.execPath, '-e'];
          const processOptions = {
            cwd: options.cwd,
            // TMPDIR: Codex checks CODEX_HOME against its own temporary directory, so pass the one asserted below.
            env: {
              PATH: [...runtime.pathDirs, process.env.PATH ?? ''].join(delimiter),
              HOME: sandboxHome, CODEX_HOME: sandboxHome, TMPDIR: tmpdir(),
            },
            encoding: 'utf8' as const, stdio: 'pipe' as const, timeout: 15000,
          };
          expect(processOptions.env.CODEX_HOME).toBe(sandboxHome);
          expect(relative(realpathSync(tmpdir()), realpathSync(processOptions.env.CODEX_HOME)),
            `sandbox CODEX_HOME must be outside tmpdir: ${processOptions.env.CODEX_HOME}`).toMatch(/^\.\.(?:[/\\]|$)/u);
          sandboxProbe = probeOverride ?? spawnSync(runtime.executablePath,
            [...args, `require('node:fs').writeSync(1, ${JSON.stringify(sandboxProbeOutput)})`], processOptions);
          if (sandboxProbe.error === undefined && sandboxProbe.signal === null && sandboxProbe.status === 0
            && sandboxProbe.stdout.trim() === sandboxProbeOutput) {
            sandboxResult = spawnSync(runtime.executablePath, [...args, script, imagePath], processOptions);
          }
        }
        reads.push({ cwd: options.cwd, order, imagePath, bytes, sandboxProbe, sandboxResult, options });
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

  it.each([
    { mode: 'real sandbox', probeOverride: undefined },
    ...(process.platform === 'darwin' ? [{ mode: 'unavailable sandbox', probeOverride: unavailableSandbox }] : []),
  ])(
    'reads only the selected manager image from a private clone copy in a read-only sandbox through retry and requeue ($mode)', async ({ probeOverride }) => {
    const f = await prepareManagerImage();
    execFileSync('git', ['check-ignore', '--', relative(cwd, f.image.path)], { cwd, stdio: 'pipe' });
    const anotherSource = await createSessionImageAttachmentStore(cwd).saveImage(Buffer.concat([png, Buffer.from('other')]), 'image/png');
    const another = await f.images.prepare(cwd, f.id, f.owner, anotherSource.tempPath);
    const task = `# Inspect screen\n\nInspect image: \`${f.image.path}\``;
    const saved = await enqueueImageTask(task, 'Inspect selected screen');
    const reads = observeWorkflowReads(true, probeOverride);
    const warn = vi.spyOn(console, 'warn');
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
      const reason = expectSandboxImageRead(read?.sandboxProbe, read?.sandboxResult,
        createHash('sha256').update(png).digest('hex'),
        `${process.platform} ${action}: cwd=${read?.cwd}, image=${read?.imagePath}`);
      if (reason !== undefined) {
        console.warn(`[takt] sandbox unavailable; clone image read verified (${action}): ${reason}`);
      }
      if (probeOverride !== undefined) {
        expect(read?.sandboxResult).toBeUndefined();
        expect(reason).toEqual(expect.any(String));
        expect(reason).toContain(`status=${probeOverride.status}`);
        expect(reason).toContain(`stderr=${JSON.stringify(probeOverride.stderr)}`);
        expect(warn).toHaveBeenLastCalledWith(expect.stringContaining(reason!));
      }
      expect(read?.options.imageAttachments).toBeUndefined();
      expect(read?.cwd).toBe(finished.worktree_path);
      if (clone !== undefined) expect(finished.worktree_path).toBe(clone);
      clone = finished.worktree_path;
      const imagePath = read!.imagePath!;
      expect(relative(read!.cwd, imagePath)).toMatch(/^\.takt[/\\]runs[/\\]/u);
      expect(imagePath).not.toBe(f.image.path);
      if (process.platform !== 'win32') {
        expect(statSync(imagePath).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(imagePath)).mode & 0o777).toBe(0o700);
      }
      expect(readdirSync(dirname(imagePath))).toEqual(['image-1.png']);
      expect(execFileSync('git', ['ls-files', '--', relative(read!.cwd, imagePath)], { cwd: read!.cwd, encoding: 'utf8' })).toBe('');
      execFileSync('git', ['check-ignore', '--', relative(read!.cwd, imagePath)], { cwd: read!.cwd, stdio: 'pipe' });
      expect(read!.order).not.toContain(another.path);
    }
    const canonical = join(cwd, saved.taskDir!, 'attachments', 'image-1.png');
    expect(readFileSync(canonical)).toEqual(png);
    if (process.platform !== 'win32') {
      expect(statSync(canonical).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(canonical)).mode & 0o777).toBe(0o700);
    }
    execFileSync('git', ['check-ignore', '--', relative(cwd, canonical)], { cwd, stdio: 'pipe' });
    const removed = await client.callTool({ name: 'takt_remove_goal_task', arguments: {
      cwd, goalId, taskName: saved.name, reason: 'No further retry is needed',
    } });
    expect(removed.isError, firstTextContent(removed.content)).not.toBe(true);
    await f.images.release(cwd, f.id, f.owner);
    expect(existsSync(f.image.path)).toBe(false);
    expect(existsSync(canonical)).toBe(false);
    for (const read of reads) expect(existsSync(read.imagePath!)).toBe(false);
    expect(sandboxHomes.size).toBe(1);
    for (const home of sandboxHomes) {
      expect(relative(realpathSync(tmpdir()), realpathSync(home)), `sandbox home must be outside tmpdir: ${home}`)
        .toMatch(/^\.\.(?:[/\\]|$)/u);
    }
  });

  it('removes sandbox homes even when client cleanup fails', async () => {
    const f = await prepareManagerImage();
    await enqueueImageTask(`Inspect image: \`${f.image.path}\``, 'Inspect image before cleanup failure');
    observeWorkflowReads(true, process.platform === 'darwin' ? unavailableSandbox : undefined);
    await executeEnqueuedTask();
    const homes = [...sandboxHomes];
    expect(homes).toHaveLength(1);
    expect(existsSync(homes[0]!)).toBe(true);
    const failure = new Error('Injected client cleanup failure');
    vi.spyOn(client, 'close').mockRejectedValueOnce(failure);

    await expect(cleanup()).rejects.toBe(failure);

    for (const home of homes) expect(existsSync(home)).toBe(false);
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
    expect(basename(first.image.path)).toBe('image-1.png');
    expect(basename(secondImage.path)).toBe('image-1.png');
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
        : kind === 'placeholder only' ? 'Discuss [Image #1] and image-1.png.bak' : 'Check README spelling';
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
    let imageLockReleasedAtWorkLog = false;
    if (phase === 'after publication') vi.spyOn(GoalStore.prototype, 'update').mockImplementationOnce(async () => {
      imageLockReleasedAtWorkLog = !existsSync(join(cwd, '.takt', 'manager-images', f.id, '.lock'));
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
    expect(firstTextContent(result.content)).toContain(phase === 'after publication'
      ? 'Injected work log failure' : 'Injected enqueue publication failure');
    if (phase === 'after publication') expect(imageLockReleasedAtWorkLog).toBe(true);
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
    if (process.platform !== 'win32') {
      expect(statSync(stagedImage).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(stagedImage)).mode & 0o777).toBe(0o700);
    }
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
