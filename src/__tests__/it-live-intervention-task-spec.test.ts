import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { createTaktMcpServer } from '../app/mcp/server.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import {
  resolveTaskSpecForExecution,
  stageTaskSpecForExecution,
} from '../features/tasks/execute/taskSpecContext.js';
import { persistDeliveredLiveInstructions } from '../features/tasks/execute/liveInterventionPersistence.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';
import { firstTextContent } from './helpers/mcp-content.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    copyFileSync: vi.fn(actual.copyFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const RUN_SLUG = 'run-a';
const TASK_DIR = '.takt/tasks/tell-task';
const ORIGINAL_ORDER = '# Task\r\n\r\n既存の指示を保持する。  \r\n\r\n';

function captureStderr(): string[] {
  const messages: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((message) => {
    messages.push(String(message));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => messages.push(args.map(String).join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => messages.push(args.map(String).join(' ')));
  return messages;
}

describe('MCP tell task specification persistence', () => {
  let projectCwd: string;
  let client: Client | undefined;
  let server: ReturnType<typeof createTaktMcpServer> | undefined;

  beforeEach(() => {
    projectCwd = fs.mkdtempSync(join(tmpdir(), 'takt-tell-task-spec-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
    fs.rmSync(projectCwd, { recursive: true, force: true });
  });

  async function createFixture(mergeTask: boolean) {
    const cloneCwd = join(projectCwd, '.takt', 'worktrees', 'active');
    const execCwd = mergeTask ? projectCwd : cloneCwd;
    const runPaths = buildRunPaths(execCwd, RUN_SLUG);
    const sourceOrderPath = join(projectCwd, TASK_DIR, 'order.md');
    const attachmentPath = join(projectCwd, TASK_DIR, 'attachments', 'a.png');
    fs.mkdirSync(cloneCwd, { recursive: true });
    fs.mkdirSync(join(projectCwd, '.takt', 'runs', RUN_SLUG), { recursive: true });
    fs.mkdirSync(join(projectCwd, TASK_DIR, 'attachments'), { recursive: true });
    fs.writeFileSync(sourceOrderPath, ORIGINAL_ORDER);
    fs.writeFileSync(attachmentPath, 'original-image');
    const taskRecord = {
      name: 'tell-task', status: 'running', task_dir: TASK_DIR,
      workflow: 'default', worktree: true, worktree_path: cloneCwd,
      auto_pr: false, branch: 'feature/tell', run_slug: RUN_SLUG,
      created_at: '2026-10-18T00:00:00.000Z',
      started_at: '2026-10-18T00:00:00.000Z', completed_at: null,
      ...(mergeTask ? {
        source: 'pr_review', pr_number: 1805, merge_task: true,
        base_branch: 'main', merge_method: 'squash',
        merge_head_repository_url: 'https://example.com/owner/takt.git',
        merge_head_repository_push_urls: ['https://example.com/owner/takt.git'],
        merge_initial_head_sha: 'a'.repeat(40), merge_threat_check_max_diff_bytes: 100_000,
        merge_caccia_required: false, merge_clone_prepared: true,
      } : {}),
    };
    fs.writeFileSync(join(projectCwd, '.takt', 'tasks.yaml'), stringifyYaml({ tasks: [taskRecord] }));
    fs.mkdirSync(runPaths.runRootAbs, { recursive: true });
    fs.writeFileSync(runPaths.metaAbs, JSON.stringify({
      task: 'tell-task', workflow: 'default', runSlug: RUN_SLUG,
      runRoot: runPaths.runRootRel, reportDirectory: runPaths.reportsRel,
      contextDirectory: runPaths.contextRel, logsDirectory: runPaths.logsRel,
      status: 'running', startTime: '2026-10-18T00:00:00.000Z', currentStep: 'implement',
    }));
    const activeSpec = resolveTaskSpecForExecution(projectCwd, execCwd, TASK_DIR, RUN_SLUG);
    const store = new LiveInterventionFileStore(projectCwd, RUN_SLUG, (instructions) => {
      persistDeliveredLiveInstructions(projectCwd, execCwd, activeSpec, runPaths, instructions);
    });
    const stage = () => stageTaskSpecForExecution(
      resolveTaskSpecForExecution(projectCwd, execCwd, TASK_DIR, RUN_SLUG),
      runPaths,
    );
    stage();
    server = createTaktMcpServer({}, { allowedProjectRoot: projectCwd });
    client = new Client({ name: 'tell-task-spec-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const connectedClient = client;
    return {
      cloneCwd, execCwd, runPaths, sourceOrderPath, attachmentPath, stage,
      store,
      deliver: async () => store.commitDelivery(await store.prepareDelivery({ mode: 'next_step', step: 'review', phase: 1 })),
      tell: (content: string) => connectedClient.callTool({
        name: 'takt_tell_run', arguments: { cwd: projectCwd, runSlug: RUN_SLUG, content },
      }),
    };
  }

  it('appends successive instructions with their issued IDs and timestamps to both existing order files', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-10-18T01:00:00.000Z');
    const fixture = await createFixture(false);
    await fixture.store.issue('既存の配送記録');
    await fixture.deliver();
    let sourceBeforeIssue = fs.readFileSync(fixture.sourceOrderPath, 'utf8');
    let stagedBeforeIssue = fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8');
    const issue = LiveInterventionFileStore.prototype.issue;
    vi.spyOn(LiveInterventionFileStore.prototype, 'issue').mockImplementation(async function (this: LiveInterventionFileStore, ...args) {
      const id = await issue.apply(this, args);
      expect(fs.readFileSync(fixture.sourceOrderPath, 'utf8')).toBe(sourceBeforeIssue);
      expect(fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8')).toBe(stagedBeforeIssue);
      vi.setSystemTime(Date.now() + 60_000);
      return id;
    });
    expect(sourceBeforeIssue.startsWith(ORIGINAL_ORDER)).toBe(true);
    expect(stagedBeforeIssue).toBe(sourceBeforeIssue);

    for (const content of ['最初の追加指示\n空白を保持する。  ', '二番目の追加指示']) {
      const result = await fixture.tell(content);
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      const response = JSON.parse(firstTextContent(result.content)) as { instructionId: number };
      expect(fs.readFileSync(fixture.sourceOrderPath, 'utf8')).toBe(sourceBeforeIssue);
      expect(fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8')).toBe(stagedBeforeIssue);
      expect(fixture.store.read().pending).toBe(1);
      await fixture.deliver();
      const source = fs.readFileSync(fixture.sourceOrderPath, 'utf8');
      const staged = fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8');
      const instruction = fixture.store.read().instructions.find((entry) => entry.instructionId === response.instructionId);
      expect(instruction).toMatchObject({ content, state: 'deliveredNextStep' });
      const appended = source.slice(sourceBeforeIssue.length);
      expect(source.startsWith(sourceBeforeIssue)).toBe(true);
      expect(staged.startsWith(stagedBeforeIssue)).toBe(true);
      expect(appended).toContain('追加の指示');
      expect(appended).toContain(content);
      expect(appended).toMatch(new RegExp(`\\b${response.instructionId}\\b`));
      expect(appended).toContain(instruction!.issuedAt);
      expect(staged).toBe(source);
      sourceBeforeIssue = source;
      stagedBeforeIssue = staged;
    }
    expect(fixture.store.read().instructions.map(({ instructionId }) => instructionId)).toEqual([1, 2, 3]);
    expect(sourceBeforeIssue.startsWith(ORIGINAL_ORDER)).toBe(true);
  });

  it('leaves both order files unchanged when the run terminates before dispatch', async () => {
    const fixture = await createFixture(false);
    await fixture.tell('未配送の指示');
    await fixture.store.recordTerminal('failed');
    expect(fixture.store.read()).toMatchObject({ unconsumedWarned: 1 });
    expect(fs.readFileSync(fixture.sourceOrderPath, 'utf8')).toBe(ORIGINAL_ORDER);
    expect(fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8')).toBe(ORIGINAL_ORDER);
  });

  it('refreshes a merge run in the project while preserving the clone-side context', async () => {
    const fixture = await createFixture(true);
    const clonePaths = buildRunPaths(fixture.cloneCwd, RUN_SLUG);
    fs.mkdirSync(clonePaths.contextTaskAbs, { recursive: true });
    fs.writeFileSync(clonePaths.contextTaskOrderAbs, 'clone context must stay unchanged');

    const result = await fixture.tell('merge の追加指示');

    expect(result.isError, firstTextContent(result.content)).toBeUndefined();
    await fixture.deliver();
    expect(fs.readFileSync(fixture.sourceOrderPath, 'utf8')).toContain('merge の追加指示');
    expect(fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8')).toContain('merge の追加指示');
    expect(fs.readFileSync(clonePaths.contextTaskOrderAbs, 'utf8')).toBe('clone context must stay unchanged');
    expect(fs.existsSync(join(clonePaths.runRootAbs, 'interventions.jsonl'))).toBe(false);
  });

  it('rewrites attachment references for the active run and preserves unrelated and already staged paths', async () => {
    const fixture = await createFixture(false);
    const attachmentRel = '.takt/runs/run-a/context/task/attachments/a.png';
    const body = [
      '参照: attachments/a.png', '`attachments/a.png`',
      'docs/attachments/a.png', `\`${attachmentRel}\``,
    ].join('\n');
    fs.writeFileSync(fixture.sourceOrderPath, body);
    fixture.stage();

    const result = await fixture.tell('確認を追加する: `attachments/a.png`');
    await fixture.deliver();

    expect(result.isError, firstTextContent(result.content)).toBeUndefined();
    const source = fs.readFileSync(fixture.sourceOrderPath, 'utf8');
    const staged = fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8');
    expect(source.startsWith(body)).toBe(true);
    expect(source).toContain('確認を追加する: `attachments/a.png`');
    expect(staged.split('\n').slice(0, 4)).toEqual([
      `参照: \`${attachmentRel}\``, `\`${attachmentRel}\``,
      'docs/attachments/a.png', `\`${attachmentRel}\``,
    ]);
    expect(staged).toContain(`確認を追加する: \`${attachmentRel}\``);
    expect(fs.readFileSync(join(fixture.execCwd, attachmentRel), 'utf8')).toBe('original-image');
  });

  it('returns MCP success and preserves delivery when the source order cannot be appended', async () => {
    const fixture = await createFixture(false);
    fs.rmSync(fixture.sourceOrderPath);
    fs.mkdirSync(fixture.sourceOrderPath);
    const warnings = captureStderr();

    const result = await fixture.tell('追記に失敗しても配送する');

    expect(result.isError, firstTextContent(result.content)).toBeUndefined();
    expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ runSlug: RUN_SLUG, instructionId: 1 });
    expect(fixture.store.read().instructions).toEqual([
      expect.objectContaining({ instructionId: 1, content: '追記に失敗しても配送する', state: 'pending' }),
    ]);
    expect(JSON.parse(fs.readFileSync(fixture.store.getFilePath(), 'utf8'))).toMatchObject({
      type: 'issued', instructionId: 1, content: '追記に失敗しても配送する',
    });
    await fixture.deliver();
    expect(fixture.store.read()).toMatchObject({ pending: 0, deliveredNextStep: 1 });
    expect(fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8')).toBe(ORIGINAL_ORDER);
    expect(warnings.join('')).toContain(RUN_SLUG);
  });

  it.each(['attachment copy', 'order publication'] as const)(
    'preserves the active context after a failed %s and refreshes it on the next tell',
    async (failure) => {
      const fixture = await createFixture(false);
      const stagedAttachmentPath = join(fixture.runPaths.contextTaskAbs, 'attachments', 'a.png');
      const extraPath = join(fixture.runPaths.contextTaskAbs, 'agent-notes.txt');
      fs.writeFileSync(extraPath, 'existing agent notes');
      const contextBefore = fs.readdirSync(fixture.runPaths.contextAbs).sort();
      const warnings = captureStderr();
      let injected = false;
      let publishedWhileStaging: string | undefined;
      const { copyFileSync: copy, renameSync: rename } = await vi.importActual<typeof import('node:fs')>('node:fs');
      const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
        if (failure === 'attachment copy' && String(source) === fixture.attachmentPath) {
          injected = true;
          if (fs.existsSync(fixture.runPaths.contextTaskOrderAbs)) {
            publishedWhileStaging = fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8');
          }
          copy(source, destination, flags);
          throw new Error('deterministic attachment copy failure');
        }
        copy(source, destination, flags);
      });
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (failure === 'order publication' && String(destination) === fixture.runPaths.contextTaskOrderAbs) {
          injected = true;
          if (fs.existsSync(fixture.runPaths.contextTaskOrderAbs)) {
            publishedWhileStaging = fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8');
          }
          throw new Error('deterministic order publication failure');
        }
        rename(source, destination);
      });

      const result = await fixture.tell('失敗時にも正本に残す指示');
      await fixture.deliver();

      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expect(injected).toBe(true);
      expect(publishedWhileStaging).toBe(ORIGINAL_ORDER);
      expect(fixture.store.read()).toMatchObject({ issuedTotal: 1, pending: 0, deliveredNextStep: 1 });
      expect(fs.readFileSync(fixture.sourceOrderPath, 'utf8')).toContain('失敗時にも正本に残す指示');
      expect(fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8')).toBe(ORIGINAL_ORDER);
      expect(fs.readFileSync(stagedAttachmentPath, 'utf8')).toBe('original-image');
      expect(fs.readFileSync(extraPath, 'utf8')).toBe('existing agent notes');
      expect(fs.readdirSync(fixture.runPaths.contextAbs).sort()).toEqual(contextBefore);
      expect(warnings.join('')).toContain(RUN_SLUG);
      copySpy.mockRestore();
      renameSpy.mockRestore();

      const retried = await fixture.tell('次の追加指示');
      await fixture.deliver();

      expect(retried.isError, firstTextContent(retried.content)).toBeUndefined();
      const staged = fs.readFileSync(fixture.runPaths.contextTaskOrderAbs, 'utf8');
      expect(staged).toContain('失敗時にも正本に残す指示');
      expect(staged).toContain('次の追加指示');
      expect(fs.readFileSync(stagedAttachmentPath, 'utf8')).toBe('original-image');
      expect(fs.readFileSync(extraPath, 'utf8')).toBe('existing agent notes');
      expect(fs.readdirSync(fixture.runPaths.contextAbs).sort()).toEqual(contextBefore);
    },
  );
});
