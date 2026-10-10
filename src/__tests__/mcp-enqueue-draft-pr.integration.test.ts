import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createTaktMcpServer } from '../app/mcp/server.js';
import type { McpOperationDependencies } from '../features/mcp/operations.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { postExecutionFlow } from '../features/tasks/execute/postExecution.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import * as taskInfra from '../infra/task/index.js';
import * as taskGit from '../infra/task/git.js';
import { firstTextContent } from './helpers/mcp-content.js';

const paths = [
  { path: 'normal', issue: undefined, issueNumber: undefined },
  { path: 'existing issue', issue: { number: 937 }, issueNumber: 937 },
  { path: 'new issue', issue: { create: true }, issueNumber: 938 },
] as const;
const drafts = [
  { flag: 'true', draftPr: true },
  { flag: 'false', draftPr: false },
  { flag: 'omitted', draftPr: undefined },
] as const;

async function callEnqueue(
  cwd: string,
  input: Record<string, unknown>,
  deps: McpOperationDependencies = {},
) {
  const server = createTaktMcpServer(deps, { allowedProjectRoot: cwd });
  const client = new Client({ name: 'takt-mcp-draft-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await client.callTool({
      name: 'takt_enqueue_task',
      arguments: { cwd, task: 'Implement draft selection', workflow: 'default', autoPr: true, ...input },
    });
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP draft selection persistence and execution', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-draft-'));
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), [
      'branch_name_strategy: romaji',
      'vcs_provider: github',
      'draft_pr: true',
      'caccia:',
      '  enabled: false',
      '',
    ].join('\n'), 'utf8');
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each([
    { path: 'existing issue', issue: { number: 938 }, running: false },
    { path: 'existing issue', issue: { number: 938 }, running: true },
    { path: 'new issue', issue: { create: true }, running: false },
    { path: 'new issue', issue: { create: true }, running: true },
  ])('allows MCP same-target registration for $path with running=$running', async ({ issue, running }) => {
    const created = await callEnqueue(cwd, { issue: { number: 938 } });
    expect(created.isError).toBeUndefined();
    const runner = new taskInfra.TaskRunner(cwd);
    const [first] = runner.listTasks();
    expect(first).toBeDefined();
    if (running) runner.claimNextTasks(1);
    const specsBefore = readdirSync(join(cwd, '.takt', 'tasks')).sort();
    const createIssueFromTaskResult = vi.fn<NonNullable<McpOperationDependencies['createIssueFromTaskResult']>>()
      .mockReturnValue({ success: true, issueNumber: 938, issueUrl: 'https://example.test/issues/938' });

    const duplicate = await callEnqueue(cwd, { issue }, { createIssueFromTaskResult });

    expect(duplicate.isError, firstTextContent(duplicate.content)).toBeUndefined();
    const payload = JSON.parse(firstTextContent(duplicate.content)) as { taskName: string };
    const tasks = (parseYaml(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')) as {
      tasks: Array<{ name: string; status: string; issue?: number }>;
    }).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ name: first!.name, status: running ? 'running' : 'pending', issue: 938 });
    expect(tasks[1]).toMatchObject({ name: payload.taskName, status: 'pending', issue: 938 });
    expect(payload.taskName).not.toBe(first!.name);
    const specsAfter = readdirSync(join(cwd, '.takt', 'tasks')).sort();
    expect(specsAfter).toEqual(expect.arrayContaining(specsBefore));
    expect(specsAfter).toHaveLength(specsBefore.length + 1);
    expect(createIssueFromTaskResult).toHaveBeenCalledTimes('create' in issue ? 1 : 0);
  });

  it.each([
    { taskContext: { branch: 'topic/fix' }, saved: { branch: 'topic/fix' }, running: false },
    { taskContext: { branch: 'topic/fix' }, saved: { branch: 'topic/fix' }, running: true },
    { taskContext: { prNumber: 937 }, saved: { context_pr_number: 937 }, running: false },
    { taskContext: { prNumber: 937 }, saved: { context_pr_number: 937 }, running: true },
  ])('preserves duplicate MCP task context $taskContext with running=$running', async ({ taskContext, saved, running }) => {
    const firstResult = await callEnqueue(cwd, { taskContext });
    expect(firstResult.isError).toBeUndefined();
    const runner = new taskInfra.TaskRunner(cwd);
    const [first] = runner.listTasks();
    if (running) runner.claimNextTasks(1);

    const secondResult = await callEnqueue(cwd, { taskContext });

    expect(secondResult.isError, firstTextContent(secondResult.content)).toBeUndefined();
    const payload = JSON.parse(firstTextContent(secondResult.content)) as { taskName: string };
    const records = (parseYaml(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')) as {
      tasks: Array<Record<string, unknown>>;
    }).tasks;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ ...saved, name: first!.name, status: running ? 'running' : 'pending' });
    expect(records[1]).toMatchObject({ ...saved, name: payload.taskName, status: 'pending' });
    expect(payload.taskName).not.toBe(first!.name);
    if ('prNumber' in taskContext) {
      for (const record of records) expect(record).not.toHaveProperty('pr_number');
    }
  });

  it.each(paths.flatMap((path) => drafts.map((draft) => ({ ...path, ...draft }))))(
    'persists draftPr $flag and echoes saved settings for $path enqueue',
    async ({ issue, issueNumber, draftPr }) => {
      const createIssueFromTaskResult = vi.fn<NonNullable<McpOperationDependencies['createIssueFromTaskResult']>>()
        .mockReturnValue({ success: true, issueNumber: 938, issueUrl: 'https://example.test/issues/938' });

      const result = await callEnqueue(cwd, {
        ...(issue === undefined ? {} : { issue }),
        ...(draftPr === undefined ? {} : { draftPr }),
      }, { createIssueFromTaskResult });

      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      const tasksFile = join(cwd, '.takt', 'tasks.yaml');
      const payload = JSON.parse(firstTextContent(result.content)) as Record<string, unknown>;
      const saved = parseYaml(readFileSync(tasksFile, 'utf8')) as { tasks: Array<Record<string, unknown>> };
      expect(saved.tasks).toHaveLength(1);
      const record = saved.tasks[0]!;
      expect(record.worktree).toBe(true);
      expect(record.auto_pr).toBe(true);
      if (draftPr === undefined) {
        expect(record).not.toHaveProperty('draft_pr');
      } else {
        expect(record.draft_pr).toBe(draftPr);
      }
      expect.soft(payload).toEqual({
        taskName: record.name,
        tasksFile,
        workflow: 'default',
        worktree: record.worktree,
        autoPr: record.auto_pr,
        draftPr: draftPr === undefined ? null : record.draft_pr,
        ...(issueNumber === undefined ? {} : { issueNumber }),
      });
      const [restored] = new taskInfra.TaskRunner(cwd).listTasks();
      expect(restored?.data?.draft_pr).toBe(draftPr);
      if (issueNumber === undefined) {
        expect(record).not.toHaveProperty('issue');
      } else {
        expect(record.issue).toBe(issueNumber);
      }
      if (issue !== undefined && 'create' in issue) {
        expect(createIssueFromTaskResult).toHaveBeenCalledOnce();
      } else {
        expect(createIssueFromTaskResult).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { source: 'project', configDraft: true, draftPr: false, expectedDraft: false },
    { source: 'global', configDraft: true, draftPr: false, expectedDraft: false },
    { source: 'project', configDraft: true, draftPr: undefined, expectedDraft: true },
    { source: 'global', configDraft: true, draftPr: undefined, expectedDraft: true },
    { source: 'project', configDraft: false, draftPr: true, expectedDraft: true },
  ] as const)(
    'passes saved draftPr $draftPr to PR creation with $source draft setting $configDraft',
    async ({ source, configDraft, draftPr, expectedDraft }) => {
      const configDir = process.env.TAKT_CONFIG_DIR;
      if (!configDir) throw new Error('The test setup must provide an isolated configuration directory');
      writeFileSync(join(configDir, 'config.yaml'), `language: en\ndraft_pr: ${source === 'global' ? configDraft : !configDraft}\n`, 'utf8');
      writeFileSync(join(cwd, '.takt', 'config.yaml'), [
        'branch_name_strategy: romaji',
        'vcs_provider: github',
        ...(source === 'project' ? [`draft_pr: ${configDraft}`] : []),
        'caccia:',
        '  enabled: false',
        '',
      ].join('\n'), 'utf8');
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();
      const cloneCwd = join(cwd, '.takt', 'worktrees', 'draft');
      mkdirSync(cloneCwd, { recursive: true });
      vi.spyOn(taskInfra, 'resolveBaseBranch').mockReturnValue({ branch: 'main' });
      vi.spyOn(taskInfra, 'branchExists').mockReturnValue(false);
      vi.spyOn(taskInfra, 'createSharedCloneAbortable').mockResolvedValue({ path: cloneCwd, branch: 'takt/draft' });
      vi.spyOn(taskInfra, 'autoCommitAndPush').mockResolvedValue({ success: true, commitHash: 'abc123', message: 'Committed' });
      vi.spyOn(taskGit, 'pushBranch').mockReturnValue(undefined);
      const gitProvider = new GitHubProvider();
      vi.spyOn(gitProvider, 'findExistingPr').mockReturnValue(undefined);
      const createPullRequest = vi.spyOn(gitProvider, 'createPullRequest')
        .mockReturnValue({ success: true, url: 'https://example.test/pull/1' });

      const enqueued = await callEnqueue(cwd, draftPr === undefined ? {} : { draftPr });
      expect(enqueued.isError, firstTextContent(enqueued.content)).toBeUndefined();
      const [restored] = new taskInfra.TaskRunner(cwd).listTasks();
      if (!restored) throw new Error('The MCP call did not persist a pending task');
      const resolved = await resolveTaskExecution(restored, cwd, undefined, { outputMode: 'silent' });
      expect(resolved.isWorktree).toBe(true);
      const completed = await postExecutionFlow({
        execCwd: resolved.execCwd,
        projectCwd: cwd,
        task: restored.name,
        branch: resolved.branch,
        baseBranch: resolved.baseBranch,
        shouldCreatePr: resolved.autoPr,
        draftPr: resolved.draftPr,
        workflowIdentifier: resolved.workflowIdentifier,
        orderContent: resolved.taskSpec?.orderContent,
        gitProvider,
        outputMode: 'silent',
      });

      expect(completed).toEqual({ prUrl: 'https://example.test/pull/1' });
      expect(createPullRequest).toHaveBeenCalledOnce();
      expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({
        branch: 'takt/draft',
        draft: expectedDraft,
      }), cwd);
    },
  );
});
