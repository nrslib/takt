import { firstTextContent } from './helpers/mcp-content.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { createTaktMcpServer } from '../app/mcp/server.js';
import type { SessionContext } from '../features/interactive/aiCaller.js';
import { createConversationSession } from '../features/interactive/conversationSession.js';
import { getTaktRun, listTaktTasks } from '../features/mcp/operations.js';
import { resolveCloneBaseDir } from '../infra/task/index.js';
import { getCloneMetaPath } from '../infra/task/clone-meta.js';
import { MCP_RESPONSE_MAX_BYTES } from '../features/mcp/response.js';
import { tellTaktGoalRun } from '../features/mcp/goalTellOperations.js';
import { goalTellSummary } from '../features/mcp/goalResponse.js';
import * as liveIntervention from '../features/tasks/liveIntervention.js';
import * as goalNotifications from '../features/manager/notifications.js';
import { ensureManagerRun } from '../features/manager/autoRun.js';
import { GoalStore } from '../infra/goals/store.js';
import type { Goal } from '../infra/goals/schema.js';
import { TaskRunner, type TaskState } from '../infra/task/index.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const { readFileSyncMock, readRunMetaBySlugMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
  readRunMetaBySlugMock: vi.fn(),
}));

// Synthetic queue records remain fixed while these tests inspect the MCP contract.
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  readFileSyncMock.mockImplementation(actual.readFileSync);
  return { ...actual, readFileSync: readFileSyncMock };
});

vi.mock('../core/workflow/run/run-meta.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/run/run-meta.js')>();
  readRunMetaBySlugMock.mockImplementation(actual.readRunMetaBySlug);
  return { ...actual, readRunMetaBySlug: readRunMetaBySlugMock };
});


describe('goal tell operation', () => {
  let goal: Goal;
  let task: TaskState;
  let target: liveIntervention.TellableRunningTask;
  const input = { cwd: '/project', goalId: goalRecord().id, taskName: 'active', content: '  追加指示\n ' };
  const signal = new AbortController().signal;

  beforeEach(() => {
    goal = goalRecord();
    task = { name: 'active', kind: 'running', status: 'running', goalId: goal.id, runSlug: 'active-run',
      worktree: true, worktreePath: '/project/.takt/worktrees/active',
      filePath: '/project/.takt/tasks.yaml', createdAt: '2026-10-15T00:00:00Z' };
    target = { task, runSlug: 'active-run', worktreePath: task.worktreePath!, meta: {
      task: 'work', workflow: 'safe', runSlug: 'active-run', runRoot: '.takt/runs/active-run',
      reportDirectory: 'reports', contextDirectory: 'context', logsDirectory: 'logs',
      status: 'running', startTime: '2026-10-15T00:00:00Z',
    } };
    vi.spyOn(GoalStore.prototype, 'get').mockImplementation(async () => goal);
    vi.spyOn(GoalStore.prototype, 'update').mockImplementation(async (_id, transform) => {
      goal = transform(goal);
      return goal;
    });
    vi.spyOn(TaskRunner.prototype, 'listTaskStateItems').mockImplementation(() => [task]);
    vi.spyOn(liveIntervention, 'resolveTellableRunningTask').mockImplementation(() => target);
    vi.spyOn(liveIntervention, 'issueTellableRunningTask').mockImplementation(async () => ({ instructionId: 7, target }));
    vi.spyOn(goalNotifications, 'resolveManagerNotificationOptions').mockReturnValue({
      mainMerge: 'approve', webhookUrl: undefined,
      policy: { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true },
    });
    vi.spyOn(goalNotifications, 'sendSavedGoalNotifications').mockResolvedValue();
  });

  afterEach(() => {
    for (const mock of [GoalStore.prototype.get, GoalStore.prototype.update, TaskRunner.prototype.listTaskStateItems,
      liveIntervention.resolveTellableRunningTask, liveIntervention.issueTellableRunningTask,
      goalNotifications.resolveManagerNotificationOptions, goalNotifications.sendSavedGoalNotifications]) {
      vi.mocked(mock).mockRestore();
    }
  });

  it('issues the instruction before saving the original work log, then notifies and returns only saved identities', async () => {
    const previous = goal;
    vi.mocked(liveIntervention.issueTellableRunningTask).mockImplementation(async () => {
      expect(goal.workLog).toEqual(previous.workLog);
      expect(GoalStore.prototype.update).not.toHaveBeenCalled();
      expect(goalNotifications.sendSavedGoalNotifications).not.toHaveBeenCalled();
      return { instructionId: 7, target };
    });
    vi.mocked(GoalStore.prototype.update).mockImplementation(async (_id, transform) => {
      expect(liveIntervention.issueTellableRunningTask).toHaveResolvedWith({ instructionId: 7, target });
      expect(goalNotifications.sendSavedGoalNotifications).not.toHaveBeenCalled();
      goal = transform(goal);
      return goal;
    });
    vi.mocked(goalNotifications.sendSavedGoalNotifications).mockImplementation(async (_cwd, before, current) => {
      expect(before).toEqual(previous);
      expect(current.workLog.at(-1)?.summary).toBe(input.content);
      expect(liveIntervention.issueTellableRunningTask).toHaveBeenCalledOnce();
    });
    const result = await tellTaktGoalRun(input, {}, signal);
    expect(result.isError).toBeUndefined();
    expect(liveIntervention.issueTellableRunningTask).toHaveBeenCalledExactlyOnceWith(input.cwd, 'active-run', input.content);
    expect(goal.workLog.at(-1)?.summary).toBe(input.content);
    expect(JSON.parse(firstTextContent(result.content))).toEqual({
      goalId: goal.id, taskName: task.name, runSlug: 'active-run', instructionId: 7, workLogEntryId: goal.workLog.at(-1)!.id,
    });
    expect(goalNotifications.sendSavedGoalNotifications).toHaveBeenCalledOnce();
  });

  it.each(['missing task', 'different goal', 'not running', 'missing run', 'different run task', 'different run goal'])(
    'rejects %s before saving or notifying', async (condition) => {
      if (condition === 'missing task') vi.mocked(TaskRunner.prototype.listTaskStateItems).mockReturnValue([]);
      if (condition === 'different goal') task = { ...task, goalId: '550e8400-e29b-41d4-a716-446655440001' };
      if (condition === 'not running') task = { ...task, kind: 'completed', status: 'completed' };
      if (condition === 'missing run') task = { ...task, runSlug: undefined };
      if (condition === 'different run task') target = { ...target, task: { ...task, name: 'other' } };
      if (condition === 'different run goal') target = { ...target, task: { ...task, goalId: undefined } };
      const result = await tellTaktGoalRun(input, {}, signal);
      expect(result.isError).toBe(true);
      expect(liveIntervention.issueTellableRunningTask).not.toHaveBeenCalled();
      expect(GoalStore.prototype.update).not.toHaveBeenCalled();
      expect(goalNotifications.sendSavedGoalNotifications).not.toHaveBeenCalled();
      expect(goal.workLog).toEqual([]);
    },
  );

  it.each(['write failed', 'EACCES: permission denied', 'ENOENT: no such file or directory'])(
    'reports the issued instruction identity without notifying when saving fails with %s', async (message) => {
      vi.mocked(GoalStore.prototype.update).mockRejectedValue(new Error(message));
      const result = await tellTaktGoalRun(input, {}, signal);
      expect(result.isError).toBe(true);
      expect(goal.workLog).toEqual([]);
      expect(firstTextContent(result.content)).toContain('Instruction 7 was issued');
      expect(firstTextContent(result.content)).toContain('saving the goal work log failed');
      expect(liveIntervention.issueTellableRunningTask).toHaveBeenCalledExactlyOnceWith(input.cwd, 'active-run', input.content);
      expect(goalNotifications.sendSavedGoalNotifications).not.toHaveBeenCalled();
    },
  );

  it('returns an error without saving or notifying when issuing the instruction fails', async () => {
    const previous = goal;
    vi.mocked(liveIntervention.issueTellableRunningTask).mockRejectedValue(new Error('write failed'));
    const result = await tellTaktGoalRun(input, {}, signal);
    expect(result.isError).toBe(true);
    expect(goal).toEqual(previous);
    expect(GoalStore.prototype.update).not.toHaveBeenCalled();
    expect(goalNotifications.sendSavedGoalNotifications).not.toHaveBeenCalled();
  });

  it('formats only the instruction and work log identities', () => {
    expect(goalTellSummary(goal.id, 'active', 'active-run', 7, 'saved-id')).toEqual({
      goalId: goal.id, taskName: 'active', runSlug: 'active-run', instructionId: 7, workLogEntryId: 'saved-id',
    });
  });

  it.each(['paused', 'aborted', 'not running'] as const)('does not launch the runner after rejecting %s work through MCP', async (condition) => {
    if (condition === 'not running') task = { ...task, kind: 'pending', status: 'pending' };
    else goal = { ...goal, executionStatus: condition };
    vi.mocked(ensureManagerRun).mockClear();
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: process.cwd() });
    const client = new Client({ name: 'tell-no-launch', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: 'takt_tell_run', arguments: { ...input, cwd: process.cwd() } });
      expect(result.isError).toBe(true);
      expect(GoalStore.prototype.get).toHaveBeenCalledWith(input.goalId);
      expect(ensureManagerRun).not.toHaveBeenCalled();
      expect(liveIntervention.issueTellableRunningTask).not.toHaveBeenCalled();
      expect(GoalStore.prototype.update).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });
});

function writeRunFixture(
  baseCwd: string,
  runSlug: string,
  currentStep: string,
  reportContent = 'report',
): { runDir: string; interventionPath: string } {
  const runDir = join(baseCwd, '.takt', 'runs', runSlug);
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  mkdirSync(join(runDir, 'reports'), { recursive: true });
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    task: runSlug,
    workflow: 'default',
    runSlug,
    runRoot: `.takt/runs/${runSlug}`,
    reportDirectory: `.takt/runs/${runSlug}/reports`,
    contextDirectory: `.takt/runs/${runSlug}/context`,
    logsDirectory: `.takt/runs/${runSlug}/logs`,
    status: 'running',
    startTime: '2026-09-09T00:00:00.000Z',
    currentStep,
  }), 'utf-8');
  writeFileSync(join(runDir, 'reports', '00-progress.md'), reportContent, 'utf-8');
  return {
    runDir,
    interventionPath: join(baseCwd, '.takt', 'runs', runSlug, 'interventions.jsonl'),
  };
}

function writeRunningCloneFixture(cwd: string) {
  const runSlug = 'active-run';
  const cloneCwd = join(cwd, '.takt', 'worktrees', 'active');
  writeRunFixture(cloneCwd, runSlug, 'implement');
  mkdirSync(join(cwd, '.takt', 'runs', runSlug), { recursive: true });
  writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({ tasks: [{
    name: 'active', status: 'running', content: 'Active task', workflow: 'default',
    worktree: true, auto_pr: false, created_at: '2026-09-09T00:00:00.000Z',
    started_at: '2026-09-09T00:00:00.000Z', completed_at: null,
    run_slug: runSlug, worktree_path: cloneCwd,
  }] }));
  return { runSlug, cloneCwd, interventionPath: join(cwd, '.takt', 'runs', runSlug, 'interventions.jsonl') };
}

it.each([
  { name: 'short', content: 'Saved additional instruction.', maxBytes: 4096 },
  { name: 'long', content: 'a'.repeat(65537), maxBytes: 4096 },
  { name: 'UTF-8', content: '追加指示', maxBytes: 4 },
])('retrieves the complete $name instruction by the ID returned from tell', async ({ content, maxBytes }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-instruction-'));
  const { runSlug, cloneCwd, interventionPath } = writeRunningCloneFixture(cwd);
  const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
  const client = new Client({ name: 'instruction-read-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, input: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: { cwd, runSlug, ...input } });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      return JSON.parse(firstTextContent(result.content));
    };
    const first = await call('takt_tell_run', { content: 'First instruction' });
    const second = await call('takt_tell_run', { content });
    expect(second.instructionId).not.toBe(first.instructionId);
    const saved = readFileSync(interventionPath, 'utf8');
    const savedQueue = readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8');
    const summary = await call('takt_get_run', {});
    if (Buffer.byteLength(content) > MCP_RESPONSE_MAX_BYTES) {
      expect(summary.truncated).toBe(true);
      expect(summary.omissions).toContainEqual(expect.objectContaining({
        path: 'liveIntervention.instructions[].content',
        totalBytes: Buffer.byteLength(content), returnedBytes: 4096,
      }));
    }
    const firstRead = await call('takt_get_run', { view: 'instructions', instructionId: first.instructionId });
    expect(firstRead.instruction).toMatchObject({ instructionId: first.instructionId,
      content: 'First instruction', state: 'pending', truncated: false, nextOffset: null });
    if (maxBytes === 4) {
      expect((await call('takt_get_run', { view: 'instructions', instructionId: second.instructionId, maxBytes: 4096 })).instruction)
        .toMatchObject({ content, truncated: false, nextOffset: null });
    }
    let restored = '';
    let offset = 0;
    for (;;) {
      const { instruction } = await call('takt_get_run', { view: 'instructions', instructionId: second.instructionId, offset, maxBytes });
      expect(instruction).toMatchObject({ instructionId: second.instructionId, state: 'pending',
        offset, totalBytes: Buffer.byteLength(content), direction: 'forward' });
      expect(instruction.returnedBytes).toBe(Buffer.byteLength(instruction.content));
      expect(instruction.returnedBytes).toBeGreaterThan(0);
      expect(instruction.returnedBytes).toBeLessThanOrEqual(maxBytes);
      expect(instruction.truncated).toBe(offset > 0 || instruction.returnedBytes < Buffer.byteLength(content));
      restored += instruction.content;
      if (instruction.nextOffset === null) break;
      expect(instruction.nextOffset).toBe(offset + instruction.returnedBytes);
      offset = instruction.nextOffset;
    }
    expect(restored).toBe(content);
    expect(readFileSync(interventionPath, 'utf8')).toBe(saved);
    expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8')).toBe(savedQueue);
    expect(existsSync(join(cloneCwd, '.takt', 'runs', runSlug, 'interventions.jsonl'))).toBe(false);
  } finally {
    await client.close(); await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('lists saved instructions in order with empty and 50-item page boundaries and rejects invalid selections', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-instruction-list-'));
  const { runSlug, interventionPath } = writeRunningCloneFixture(cwd);
  const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
  const client = new Client({ name: 'instruction-list-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const read = async (input: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name: 'takt_get_run', arguments: { cwd, runSlug, view: 'instructions', ...input } });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      return JSON.parse(firstTextContent(result.content));
    };
    expect(await read()).toMatchObject({ instructions: [], collection: 'instructions', totalCount: 0,
      returnedCount: 0, omittedCount: 0, offset: 0, nextOffset: null, truncated: false });
    const ids: number[] = [];
    for (let index = 0; index < 51; index++) {
      const result = await client.callTool({ name: 'takt_tell_run', arguments: { cwd, runSlug, content: `Instruction ${index}` } });
      expect(result.isError).toBeUndefined();
      ids.push(JSON.parse(firstTextContent(result.content)).instructionId);
      if (index === 0) expect(await read()).toMatchObject({ totalCount: 1, returnedCount: 1, nextOffset: null, truncated: false });
    }
    writeFileSync(interventionPath, readFileSync(interventionPath, 'utf8') + JSON.stringify({
      type: 'delivered', instructionIds: [ids[0]], deliveredAt: '2026-09-09T00:02:00.000Z',
      mode: 'next_step', step: 'implement', phase: 1,
    }) + '\n');
    const saved = readFileSync(interventionPath, 'utf8');
    const first = await read({ limit: 50 });
    expect(first).toMatchObject({ totalCount: 51, returnedCount: 50, omittedCount: 1, offset: 0, nextOffset: 50, truncated: true });
    expect(first.instructions[0]).toMatchObject({ instructionId: ids[0], state: 'deliveredNextStep', deliveryMode: 'next_step' });
    const second = await read({ limit: 50, offset: first.nextOffset });
    expect(second).toMatchObject({ totalCount: 51, returnedCount: 1, omittedCount: 50, offset: 50, nextOffset: null, truncated: true });
    const instructions = [...first.instructions, ...second.instructions];
    expect(instructions.map((entry) => entry.instructionId)).toEqual(ids);
    for (const entry of instructions) {
      expect(entry.issuedAt).toEqual(expect.any(String));
      expect(entry).not.toHaveProperty('content');
    }
    expect((await read({ instructionId: ids[0] })).instruction).toMatchObject({
      content: 'Instruction 0', state: 'deliveredNextStep', deliveryMode: 'next_step',
    });
    for (const input of [
      { instructionId: 0 }, { instructionId: -1 }, { instructionId: 1.5 }, { instructionId: Number.MAX_SAFE_INTEGER + 1 },
      { instructionId: 52 }, { instructionId: 1, view: 'summary' }, { instructionId: 1, view: 'log' },
      { instructionId: 1, view: 'report', report: '00-progress.md' }, { instructionId: 1, view: undefined },
      { limit: 0 }, { limit: 51 }, { offset: -1 }, { instructionId: 1, maxBytes: 3 }, { instructionId: 1, maxBytes: 4097 },
    ]) {
      const result = await client.callTool({ name: 'takt_get_run', arguments: { cwd, runSlug, view: 'instructions', ...input } });
      expect(result.isError, JSON.stringify(input)).toBe(true);
    }
    expect(readFileSync(interventionPath, 'utf8')).toBe(saved);
  } finally {
    await client.close(); await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it.each(['read-only', 'all'] as const)('returns bounded run summaries and retrievable artifacts for %s', async (toolSet) => {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-bounded-'));
  const slug = 'large-run';
  const { runDir } = writeRunFixture(cwd, slug, 'implement', '先頭' + '日本語'.repeat(100000) + '末尾');
  for (let index = 0; index < 60; index++) writeFileSync(join(runDir, 'reports', `report-${String(index).padStart(3, '0')}.md`), '大容量'.repeat(30000));
  const metaPath = join(runDir, 'meta.json');
  const metadata = { ...JSON.parse(readFileSync(metaPath, 'utf8')), task: 'S'.repeat(16), currentIteration: 2, phase: 2 };
  writeFileSync(metaPath, JSON.stringify(metadata));
  writeFileSync(join(runDir, 'interventions.jsonl'), JSON.stringify({
    type: 'issued', instructionId: 1, issuedAt: '2026-09-09T00:00:00.000Z', content: '追加指示',
  }) + '\n');
  const timestamp = '2026-09-09T00:02:00.000Z';
  const log = (step: string, content: string, iteration: number) => ({ type: 'step_complete', step, persona: 'coder', status: 'done', iteration, content, instruction: 'work', timestamp });
  writeFileSync(join(runDir, 'logs', 'session.jsonl'), [
    { type: 'workflow_start', task: slug, workflowName: 'default', startTime: timestamp },
    log('plan', '先頭の計画' + '長文'.repeat(50000) + '計画の末尾', 1),
    { type: 'step_start', step: 'implement', persona: 'coder', iteration: 2, timestamp },
    log('implement', '先頭の実装' + '長文'.repeat(50000) + '実装の末尾', 2),
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const server = createTaktMcpServer({}, { allowedProjectRoot: cwd, toolSet, includeReferenceMarkers: true });
  const client = new Client({ name: 'bounded-run-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const schema = tools.tools.find((tool) => tool.name === 'takt_get_run')!.inputSchema;
    expect(schema.properties).toHaveProperty('view');
    expect(schema.properties).toHaveProperty('stepIndex');
    expect(schema.properties).toHaveProperty('report');
    const read = async (input: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'takt_get_run', arguments: { cwd, runSlug: slug, ...input } });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      const text = firstTextContent(result.content);
      expect(text.split('\n')).toHaveLength(2);
      return JSON.parse(text.split('\n')[0]!);
    };
    const selections = [{}, { view: 'summary' }, { view: 'log', maxBytes: 24 },
      { view: 'report', report: '00-progress.md', maxBytes: 24 },
      { view: 'instructions' }, { view: 'instructions', instructionId: 1, maxBytes: 4 }];
    const shortResponses = [];
    for (const selection of selections) shortResponses.push(await read(selection));
    const longTask = 'A'.repeat(4096) + 'B'.repeat(65904);
    writeFileSync(metaPath, JSON.stringify({ ...metadata, task: longTask }));
    for (const [index, selection] of selections.entries()) {
      const response = await read(selection);
      const short = shortResponses[index];
      expect(short).not.toHaveProperty('task');
      expect(response).not.toHaveProperty('task');
      expect(short.taskOmission).toEqual({ totalBytes: 16, returnedBytes: 0, truncated: true });
      expect(response.taskOmission).toEqual({ totalBytes: 70000, returnedBytes: 0, truncated: true });
      const { taskOmission: _shortOmission, ...shortContent } = short;
      const { taskOmission: _longOmission, ...longContent } = response;
      expect(longContent).toEqual(shortContent);
    }
    const summary = await read({});
    expect(summary.retrieval).toContain('view task');
    expect(summary.retrieval).toContain('task.nextOffset');
    let restoredTask = '';
    let taskOffset = 0;
    for (;;) {
      const response = await read({ view: 'task', offset: taskOffset });
      expect(response).not.toHaveProperty('taskOmission');
      const page = response.task;
      expect(page).toMatchObject({ totalBytes: 70000, offset: taskOffset, direction: 'forward',
        returnedBytes: Buffer.byteLength(page.content), truncated: true });
      expect(page.returnedBytes).toBeGreaterThan(0);
      expect(page.returnedBytes).toBeLessThanOrEqual(4096);
      if (taskOffset === 0) expect(page.content).toBe('A'.repeat(4096));
      if (taskOffset === 4096) expect(page.content).toBe('B'.repeat(4096));
      restoredTask += page.content;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBe(taskOffset + page.returnedBytes);
      taskOffset = page.nextOffset;
    }
    expect(restoredTask).toBe(longTask);
    expect(summary).toMatchObject({ status: 'running', currentStep: 'implement', currentIteration: 2,
      currentStepStartedAt: timestamp, currentStepExecutionCount: 1, phase: 2,
      stepLogs: [{ index: 0, step: 'plan', persona: 'coder', status: 'done', iteration: 1, timestamp }, { index: 1, step: 'implement', persona: 'coder', status: 'done', iteration: 2, timestamp }] });
    expect(summary.reports[0]).toEqual({ filename: '00-progress.md', sizeBytes: Buffer.byteLength('先頭' + '日本語'.repeat(100000) + '末尾') });
    for (const step of summary.stepLogs) expect(step).not.toHaveProperty('content');
    for (const report of summary.reports) expect(report).not.toHaveProperty('content');
    expect(summary.reportPage).toMatchObject({ totalCount: 61, returnedCount: 50, nextOffset: 50, truncated: true });
    expect((await read({ offset: 50 })).reports).toHaveLength(11);
    const latest = await read({ view: 'log', maxBytes: 24 });
    expect(latest.log).toMatchObject({ index: 1, truncated: true });
    expect(latest.log.content.endsWith('実装の末尾')).toBe(true);
    const earlier = await read({ view: 'log', stepIndex: 0, maxBytes: 24 });
    expect(earlier.log.content.endsWith('計画の末尾')).toBe(true);
    const preceding = await read({ view: 'log', maxBytes: 24, offset: latest.log.nextOffset });
    expect(preceding.log.offset + preceding.log.returnedBytes).toBe(latest.log.offset);
    const report = await read({ view: 'report', report: '00-progress.md', maxBytes: 24 });
    expect(report.report).toMatchObject({ offset: 0, truncated: true, nextOffset: 24 });
    expect(report.report.content.startsWith('先頭')).toBe(true);
    const next = await read({ view: 'report', report: '00-progress.md', maxBytes: 24, offset: report.report.nextOffset });
    expect(next.report.offset).toBe(24);
    writeFileSync(join(runDir, 'reports', 'small.md'), '短い本文');
    expect((await read({ view: 'report', report: 'small.md' })).report).toMatchObject({ content: '短い本文', truncated: false, nextOffset: null });
    const originalMeta = readFileSync(metaPath, 'utf8');
    writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(originalMeta), task: '\u0000'.repeat(6000), workflow: '\u0000'.repeat(6000), currentStep: '\u0000'.repeat(6000) }));
    const escaped = '先頭' + '\u0000'.repeat(8000) + '末尾';
    writeFileSync(join(runDir, 'reports', 'escaped.md'), escaped);
    const escapedReport = (await read({ view: 'report', report: 'escaped.md' })).report;
    expect(escapedReport.returnedBytes).toBeLessThan(4096);
    expect(escapedReport.returnedBytes).toBe(Buffer.byteLength(escapedReport.content));
    expect((await read({ view: 'report', report: 'escaped.md', offset: escapedReport.nextOffset })).report.offset)
      .toBe(escapedReport.offset + escapedReport.returnedBytes);
    writeFileSync(join(runDir, 'logs', 'session.jsonl'), [
      { type: 'workflow_start', task: slug, workflowName: 'default', startTime: timestamp },
      log('implement', escaped, 2),
    ].map((record) => JSON.stringify(record)).join('\n'));
    const escapedLog = (await read({ view: 'log' })).log;
    expect(escapedLog.returnedBytes).toBeLessThan(4096);
    expect(escapedLog.returnedBytes).toBe(Buffer.byteLength(escapedLog.content));
    expect(escapedLog.content.endsWith('末尾')).toBe(true);
    const escapedPrevious = (await read({ view: 'log', offset: escapedLog.nextOffset })).log;
    expect(escapedPrevious.offset + escapedPrevious.returnedBytes).toBe(escapedLog.offset);
    writeFileSync(metaPath, originalMeta);
    writeFileSync(join(runDir, 'logs', 'session.jsonl'), [
      { type: 'workflow_start', task: slug, workflowName: 'default', startTime: timestamp },
      log('small', '短いログ', 3),
    ].map((record) => JSON.stringify(record)).join('\n'));
    expect((await read({ view: 'log' })).log).toMatchObject({ content: '短いログ', truncated: false, nextOffset: null });
    const forbidden = await client.callTool({ name: 'takt_get_run', arguments: { cwd, runSlug: slug, view: 'report', report: '../meta.json' } });
    expect(forbidden.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it.each(['Short task', '日本語'])('reads task text with UTF-8 byte bounds and validates page sizes: %j', async (task) => {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-task-'));
  const runSlug = 'task-run';
  const { runDir } = writeRunFixture(cwd, runSlug, 'implement');
  const metaPath = join(runDir, 'meta.json');
  writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, 'utf8')), task }));
  const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
  const client = new Client({ name: 'task-read-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const read = async (input: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'takt_get_run', arguments: { cwd, runSlug, ...input } });
      expect(result.isError, firstTextContent(result.content)).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      return JSON.parse(firstTextContent(result.content));
    };
    const summary = await read({});
    expect(summary).not.toHaveProperty('task');
    expect(summary.taskOmission).toEqual({ totalBytes: Buffer.byteLength(task), returnedBytes: 0, truncated: task.length > 0 });
    const complete = await read({ view: 'task', maxBytes: 4096 });
    expect(complete).not.toHaveProperty('taskOmission');
    expect(complete.task).toEqual({ content: task, totalBytes: Buffer.byteLength(task), offset: 0,
      returnedBytes: Buffer.byteLength(task), direction: 'forward', truncated: false, nextOffset: null });
    const first = await read({ view: 'task', maxBytes: 4 });
    if (task === '日本語') {
      expect(first.task).toEqual({ content: '日', totalBytes: 9, offset: 0, returnedBytes: 3,
        direction: 'forward', truncated: true, nextOffset: 3 });
      expect((await read({ view: 'task', maxBytes: 4, offset: first.task.nextOffset })).task)
        .toMatchObject({ content: '本', offset: 3, returnedBytes: 3, nextOffset: 6 });
    }
    for (const maxBytes of [3, 4097]) {
      const rejected = await client.callTool({ name: 'takt_get_run', arguments: { cwd, runSlug, view: 'task', maxBytes } });
      expect(rejected.isError).toBe(true);
    }
  } finally {
    await client.close(); await server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

function writeCloneOwnershipMetadata(projectCwd: string, branch: string, clonePath: string): void {
  const metadataPath = getCloneMetaPath(projectCwd, branch);
  mkdirSync(dirname(metadataPath), { recursive: true });
  writeFileSync(metadataPath, JSON.stringify({ branch, clonePath }), 'utf-8');
}

function expectDescriptionMatches(description: unknown, requirement: string, pattern: RegExp): asserts description is string {
  expect(description, requirement).toEqual(expect.any(String));
  expect(description, requirement).toMatch(pattern);
}

function expectFailureSources(description: unknown, requirement: string, pattern: RegExp, sources: readonly string[]): void {
  expectDescriptionMatches(description, requirement, pattern);
  const failureSources = description.match(pattern)?.[1];
  for (const source of sources) {
    expect(failureSources, `${source}: ${requirement}`).toMatch(new RegExp(String.raw`\b${source}\b`, 'i'));
  }
}

function expectDraftPriorityAndInheritance(description: unknown, explicitSubject: string): void {
  expectDescriptionMatches(description, '明示値がproject・global設定より優先する説明',
    new RegExp(String.raw`(?:^|[.;]\s*)(?:an\s+)?explicit\s+${explicitSubject}\s+(?:is\s+saved(?:\s+as\s+draft_pr)?\s+and\s+)?(?:overrides|takes priority over)\s+project\s+and\s+global\s+(?:draft(?:_pr)?\s+)?settings\s*(?:[.;]|$)`, 'i'));
  expectDescriptionMatches(description, '省略時に設定を継承する説明',
    /(?:^|[.;]\s*)(?:omission(?:\s+of\s+draftPr)?\s+(?:saves\s+no\s+draft_pr\s+value\s+and\s+)?preserves\s+(?:configuration\s+)?inheritance|when\s+(?:draftPr\s+is\s+)?omitted,?\s+(?:no\s+draft_pr\s+is\s+saved\s+and\s+)?configuration\s+settings\s+apply)\s*(?:[.;]|$)/i);
  expect(description, '明示値の設定優先を否定する矛盾がない説明').not.toMatch(
    new RegExp(String.raw`\bexplicit\s+(?:draftPr|${explicitSubject})\s+(?:is\s+saved(?:\s+as\s+draft_pr)?\s+and\s+)?(?:does\s+not\s+(?:override|take\s+priority\s+over)|never\s+(?:overrides|takes\s+priority\s+over))\s+project\s+and\s+global\s+(?:draft(?:_pr)?\s+)?settings\b`, 'i'));
  expect(description, '省略時の設定継承を否定する矛盾がない説明').not.toMatch(
    /\b(?:when\s+(?:draftPr\s+is\s+)?omitted,?\s+(?:no\s+draft_pr\s+is\s+saved\s+and\s+)?configuration\s+settings\s+(?:do\s+not|never)\s+apply|omission(?:\s+of\s+draftPr)?\s+(?:saves\s+no\s+draft_pr\s+value\s+and\s+)?(?:does\s+not\s+preserve|never\s+preserves)\s+(?:configuration\s+)?inheritance)\b/i);
}

function expectOmittedDraftIsNull(description: unknown): void {
  expectDescriptionMatches(description, '省略時のdraftPrがnullで返る説明',
    /\b(?:draftPr\s*\(\s*null\s+when\s+omitted\b|(?:the\s+success\s+result|a\s+successful\s+reply)\s+(?:echoes|returns)\s+the\s+saved\s+value,\s+or\s+null\s+when\s+omitted\b|(?:an\s+)?omitted\s+draftPr\s+is\s+null\b)/i);
  expect(description, '省略時nullを否定する矛盾がない説明').not.toMatch(
    /\b(?:draftPr\s+is\s+(?:not|never)\s+null\s+when\s+omitted|(?:an\s+)?omitted\s+draftPr\s+is\s+(?:not|never)\s+null)\b/i);
}

function expectEnqueueDescription(description: unknown): void {
  expectDraftPriorityAndInheritance(description, 'draftPr');
  for (const field of ['worktree', 'autoPr', 'draftPr']) {
    expectDescriptionMatches(description, `成功結果が保存済み${field}を返す説明`,
      new RegExp(String.raw`\b(?:success|successful replies)\s+returns?\s+(?:the\s+)?saved\s+[^.;()]*\b${field}\b`, 'i'));
  }
  expectOmittedDraftIsNull(description);
}

function expectDraftSchemaDescription(description: unknown): void {
  for (const value of ['true', 'false']) {
    expectDescriptionMatches(description, `明示した${value}を保存する説明`,
      new RegExp(String.raw`\bexplicit\s+(?=[^.;]*\b${value}\b)(?:true|false)(?:\s+or\s+(?:true|false))?\s+is\s+saved\b`, 'i'));
  }
  expectDraftPriorityAndInheritance(description, String.raw`(?:true\s+or\s+false|false\s+or\s+true)`);
  expectDescriptionMatches(description, '省略時にdraft_prを保存しない説明',
    /\b(?:omission\s+saves\s+no\s+draft_pr\s+value|when omitted,?\s+no\s+draft_pr\s+is\s+saved)\b/i);
  expectDescriptionMatches(description, '成功結果が保存値を返す説明',
    /\b(?:the\s+success\s+result|a\s+successful\s+reply)\s+(?:echoes|returns)\s+the\s+saved\s+value\b/i);
  expectOmittedDraftIsNull(description);
}

function expectListDescription(description: unknown): void {
  const basicInformation = String.raw`(?:available\s+basic\s+information|obtainable\s+summary\s+data)`;
  expectFailureSources(description, 'worktreeとrunの個別失敗で該当タスクの基本情報とerrorを返す説明',
    new RegExp(String.raw`(?:^|[.;]\s*)(?:individual|a)\s+((?:worktree|run)(?:\s+or\s+(?:worktree|run))?)\s+(?:failures?|problem)\s+(?:returns?\s+that\s+task's\s+${basicInformation}\s+with\s+an\s+error|adds?\s+an\s+error\s+to\s+the\s+affected\s+task's\s+${basicInformation})\s*(?:while\s+preserving\s+the\s+other\s+tasks\s*)?(?:[.;]|$)`, 'i'),
    ['worktree', 'run']);
  expectDescriptionMatches(description, '他のタスクを保持する説明',
    /(?:\bwhile\s+preserving\s+the\s+other\s+tasks|(?:^|[.;]\s*)unaffected\s+tasks\s+are\s+returned\s+unchanged)\s*(?:[.;]|$)/i);
  expect(description, '他のタスクを保持する条件を否定する矛盾がない説明').not.toMatch(
    /\b(?:preserving\s+the\s+other\s+tasks\s+is\s+(?:not|never)\s+guaranteed|unaffected\s+tasks\s+are\s+(?:not|never)\s+returned\s+unchanged)\b/i);
  expectDescriptionMatches(description, '不正なworktree参照先を読まない説明',
    /\b(?:invalid|untrusted)\s+worktree\s+references\s+are\s+(?:not\s+read|never\s+accessed)\b/i);
  expectFailureSources(description, 'queueとcwdのアクセス失敗が呼び出し全体のエラーになる説明',
    /(?:^|[.;]\s*)(?:an?\s+)?((?:unreadable\s+)?queue(?:\s+or\s+(?:unauthorized\s+)?cwd)?|(?:unauthorized\s+)?cwd(?:\s+or\s+(?:unreadable\s+)?queue)?)\s+(?:access\s+failures\s+remain\s+whole-tool\s+errors|makes\s+the\s+entire\s+call\s+fail)\s*(?:[.;]|$)/i,
    ['queue', 'cwd']);
  expect(description, 'worktreeとrunの失敗を全体エラーにする矛盾がない説明').not.toMatch(
    /\b(?:worktree|run)(?:\s+or\s+(?:worktree|run))?\s+(?:failures?|problem)\s+(?:makes?\s+the\s+entire\s+call\s+fail|remain\s+whole-tool\s+errors)\b/i);
  expect(description, 'queueとcwdの失敗を個別エラーにする矛盾がない説明').not.toMatch(
    /\b(?:unreadable\s+queue|unauthorized\s+cwd)(?:\s+(?:access\s+)?failures?)?\s+adds?\s+an\s+error\s+to\s+(?:the\s+affected|that)\s+task\b/i);
}

describe('MCP public description assertions', () => {
  const enqueue = 'Explicit draftPr takes priority over project and global settings. When omitted, configuration settings apply. Successful replies return saved worktree, autoPr and draftPr; an omitted draftPr is null.';
  const schema = 'An explicit true or false is saved as draft_pr and takes priority over project and global settings. When omitted, no draft_pr is saved and configuration settings apply. A successful reply returns the saved value, or null when omitted.';
  const list = "A worktree or run problem adds an error to the affected task's obtainable summary data. Unaffected tasks are returned unchanged. Untrusted worktree references are never accessed. An unreadable queue or unauthorized cwd makes the entire call fail.";

  it('accepts equivalent enqueue, draftPr schema, and list descriptions', () => {
    expectEnqueueDescription(enqueue);
    expectDraftSchemaDescription(schema);
    expectListDescription(list);
  });

  it.each([
    ['priority assigned to autoPr', enqueue.replace('Explicit draftPr', 'Explicit autoPr')],
    ['negated priority', enqueue.replace('takes priority over', 'never overrides')],
    ['inheritance assigned to autoPr', enqueue.replace('When omitted', 'When autoPr is omitted')],
  ])('rejects an enqueue description with %s', (_name, description) => {
    expect(() => expectEnqueueDescription(description)).toThrow();
  });

  it.each([
    ['replaced', enqueue.replace('an omitted draftPr is null', 'draftPr is not null when omitted')],
    ['appended', enqueue + ' draftPr is not null when omitted.'],
  ])('rejects %s omitted-null denial in an enqueue description', (_name, description) => {
    expectEnqueueDescription(enqueue);
    expect(() => expectEnqueueDescription(description)).toThrow(/省略時/);
  });

  it.each([
    ['replaced', schema.replace('or null when omitted', 'draftPr is not null when omitted')],
    ['appended', schema + ' draftPr is not null when omitted.'],
  ])('rejects %s omitted-null denial in a draftPr schema description', (_name, description) => {
    expectDraftSchemaDescription(schema);
    expect(() => expectDraftSchemaDescription(description)).toThrow(/省略時/);
  });

  it.each([
    ['priority', 'Explicit draftPr does not override project and global settings.', '明示値の設定優先'],
    ['inheritance', 'When draftPr is omitted, configuration settings do not apply.', '省略時の設定継承'],
  ])('rejects appended %s denial in an enqueue description', (_name, contradiction, requirement) => {
    expectEnqueueDescription(enqueue);
    expect(() => expectEnqueueDescription(enqueue + ' ' + contradiction)).toThrow(requirement);
  });

  it.each([
    ['priority', 'Explicit draftPr does not override project and global settings.', '明示値の設定優先'],
    ['inheritance', 'When draftPr is omitted, configuration settings do not apply.', '省略時の設定継承'],
  ])('rejects appended %s denial in a draftPr schema description', (_name, contradiction, requirement) => {
    expectDraftSchemaDescription(schema);
    expect(() => expectDraftSchemaDescription(schema + ' ' + contradiction)).toThrow(requirement);
  });

  it.each([
    ['priority assigned to autoPr', schema.replace('An explicit true or false', 'An explicit autoPr true or false')],
    ['negated priority', schema.replace('takes priority over', 'never overrides')],
    ['inheritance assigned to autoPr', schema.replace('When omitted', 'When autoPr is omitted')],
  ])('rejects a draftPr schema description with %s', (_name, description) => {
    expect(() => expectDraftSchemaDescription(description)).toThrow();
  });

  it.each([
    ['negated preservation', list.replace('Unaffected tasks are returned unchanged.', 'Preserving the other tasks is not guaranteed.')],
    ['run failures aborting the entire call', list.replace('worktree or run problem', 'worktree problem').replace('summary data.', 'summary data, but run failures make the entire call fail.')],
    ['cwd failure assigned to a task', list.replace('queue or unauthorized cwd makes the entire call fail.', 'queue makes the entire call fail, but an unauthorized cwd adds an error to that task.')],
  ])('rejects a list description with %s', (_name, description) => {
    expect(() => expectListDescription(description)).toThrow();
  });

  it.each([
    ['preservation guarantee', 'Preserving the other tasks is not guaranteed.'],
    ['unchanged unaffected tasks', 'Unaffected tasks are not returned unchanged.'],
  ])('rejects appended %s denial in a list description', (_name, contradiction) => {
    expectListDescription(list);
    expect(() => expectListDescription(list + ' ' + contradiction)).toThrow(/他のタスクを保持/);
  });

  it.each([
    ['worktree', 'Worktree failures make the entire call fail.', 'worktreeとrun'],
    ['run', 'Run failures make the entire call fail.', 'worktreeとrun'],
    ['queue', 'An unreadable queue adds an error to the affected task.', 'queueとcwd'],
    ['cwd', 'An unauthorized cwd adds an error to the affected task.', 'queueとcwd'],
  ])('rejects appended %s failure-scope contradiction in a list description', (_name, contradiction, requirement) => {
    expectListDescription(list);
    expect(() => expectListDescription(list + ' ' + contradiction)).toThrow(requirement);
  });
});

describe('MCP package entrypoint', () => {
  it('advertises the inquiry input contract and retrieval fields through listTools', async () => {
    const server = createTaktMcpServer();
    const client = new Client({ name: 'inquiry-tools', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const ask = tools.find(({ name }) => name === 'takt_ask_goal_question')!;
      expect(ask.inputSchema.properties?.kind).toMatchObject({ enum: ['question', 'operation_request'], default: 'question' });
      expect(ask.inputSchema.properties?.targetSha).toMatchObject({ type: 'string' });
      expect(ask.inputSchema.required).not.toContain('kind');
      expect(ask.description).toMatch(/question.*default|default.*question/iu);
      expect(ask.description).toMatch(/operation_request/u);
      expect(ask.description).toMatch(/approval.*(cannot|reject|not|judg)|(?:cannot|reject|not).*approval/iu);
      expect(ask.description).toMatch(/targetSha/u);
      const withdraw = tools.find(({ name }) => name === 'takt_withdraw_goal_question')!;
      expect(withdraw.inputSchema.properties?.reason).toMatchObject({ type: 'string' });
      expect(withdraw.inputSchema.required).not.toContain('reason');
      expect(withdraw.description).toMatch(/reason/iu);
      for (const name of ['takt_get_goal_question', 'takt_list_goal_questions']) {
        const description = tools.find((tool) => tool.name === name)!.description;
        expect(description, name).toMatch(/kind|question.*approval.*operation/iu);
        expect(description, name).toMatch(/decision/iu);
        expect(description, name).toMatch(/report/iu);
        expect(description, name).toMatch(/scope/iu);
        expect(description, name).toMatch(/withdraw/iu);
        expect(description, name).toMatch(/consum/iu);
      }
    } finally { await client.close(); await server.close(); }
  });

  it('saves an operation request through MCP and retrieves its target and complete withdrawal reason', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-inquiry-'));
    const store = new GoalStore(cwd);
    const goal = await store.create(goalRecord());
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'inquiry-roundtrip', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: { cwd, goalId: goal.id, ...args } });
        expect(result.isError, firstTextContent(result.content)).toBeUndefined();
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
        return JSON.parse(firstTextContent(result.content));
      };
      const input = { kind: 'operation_request', body: '認証を更新してください', targetSha: 'a'.repeat(40) };
      const { questionId } = await call('takt_ask_goal_question', input);
      expect((await call('takt_get_goal_question', { questionId })).question).toMatchObject({ ...input, id: questionId, status: 'pending' });
      const reason = '  別の方法で解決しました\n' + '理由'.repeat(12000);
      const before = Date.now();
      await call('takt_withdraw_goal_question', { questionId, reason });
      const saved = (await new GoalStore(cwd).get(goal.id)).questions!.find((question) => question.id === questionId)!;
      expect(saved).toMatchObject({ ...input, status: 'withdrawn', withdrawalReason: reason });
      expect(Date.parse(saved.withdrawnAt!)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(saved.withdrawnAt!)).toBeLessThanOrEqual(Date.now());
      let restored = '';
      let offset = 0;
      for (;;) {
        const page = await call('takt_get_goal_question', { questionId, path: 'withdrawalReason', textOffset: offset, maxBytes: 4096 });
        restored += page.content;
        if (page.nextOffset === null) break;
        expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset;
      }
      expect(restored).toBe(reason);
    } finally {
      await client.close(); await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('declares the stdio binary and official MCP SDK', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(packageJson.bin?.['takt-mcp']).toBe('./dist/app/mcp/index.js');
    expect(packageJson.dependencies?.['@modelcontextprotocol/sdk']).toEqual(expect.any(String));
  });

  it('exports the stdio connector', async () => {
    const entrypoint = await import('../app/mcp/index.js') as {
      connectTaktMcpServerToStdio?: unknown;
    };
    expect(entrypoint.connectTaktMcpServerToStdio).toEqual(expect.any(Function));
  });

  it('exposes task enqueue, read, and tell tools with their public schemas', async () => {
    const server = createTaktMcpServer();
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'takt_enqueue_task',
        'takt_list_tasks',
        'takt_get_run',
        'takt_tell_run',
        'takt_list_goals',
        'takt_get_goal',
      ]));
      for (const name of ['takt_requeue_goal_task', 'takt_retry_goal_task', 'takt_remove_goal_task', 'takt_enqueue_task', 'takt_tell_run']) {
        const description = tools.tools.find((tool) => tool.name === name)!.description;
        expect(description, name).toContain('64 KiB');
        expect(description, name).toContain('truncation');
        expect(description, name).toContain('takt_list_tasks offset/limit');
        if (name === 'takt_tell_run') {
          for (const selector of ['takt_get_run', 'runSlug', 'view instructions', 'instructionId', 'offset/limit', 'offset/maxBytes', 'nextOffset']) {
            expect(description).toContain(selector);
          }
        } else if (name !== 'takt_enqueue_task') {
          for (const selector of ['takt_list_goal_work_log offset/limit', 'takt_get_goal path workLog.summary', 'recordId', 'textOffset/maxBytes']) {
            expect(description, name).toContain(selector);
          }
        }
      }
      const getRunDescription = tools.tools.find((tool) => tool.name === 'takt_get_run')!.description;
      for (const selector of ['64 KiB', 'truncation', 'view instructions', 'instructionId', 'offset/limit', 'offset/maxBytes', 'nextOffset']) {
        expect(getRunDescription).toContain(selector);
      }
      const enqueueTool = tools.tools.find((tool) => tool.name === 'takt_enqueue_task');
      expect(enqueueTool).toEqual(expect.objectContaining({
        title: 'Enqueue TAKT task',
        inputSchema: expect.objectContaining({
          type: 'object',
          required: expect.arrayContaining(['cwd', 'task', 'workflow', 'autoPr']),
          properties: expect.objectContaining({
            issue: expect.any(Object),
            draftPr: expect.objectContaining({ type: 'boolean' }),
          }),
        }),
      }));
      expectEnqueueDescription(enqueueTool?.description);
      const enqueueSchema = enqueueTool?.inputSchema;
      expect(enqueueSchema?.required).not.toContain('draftPr');
      expect(enqueueSchema?.properties?.draftPr).not.toHaveProperty('default');
      const draftPrSchema = enqueueSchema?.properties?.draftPr as { description?: unknown } | undefined;
      expectDraftSchemaDescription(draftPrSchema?.description);
      const listTool = tools.tools.find((tool) => tool.name === 'takt_list_tasks');
      expect(listTool).toEqual(expect.objectContaining({
        inputSchema: expect.objectContaining({
          type: 'object',
          required: expect.arrayContaining(['cwd']),
          properties: expect.objectContaining({ cwd: expect.any(Object) }),
        }),
      }));
      expectListDescription(listTool?.description);
      for (const contradiction of [
        'Preserving the other tasks is not guaranteed.',
        'Unaffected tasks are not returned unchanged.',
      ]) {
        expect(() => expectListDescription(listTool?.description + ' ' + contradiction))
          .toThrow(/他のタスクを保持/);
      }
      expect(tools.tools.find((tool) => tool.name === 'takt_get_run')).toEqual(expect.objectContaining({
        inputSchema: expect.objectContaining({
          type: 'object',
          required: expect.arrayContaining(['cwd', 'runSlug']),
          properties: expect.objectContaining({
            cwd: expect.any(Object),
            runSlug: expect.any(Object),
          }),
        }),
      }));
      expect(tools.tools.find((tool) => tool.name === 'takt_tell_run')).toEqual(expect.objectContaining({
        inputSchema: expect.objectContaining({
          type: 'object',
          required: expect.arrayContaining(['cwd', 'runSlug', 'content']),
          properties: expect.objectContaining({
            cwd: expect.any(Object),
            runSlug: expect.any(Object),
            content: expect.any(Object),
          }),
        }),
      }));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(['manager', 'all', 'read-only'] as const)('exposes reopening with a required reason only to writable %s tools', async (toolSet) => {
    const server = createTaktMcpServer({}, { toolSet });
    const client = new Client({ name: 'takt-mcp-reopen-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tool = (await client.listTools()).tools.find(({ name }) => name === 'takt_reopen_goal');
      if (toolSet === 'read-only') {
        expect(tool).toBeUndefined();
      } else {
        expect(tool?.inputSchema.required?.slice().sort()).toEqual(['cwd', 'goalId', 'reason']);
        expect(Object.keys(tool!.inputSchema.properties!).sort()).toEqual(['cwd', 'goalId', 'reason']);
        expect(tool?.inputSchema.properties?.reason).toMatchObject({ type: 'string', maxLength: 128 * 1024 });
        for (const selector of ['64 KiB', 'truncation', 'takt_get_goal', 'workLog.summary', 'recordId', 'textOffset/maxBytes']) {
          expect(tool?.description).toContain(selector);
        }
      }
    } finally {
      await client.close(); await server.close();
    }
  });

  it.each(['manager', 'all', 'read-only', undefined] as const)('exposes the appropriate tell schema for tool set %s', async (toolSet) => {
    const server = createTaktMcpServer({}, { toolSet });
    const client = new Client({ name: 'tell-schema-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = (await client.listTools()).tools.filter(({ name }) => name === 'takt_tell_run');
      if (toolSet === 'read-only') {
        expect(tools).toEqual([]);
        return;
      }
      expect(tools).toHaveLength(1);
      const tool = tools[0]!;
      const fields = toolSet === 'manager' ? ['content', 'cwd', 'goalId', 'taskName'] : ['content', 'cwd', 'runSlug'];
      expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual(fields);
      expect(tool.inputSchema.required?.slice().sort()).toEqual(fields);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const selector of ['Responses fit 64 KiB, with explicit truncation', 'takt_get_run', 'runSlug', 'view instructions', 'instructionId', 'offset/maxBytes']) {
        expect(tool.description).toContain(selector);
      }
      if (toolSet === 'manager') {
        vi.mocked(ensureManagerRun).mockClear();
        const result = await client.callTool({ name: 'takt_tell_run', arguments: {
          cwd: process.cwd(), goalId: goalRecord().id, taskName: 'task', content: 'instruction', runSlug: 'arbitrary-run',
        } });
        expect(result.isError).toBe(true);
        expect(ensureManagerRun).not.toHaveBeenCalled();
      }
    } finally { await client.close(); await server.close(); }
  });

  it('can register the same server with read-only task-state tools', async () => {
    const server = createTaktMcpServer({}, { toolSet: 'read-only' });
    const client = new Client({ name: 'takt-mcp-read-only-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'takt_get_goal',
        'takt_get_run',
        'takt_list_goals',
        'takt_list_tasks',
      ]);
      const enqueueResult = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: { cwd: process.cwd(), task: 'must not enqueue', workflow: 'default', autoPr: false },
      });
      expect(enqueueResult.isError).toBe(true);
      expect(firstTextContent(enqueueResult.content)).toContain('Tool takt_enqueue_task not found');
      const tellResult = await client.callTool({
        name: 'takt_tell_run',
        arguments: { cwd: process.cwd(), runSlug: 'must-not-tell', content: 'must not tell' },
      });
      expect(tellResult.isError).toBe(true);
      expect(firstTextContent(tellResult.content)).toContain('Tool takt_tell_run not found');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(['all', 'read-only'] as const)('describes goal and task project paths separately in the %s tool set', async (toolSet) => {
    const server = createTaktMcpServer({}, { toolSet });
    const client = new Client({ name: 'takt-mcp-path-description-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const { tools } = await client.listTools();

      for (const name of ['takt_list_goals', 'takt_get_goal']) {
        const tool = tools.find((candidate) => candidate.name === name);
        const cwdSchema = tool?.inputSchema.properties?.cwd as { description?: unknown } | undefined;
        expectDescriptionMatches(cwdSchema?.description, `${name}: プロジェクトの絶対パスを説明する`,
          /absolute\s+path\s+to\s+the\s+TAKT\s+project/i);
        expectDescriptionMatches(cwdSchema?.description, `${name}: ゴール保存先を説明する`,
          /goals\s+are\s+stored\s+in\s+\.takt\/goals\//i);
      }

      const taskToolNames = toolSet === 'all'
        ? ['takt_enqueue_task', 'takt_list_tasks', 'takt_get_run', 'takt_tell_run']
        : ['takt_list_tasks', 'takt_get_run'];
      for (const name of taskToolNames) {
        const tool = tools.find((candidate) => candidate.name === name);
        const cwdSchema = tool?.inputSchema.properties?.cwd as { description?: unknown } | undefined;
        expectDescriptionMatches(cwdSchema?.description, `${name}: プロジェクトの絶対パスを説明する`,
          /absolute\s+path\s+to\s+the\s+TAKT\s+project/i);
        expectDescriptionMatches(cwdSchema?.description, `${name}: タスク保存先の読み書きを説明する`,
          /\.takt\/tasks\.yaml\s+is\s+read\s+or\s+written/i);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns a summary without report contents and returns selected run details', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-state-'));
    const cloneCwd = join(cwd, '.takt', 'worktrees', 'authentication');
    const runSlug = 'auth-run';
    const reportMarker = 'REPORT_ONLY_IN_DETAILS';
    const runDir = join(cloneCwd, '.takt', 'runs', runSlug);
    mkdirSync(join(runDir, 'logs'), { recursive: true });
    mkdirSync(join(runDir, 'reports'), { recursive: true });
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
      task: 'Implement authentication',
      workflow: 'review-fix',
      runSlug,
      runRoot: `.takt/runs/${runSlug}`,
      reportDirectory: `.takt/runs/${runSlug}/reports`,
      contextDirectory: `.takt/runs/${runSlug}/context`,
      logsDirectory: `.takt/runs/${runSlug}/logs`,
      status: 'running',
      startTime: '2026-09-09T00:00:00.000Z',
      currentStep: 'implement',
      currentIteration: 2,
      phase: 2,
    }), 'utf-8');
    writeFileSync(join(runDir, 'logs', 'session-001.jsonl'), [
      JSON.stringify({
        type: 'workflow_start',
        task: 'Implement authentication',
        workflowName: 'review-fix',
        startTime: '2026-09-09T00:00:00.000Z',
      }),
      JSON.stringify({
        type: 'step_complete',
        step: 'plan',
        persona: 'planner',
        iteration: 1,
        status: 'done',
        content: 'Plan is ready',
        instruction: 'Create a plan',
        timestamp: '2026-09-09T00:01:00.000Z',
      }),
      JSON.stringify({
        type: 'step_start', step: 'implement', persona: 'coder', iteration: 2,
        timestamp: '2026-09-09T00:02:00.000Z',
      }),
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(runDir, 'reports', '00-progress.md'), reportMarker, 'utf-8');
    mkdirSync(join(cwd, '.takt', 'runs', runSlug), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'runs', runSlug, 'interventions.jsonl'), `${JSON.stringify({
      type: 'issued',
      instructionId: 1,
      issuedAt: '2026-09-09T00:02:00.000Z',
      content: 'Keep the existing session flow.',
    })}\n`, 'utf-8');
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'authentication',
        status: 'running',
        content_file: '/definitely-not-readable/task-spec.md',
        summary: 'Add login and session handling',
        workflow: 'review-fix',
        worktree: true,
        auto_pr: false,
        created_at: '2026-09-09T00:00:00.000Z',
        started_at: '2026-09-09T00:00:00.000Z',
        completed_at: null,
        run_slug: runSlug,
        worktree_path: cloneCwd,
      }],
    }), 'utf-8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-state-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listResult = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect(listResult.isError).toBeUndefined();
      const listPayload = JSON.parse(firstTextContent(listResult.content)) as {
        tasks: Array<Record<string, unknown>>;
      };
      const listedTask = listPayload.tasks.find((task) => task.name === 'authentication');
      expect(listedTask).toEqual(expect.objectContaining({
        name: 'authentication',
        summary: 'Add login and session handling',
        status: 'running',
        workflow: 'review-fix',
        currentStep: 'implement',
      }));
      expect(listedTask).not.toHaveProperty('stepLogs');
      expect(listedTask).not.toHaveProperty('reports');
      expect(firstTextContent(listResult.content)).not.toContain(reportMarker);

      const getResult = await client.callTool({
        name: 'takt_get_run',
        arguments: { cwd, runSlug },
      });
      expect(getResult.isError).toBeUndefined();
      const getPayload = JSON.parse(firstTextContent(getResult.content)) as Record<string, unknown>;
      expect(getPayload).toEqual(expect.objectContaining({
        runSlug,
        currentStep: 'implement',
        currentIteration: 2,
        currentStepStartedAt: '2026-09-09T00:02:00.000Z',
        currentStepExecutionCount: 1,
        phase: 2,
        stepLogs: expect.arrayContaining([
          expect.objectContaining({ step: 'plan', persona: 'planner', status: 'done', iteration: 1, timestamp: '2026-09-09T00:01:00.000Z' }),
        ]),
        reports: expect.arrayContaining([
          expect.objectContaining({ filename: '00-progress.md', sizeBytes: Buffer.byteLength(reportMarker) }),
        ]),
        liveIntervention: expect.objectContaining({
          issuedTotal: 1,
          pending: 1,
          instructions: expect.arrayContaining([
            expect.objectContaining({
              instructionId: 1,
              content: 'Keep the existing session flow.',
              state: 'pending',
            }),
          ]),
        }),
      }));

      rmSync(join(runDir, 'meta.json'));
      const deletedRun = await client.callTool({
        name: 'takt_get_run',
        arguments: { cwd, runSlug },
      });
      expect(deletedRun.isError).toBe(true);
      expect(firstTextContent(deletedRun.content)).toContain('Run read failed');

      const afterDeletedRun = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect(afterDeletedRun.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(afterDeletedRun.content))).toEqual(expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({ name: 'authentication', runSlug }),
        ]),
      }));
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns an individual error for a task outside the project clone boundary without reading its run', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-boundary-'));
    const externalCwd = mkdtempSync(join(cwd, '..', 'takt-mcp-external-'));
    const runSlug = 'external-run';
    const runDir = join(externalCwd, '.takt', 'runs', runSlug);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
      task: 'External task',
      workflow: 'external-workflow',
      runSlug,
      runRoot: `.takt/runs/${runSlug}`,
      status: 'running',
      currentStep: 'external-step',
      startTime: '2026-09-09T00:00:00.000Z',
    }), 'utf-8');
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'untrusted-task',
        status: 'running',
        content: 'Task with an untrusted worktree path',
        workflow: 'project-workflow',
        worktree: true,
        auto_pr: false,
        created_at: '2026-09-09T00:00:00.000Z',
        started_at: '2026-09-09T00:00:00.000Z',
        completed_at: null,
        run_slug: runSlug,
        worktree_path: externalCwd,
      }],
    }), 'utf-8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-boundary-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      readRunMetaBySlugMock.mockClear();
      const result = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect.soft(readRunMetaBySlugMock).not.toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(result.content))).toMatchObject({
        tasks: [{
          name: 'untrusted-task',
          summary: 'Task with an untrusted worktree path',
          status: 'running',
          startedAt: '2026-09-09T00:00:00.000Z',
          workflow: 'project-workflow',
          runSlug,
          error: expect.stringMatching(/\S/),
        }],
      });
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(externalCwd, { recursive: true, force: true });
    }
  });

  it('isolates an unowned clone in a three-task list and still rejects get and tell', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-owner-project-'));
    const otherProject = mkdtempSync(join(tmpdir(), 'takt-mcp-owner-other-'));
    const cloneBase = resolveCloneBaseDir(cwd);
    mkdirSync(cloneBase, { recursive: true });
    const sharedRoot = mkdtempSync(join(cloneBase, 'takt-mcp-owner-shared-'));
    const ownedClone = join(sharedRoot, 'owned');
    const unownedClone = join(sharedRoot, 'unowned');
    const ownedSlug = 'owned-run';
    const unownedSlug = 'unowned-run';
    const ownedBranch = 'takt/owned';
    const unownedBranch = 'takt/unowned';
    mkdirSync(ownedClone, { recursive: true });
    mkdirSync(unownedClone, { recursive: true });
    writeRunFixture(ownedClone, ownedSlug, 'owned-step', 'OWNED_REPORT');
    writeRunFixture(cwd, ownedSlug, 'project-step');
    const projectMetaPath = join(cwd, '.takt', 'runs', ownedSlug, 'meta.json');
    writeFileSync(projectMetaPath, JSON.stringify({ ...JSON.parse(readFileSync(projectMetaPath, 'utf8')), task: 'Project task' }));
    writeRunFixture(unownedClone, unownedSlug, 'unowned-step', 'UNOWNED_REPORT_SECRET');
    writeCloneOwnershipMetadata(cwd, ownedBranch, ownedClone);
    // The same metadata in another project must not grant project A access.
    writeCloneOwnershipMetadata(otherProject, unownedBranch, unownedClone);
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [
        {
          name: 'owned-task',
          status: 'running',
          content: 'Owned task',
          workflow: 'default',
          worktree: true,
          auto_pr: false,
          branch: ownedBranch,
          created_at: '2026-09-09T00:00:00.000Z',
          started_at: '2026-09-09T00:00:00.000Z',
          completed_at: null,
          run_slug: ownedSlug,
          worktree_path: ownedClone,
        },
        {
          name: 'unowned-task',
          status: 'running',
          content: 'Unowned task',
          workflow: 'default',
          worktree: true,
          auto_pr: false,
          branch: unownedBranch,
          created_at: '2026-09-09T00:00:00.000Z',
          started_at: '2026-09-09T00:00:00.000Z',
          completed_at: null,
          run_slug: unownedSlug,
          worktree_path: unownedClone,
        },
        {
          name: 'pending-task',
          status: 'pending',
          content: 'Pending task',
          summary: 'Pending summary',
          workflow: 'default',
          worktree: true,
          auto_pr: false,
          created_at: '2026-09-09T00:00:00.000Z',
          started_at: null,
          completed_at: null,
        },
      ],
    }), 'utf-8');
    const unownedInterventionPath = join(cwd, '.takt', 'runs', unownedSlug, 'interventions.jsonl');
    mkdirSync(join(cwd, '.takt', 'runs', unownedSlug), { recursive: true });
    const unchangedIntervention = `${JSON.stringify({
      type: 'issued',
      instructionId: 1,
      issuedAt: '2026-09-09T00:00:00.000Z',
      content: 'original',
    })}\n`;
    writeFileSync(unownedInterventionPath, unchangedIntervention, 'utf-8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-owner-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      readRunMetaBySlugMock.mockClear();
      const listed = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect.soft(readRunMetaBySlugMock.mock.calls.map(([runCwd, slug]) => [runCwd, slug]))
        .toEqual([[ownedClone, ownedSlug]]);
      expect(listed.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(listed.content))).toMatchObject({
        tasks: [
          { name: 'owned-task', summary: 'Owned task', status: 'running', startedAt: '2026-09-09T00:00:00.000Z', workflow: 'default', runSlug: ownedSlug, currentStep: 'owned-step' },
          { name: 'unowned-task', summary: 'Unowned task', status: 'running', startedAt: '2026-09-09T00:00:00.000Z', workflow: 'default', runSlug: unownedSlug, error: expect.stringMatching(/\S/) },
          { name: 'pending-task', summary: 'Pending summary', status: 'pending', workflow: 'default' },
        ],
      });

      const owned = await client.callTool({
        name: 'takt_get_run',
        arguments: { cwd, runSlug: ownedSlug, view: 'report', report: '00-progress.md' },
      });
      expect(owned.isError).toBeUndefined();
      expect(firstTextContent(owned.content)).toContain('OWNED_REPORT');
      const ownedTask = await client.callTool({ name: 'takt_get_run', arguments: { cwd, runSlug: ownedSlug, view: 'task' } });
      expect(ownedTask.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(ownedTask.content)).task).toMatchObject({ content: ownedSlug, nextOffset: null });
      readRunMetaBySlugMock.mockClear();
      const unownedTask = await client.callTool({ name: 'takt_get_run', arguments: { cwd, runSlug: unownedSlug, view: 'task' } });
      expect(unownedTask.isError).toBe(true);
      expect(readRunMetaBySlugMock).not.toHaveBeenCalled();

      const unowned = await client.callTool({
        name: 'takt_get_run',
        arguments: { cwd, runSlug: unownedSlug },
      });
      expect(unowned.isError).toBe(true);
      expect(firstTextContent(unowned.content)).not.toContain('UNOWNED_REPORT_SECRET');
      expect(firstTextContent(unowned.content)).not.toContain('unowned-step');

      const ownedTell = await client.callTool({
        name: 'takt_tell_run',
        arguments: { cwd, runSlug: ownedSlug, content: 'update the owned task' },
      });
      expect(ownedTell.isError).toBeUndefined();
      expect(readFileSync(join(cwd, '.takt', 'runs', ownedSlug, 'interventions.jsonl'), 'utf-8'))
        .toContain('update the owned task');

      const unownedTell = await client.callTool({
        name: 'takt_tell_run',
        arguments: { cwd, runSlug: unownedSlug, content: 'must not be written' },
      });
      expect(unownedTell.isError).toBe(true);
      expect(readFileSync(unownedInterventionPath, 'utf-8')).toBe(unchangedIntervention);
      expect(existsSync(join(unownedClone, '.takt', 'runs', unownedSlug, 'interventions.jsonl'))).toBe(false);
      const page = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd, limit: 1, offset: 2 } });
      expect(page.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(page.content))).toMatchObject({ tasks: [{ name: 'pending-task' }], totalCount: 3, returnedCount: 1, offset: 2, nextOffset: null, truncated: true });
    } finally {
      await client.close();
      await server.close();
      rmSync(sharedRoot, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it.each([
    { failure: 'invalid JSON', content: '{' },
    { failure: 'invalid metadata shape', content: JSON.stringify({ status: 'running' }) },
    { failure: 'mismatched run slug', content: 'mismatched' },
    { failure: 'missing metadata', content: undefined },
  ])('isolates $failure and preserves the other task summaries through MCP', async ({ content }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-meta-error-'));
    const cloneCwd = join(cwd, '.takt', 'worktrees', 'broken');
    const healthySlug = 'healthy-run';
    const brokenSlug = 'broken-run';
    writeRunFixture(cwd, healthySlug, 'implement');
    const { runDir } = writeRunFixture(cloneCwd, brokenSlug, 'must-not-be-returned');
    const metaPath = join(runDir, 'meta.json');
    if (content === undefined) {
      rmSync(metaPath);
    } else if (content === 'mismatched') {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(metaPath, JSON.stringify({ ...meta, runSlug: 'another-run' }), 'utf8');
    } else {
      writeFileSync(metaPath, content, 'utf8');
    }
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [
        { name: 'healthy', status: 'running', run_slug: healthySlug },
        { name: 'broken', status: 'running', run_slug: brokenSlug, worktree_path: cloneCwd, workflow: 'saved-workflow' },
        { name: 'pending', status: 'pending', workflow: 'default' },
      ].map((task) => ({
        content_file: '/definitely-not-readable/task.md',
        summary: `${task.name} summary`,
        created_at: '2026-09-09T00:00:00.000Z',
        started_at: task.status === 'running' ? '2026-09-09T00:00:00.000Z' : null,
        completed_at: null,
        ...task,
      })),
    }), 'utf8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd, toolSet: 'read-only' });
    const client = new Client({ name: 'takt-mcp-meta-error-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd } });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(result.content))).toMatchObject({
        tasks: [
          { name: 'healthy', summary: 'healthy summary', status: 'running', startedAt: '2026-09-09T00:00:00.000Z', workflow: 'default', runSlug: healthySlug, currentStep: 'implement' },
          { name: 'broken', summary: 'broken summary', status: 'running', startedAt: '2026-09-09T00:00:00.000Z', workflow: 'saved-workflow', runSlug: brokenSlug, error: expect.stringMatching(/\S/) },
          { name: 'pending', summary: 'pending summary', status: 'pending', workflow: 'default' },
        ],
      });
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(['unreadable queue', 'cwd outside the allowed root'] as const)(
    'returns a whole-tool error for %s without returning a task array', async (failure) => {
      const root = mkdtempSync(join(tmpdir(), 'takt-mcp-whole-error-'));
      const allowedRoot = join(root, 'allowed');
      const outsideRoot = join(root, 'outside');
      mkdirSync(join(allowedRoot, '.takt'), { recursive: true });
      mkdirSync(outsideRoot);
      writeFileSync(join(allowedRoot, '.takt', 'tasks.yaml'), 'tasks: [', 'utf8');
      const server = createTaktMcpServer({}, { allowedProjectRoot: allowedRoot });
      const client = new Client({ name: 'takt-mcp-whole-error-client', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        readRunMetaBySlugMock.mockClear();

        const result = await client.callTool({
          name: 'takt_list_tasks',
          arguments: { cwd: failure === 'unreadable queue' ? allowedRoot : outsideRoot },
        });

        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty('structuredContent.tasks');
        expect(firstTextContent(result.content)).toMatch(/^Task list failed: /);
        expect(() => JSON.parse(firstTextContent(result.content))).toThrow();
        expect(readRunMetaBySlugMock).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('does not resolve an external content_file for MCP list or tell when summary is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-summary-project-'));
    const contentRoot = mkdtempSync(join(tmpdir(), 'takt-mcp-summary-content-'));
    const contentPath = join(contentRoot, 'secret-task.md');
    const cloneCwd = join(cwd, '.takt', 'worktrees', 'active');
    const runSlug = 'summary-run';
    const secret = 'EXTERNAL_CONTENT_SECRET';
    writeFileSync(contentPath, `${secret}\nprivate details`, 'utf-8');
    mkdirSync(cloneCwd, { recursive: true });
    writeRunFixture(cloneCwd, runSlug, 'implement');
    mkdirSync(join(cwd, '.takt', 'runs', runSlug), { recursive: true });
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'summary-less-task',
        status: 'running',
        content_file: contentPath,
        workflow: 'default',
        worktree: true,
        auto_pr: false,
        created_at: '2026-09-09T00:00:00.000Z',
        started_at: '2026-09-09T00:00:00.000Z',
        completed_at: null,
        run_slug: runSlug,
        worktree_path: cloneCwd,
      }],
    }), 'utf-8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-summary-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    readFileSyncMock.mockClear();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.callTool({
        name: 'takt_list_tasks',
        arguments: { cwd },
      });
      expect(listed.isError).toBeUndefined();
      const listedText = firstTextContent(listed.content);
      const listedTask = (JSON.parse(listedText) as { tasks: Array<Record<string, unknown>> }).tasks[0];
      expect(listedTask).not.toHaveProperty('summary');
      expect(listedText).not.toContain(secret);

      const told = await client.callTool({
        name: 'takt_tell_run',
        arguments: { cwd, runSlug, content: 'keep the task focused' },
      });
      expect(told.isError).toBeUndefined();
      const toldText = firstTextContent(told.content);
      expect((JSON.parse(toldText) as { target: Record<string, unknown> }).target)
        .not.toHaveProperty('summary');
      expect(toldText).not.toContain(secret);
      expect(readFileSyncMock.mock.calls.filter(([filePath]) => filePath === contentPath)).toHaveLength(0);
      expect(readFileSync(contentPath, 'utf-8')).toContain(secret);
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(contentRoot, { recursive: true, force: true });
    }
  });

  it('keeps the same conversation alive after a deleted run read fails', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-conversation-recovery-'));
    const runSlug = 'recoverable-run';
    const runDir = join(cwd, '.takt', 'runs', runSlug);
    mkdirSync(join(runDir, 'logs'), { recursive: true });
    mkdirSync(join(runDir, 'reports'), { recursive: true });
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
      task: 'Recoverable task',
      workflow: 'default',
      runSlug,
      runRoot: `.takt/runs/${runSlug}`,
      reportDirectory: `.takt/runs/${runSlug}/reports`,
      contextDirectory: `.takt/runs/${runSlug}/context`,
      logsDirectory: `.takt/runs/${runSlug}/logs`,
      status: 'running',
      startTime: '2026-09-09T00:00:00.000Z',
      currentStep: 'implement',
    }), 'utf8');
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'recoverable-task',
        status: 'running',
        content: 'Recoverable task',
        summary: 'A task whose run may disappear',
        workflow: 'default',
        worktree: false,
        auto_pr: false,
        created_at: '2026-09-09T00:00:00.000Z',
        started_at: '2026-09-09T00:00:00.000Z',
        completed_at: null,
        run_slug: runSlug,
      }],
    }), 'utf8');

    const calls: Array<{ prompt: string; sessionId: string | undefined }> = [];
    let turn = 0;
    const provider = {
      supportsNativeImageInput: false,
      getRuntimeInstructions: () => null,
      setup: vi.fn(() => ({
        call: async (prompt: string, options: { sessionId?: string }) => {
          calls.push({ prompt, sessionId: options.sessionId });
          turn += 1;
          if (turn === 1) {
            const result = getTaktRun({ cwd, runSlug });
            return {
              persona: 'interactive',
              status: 'done' as const,
              content: `Initial task state: ${firstTextContent(result.content)}`,
              timestamp: new Date(),
              sessionId: 'conversation-session',
            };
          }
          if (turn === 2) {
            const result = getTaktRun({ cwd, runSlug });
            return {
              persona: 'interactive',
              status: 'done' as const,
              content: `The task state could not be read: ${firstTextContent(result.content)}`,
              timestamp: new Date(),
              sessionId: 'conversation-session',
            };
          }
          const result = listTaktTasks({ cwd });
          return {
            persona: 'interactive',
            status: 'done' as const,
            content: `The task list is still available: ${firstTextContent(result.content)}`,
            timestamp: new Date(),
            sessionId: 'conversation-session',
          };
        },
      })),
    } as unknown as SessionContext['provider'];
    const ctx: SessionContext = {
      provider,
      providerType: 'mock',
      model: 'test-model',
      lang: 'en',
      personaName: 'interactive',
      sessionId: undefined,
    };
    const conversation = createConversationSession({
      cwd,
      formalSpec: false,
      modelCheckTimeoutSeconds: 300,
      ctx,
      strategy: {
        systemPrompt: 'system',
        modelCheckTimeoutSeconds: 300,
        allowedTools: [],
        transformPrompt: (message) => message,
      },
    });

    try {
      const initial = await conversation.handleUserMessage({ text: 'show the run details' });
      expect(initial).toMatchObject({
        kind: 'assistant_response',
        content: expect.stringContaining('currentStep'),
      });

      rmSync(join(runDir, 'meta.json'));
      const afterDeletion = await conversation.handleUserMessage({ text: 'check that run again' });
      expect(afterDeletion).toMatchObject({
        kind: 'assistant_response',
        content: expect.stringContaining('Run read failed'),
      });

      const afterFailure = await conversation.handleUserMessage({ text: 'list the remaining tasks' });
      expect(afterFailure).toMatchObject({
        kind: 'assistant_response',
        content: expect.stringContaining('recoverable-task'),
      });
      expect(calls).toHaveLength(3);
      expect(calls[1]?.sessionId).toBe('conversation-session');
      expect(calls[2]?.sessionId).toBe('conversation-session');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('sends an MCP tell to a merge run using project-side metadata', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-tell-merge-'));
    const cloneCwd = join(cwd, '.takt', 'worktrees', 'merge');
    const runSlug = 'mcp-merge-run';
    mkdirSync(cloneCwd, { recursive: true });
    const { interventionPath } = writeRunFixture(cwd, runSlug, 'review');
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        name: 'merge-pr-1805', status: 'running', summary: 'Merge PR #1805',
        content_file: '/definitely-not-readable/merge-task.md',
        source: 'pr_review', pr_number: 1805, merge_task: true,
        base_branch: 'main', merge_method: 'squash',
        merge_head_repository_url: 'https://example.com/owner/takt.git',
        merge_head_repository_push_urls: ['https://example.com/owner/takt.git'],
        merge_initial_head_sha: 'a'.repeat(40), merge_threat_check_max_diff_bytes: 100_000,
        merge_caccia_required: false, merge_clone_prepared: true,
        workflow: 'default', worktree: true, worktree_path: cloneCwd, auto_pr: false,
        branch: 'feature/tell-merge', run_slug: runSlug,
        created_at: '2026-09-09T00:00:00.000Z', started_at: '2026-09-09T00:00:00.000Z', completed_at: null,
      }],
    }), 'utf8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-tell-merge-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const written = await client.callTool({
        name: 'takt_tell_run',
        arguments: { cwd, runSlug, content: 'Keep the agreed merge scope.' },
      });

      expect(written.isError, firstTextContent(written.content)).toBeUndefined();
      expect(JSON.parse(firstTextContent(written.content))).toMatchObject({
        runSlug, instructionId: 1,
        target: { name: 'merge-pr-1805', runSlug, currentStep: 'review' },
      });
      expect(JSON.parse(readFileSync(interventionPath, 'utf8'))).toMatchObject({
        type: 'issued', instructionId: 1, content: 'Keep the agreed merge scope.',
      });
      expect(existsSync(join(cloneCwd, '.takt', 'runs', runSlug, 'interventions.jsonl'))).toBe(false);
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('writes only to a running clone and rejects terminal, missing, and non-clone targets', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-tell-'));
    const cloneCwd = join(cwd, '.takt', 'worktrees', 'active');
    const activeSlug = 'active-run';
    const nonCloneSlug = 'local-run';
    const mismatchSlug = 'mismatch-run';
    const writeRunMeta = (
      baseCwd: string,
      slug: string,
      status: 'running' | 'completed',
      persistedSlug = slug,
    ): string => {
      const runDir = join(baseCwd, '.takt', 'runs', slug);
      mkdirSync(join(runDir, 'logs'), { recursive: true });
      mkdirSync(join(runDir, 'reports'), { recursive: true });
      writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
        task: slug,
        workflow: 'default',
        runSlug: persistedSlug,
        runRoot: `.takt/runs/${slug}`,
        reportDirectory: `.takt/runs/${slug}/reports`,
        contextDirectory: `.takt/runs/${slug}/context`,
        logsDirectory: `.takt/runs/${slug}/logs`,
        status,
        startTime: '2026-09-09T00:00:00.000Z',
        currentStep: 'implement',
      }), 'utf-8');
      return runDir;
    };
    const activeRunDir = writeRunMeta(cloneCwd, activeSlug, 'running');
    writeRunMeta(cwd, nonCloneSlug, 'running');
    writeRunMeta(cloneCwd, mismatchSlug, 'running', 'different-slug');
    mkdirSync(join(cwd, '.takt', 'runs'), { recursive: true });
    const interventionPath = join(cwd, '.takt', 'runs', activeSlug, 'interventions.jsonl');
    mkdirSync(join(cwd, '.takt', 'runs', activeSlug), { recursive: true });
    writeFileSync(interventionPath, `${JSON.stringify({
      type: 'issued',
      instructionId: 1,
      issuedAt: '2026-09-09T00:00:30.000Z',
      content: 'Keep the existing session flow.',
    })}\n`, 'utf-8');
    writeFileSync(join(cwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [
        {
          name: 'active',
          status: 'running',
          content_file: '/definitely-not-readable/active-task.md',
          summary: 'Active task summary',
          workflow: 'default',
          worktree: true,
          auto_pr: false,
          created_at: '2026-09-09T00:00:00.000Z',
          started_at: '2026-09-09T00:00:00.000Z',
          completed_at: null,
          run_slug: activeSlug,
          worktree_path: cloneCwd,
        },
        {
          name: 'non-clone',
          status: 'running',
          content: 'Non-clone task',
          workflow: 'default',
          worktree: false,
          auto_pr: false,
          created_at: '2026-09-09T00:00:00.000Z',
          started_at: '2026-09-09T00:00:00.000Z',
          completed_at: null,
          run_slug: nonCloneSlug,
        },
        {
          name: 'mismatch',
          status: 'running',
          content: 'Mismatched task',
          workflow: 'default',
          worktree: true,
          auto_pr: false,
          created_at: '2026-09-09T00:00:00.000Z',
          started_at: '2026-09-09T00:00:00.000Z',
          completed_at: null,
          run_slug: mismatchSlug,
          worktree_path: cloneCwd,
        },
      ],
    }), 'utf-8');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-tell-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const readRun = async () => {
        const result = await client.callTool({ name: 'takt_get_run', arguments: { cwd, runSlug: activeSlug } });
        expect(result.isError).toBeUndefined();
        return JSON.parse(firstTextContent(result.content));
      };
      expect((await readRun()).liveIntervention.instructions).toEqual([
        expect.objectContaining({ instructionId: 1, content: 'Keep the existing session flow.' }),
      ]);
      const written = await client.callTool({
        name: 'takt_tell_run',
        arguments: { cwd, runSlug: activeSlug, content: 'Skip Android support for this task.' },
      });
      expect(written.isError).toBeUndefined();
      expect(firstTextContent(written.content)).toContain(activeSlug);
      const writtenEvents = readFileSync(interventionPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { instructionId: number; content: string });
      expect(writtenEvents).toEqual([
        expect.objectContaining({ instructionId: 1, content: 'Keep the existing session flow.' }),
        expect.objectContaining({ instructionId: 2, content: 'Skip Android support for this task.' }),
      ]);
      const instructionId = JSON.parse(firstTextContent(written.content)).instructionId;
      expect((await readRun()).liveIntervention.instructions).toContainEqual(expect.objectContaining({
        instructionId, content: 'Skip Android support for this task.',
      }));
      const tasks = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd, limit: 1 } });
      expect(JSON.parse(firstTextContent(tasks.content)).tasks).toEqual([
        expect.objectContaining({ name: 'active', runSlug: activeSlug, status: 'running' }),
      ]);

      writeFileSync(join(activeRunDir, 'meta.json'), JSON.stringify({
        task: 'active',
        workflow: 'default',
        runSlug: activeSlug,
        runRoot: `.takt/runs/${activeSlug}`,
        reportDirectory: `.takt/runs/${activeSlug}/reports`,
        contextDirectory: `.takt/runs/${activeSlug}/context`,
        logsDirectory: `.takt/runs/${activeSlug}/logs`,
        status: 'completed',
        startTime: '2026-09-09T00:00:00.000Z',
        endTime: '2026-09-09T00:02:00.000Z',
      }), 'utf-8');
      const beforeRejectedWrites = readFileSync(interventionPath, 'utf-8');

      for (const [runSlug, reason] of [
        [activeSlug, 'completed'],
        ['missing-run', 'missing'],
        [nonCloneSlug, 'clone'],
        [mismatchSlug, 'slug'],
      ] as const) {
        const rejected = await client.callTool({
          name: 'takt_tell_run',
          arguments: { cwd, runSlug, content: `must reject ${reason}` },
        });
        expect(rejected.isError).toBe(true);
        expect(firstTextContent(rejected.content).toLowerCase()).toContain(reason);
      }
      expect(readFileSync(interventionPath, 'utf-8')).toBe(beforeRejectedWrites);
      expect(existsSync(join(cwd, '.takt', 'runs', nonCloneSlug, 'interventions.jsonl'))).toBe(false);
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reads saved enqueued tasks on subsequent task-list pages', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-enqueue-read-'));
    const configDirectory = mkdtempSync(join(tmpdir(), 'takt-mcp-enqueue-config-'));
    vi.stubEnv('TAKT_CONFIG_DIR', configDirectory);
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nbranch_name_strategy: romaji\nmanager:\n  auto_run: false\n');
    writeFileSync(join(cwd, '.takt', 'workflows', 'fixture.yaml'), 'name: fixture\ninitial_step: work\nsteps:\n  - name: work\n    persona: ./persona.md\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
    writeFileSync(join(cwd, '.takt', 'workflows', 'persona.md'), 'Work on the fixture task.');
    const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'enqueue-read-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const names: string[] = [];
      for (const task of ['First task', 'Second task']) {
        const result = await client.callTool({ name: 'takt_enqueue_task', arguments: { cwd, task, workflow: 'fixture', worktree: false, autoPr: false } });
        expect(result.isError, firstTextContent(result.content)).toBeUndefined();
        names.push(JSON.parse(firstTextContent(result.content)).taskName);
      }
      const first = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd, limit: 1 } });
      const page = JSON.parse(firstTextContent(first.content));
      expect(page).toMatchObject({ totalCount: 2, returnedCount: 1, nextOffset: 1, truncated: true });
      const second = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd, limit: 1, offset: page.nextOffset } });
      const last = JSON.parse(firstTextContent(second.content));
      expect(last).toMatchObject({ returnedCount: 1, nextOffset: null });
      expect([...page.tasks, ...last.tasks]).toEqual(names.map((name) => expect.objectContaining({ name, status: 'pending' })));
    } finally {
      await client.close(); await server.close();
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(configDirectory, { recursive: true, force: true });
    }
  });

  it('routes normal, existing-issue, and create-issue calls through the single tool', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-root-'));
    const saveTaskFile = vi.fn()
      .mockResolvedValueOnce({ taskName: 'normal', tasksFile: join(cwd, '.takt', 'tasks.yaml') })
      .mockResolvedValueOnce({ taskName: 'existing', tasksFile: join(cwd, '.takt', 'tasks.yaml') })
      .mockResolvedValueOnce({ taskName: 'created', tasksFile: join(cwd, '.takt', 'tasks.yaml') });
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
      issueUrl: 'https://example.test/issues/938',
    });
    const server = createTaktMcpServer(
      { saveTaskFile, createIssueFromTaskResult },
      { allowedProjectRoot: cwd },
    );
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({
        name: 'takt_enqueue_task',
        arguments: { cwd, task: 'Normal', workflow: 'default', autoPr: false },
      });
      await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd,
          task: 'Existing',
          workflow: 'default',
          autoPr: false,
          issue: { number: 937 },
        },
      });
      const created = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd,
          task: 'Created',
          workflow: 'default',
          autoPr: false,
          issue: { create: true, title: 'Explicit title', labels: ['mcp'] },
        },
      });
      expect(created.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(created.content))).toEqual(expect.objectContaining({
        issueNumber: 938,
      }));
      expect(saveTaskFile).toHaveBeenCalledTimes(3);
      expect(saveTaskFile).toHaveBeenNthCalledWith(1, cwd, 'Normal', {
        workflow: 'default', worktree: true, autoPr: false,
      }, undefined, expect.any(AbortSignal));
      expect(saveTaskFile).toHaveBeenNthCalledWith(2, cwd, 'Existing', {
        workflow: 'default',
        worktree: true,
        autoPr: false,
        issue: 937,
      }, undefined, expect.any(AbortSignal));
      expect(saveTaskFile).toHaveBeenNthCalledWith(3, cwd, 'Created', {
        workflow: 'default', worktree: true, autoPr: false, issue: 938,
      }, undefined, expect.any(AbortSignal));
      expect(createIssueFromTaskResult).toHaveBeenCalledWith('Created', expect.objectContaining({
        explicitTitle: 'Explicit title',
        labels: ['mcp'],
      }));
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns a structured partial-success result through a real MCP client', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'takt-mcp-partial-'));
    const server = createTaktMcpServer({
      saveTaskFile: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
      createIssueFromTaskResult: vi.fn().mockReturnValue({
        success: true,
        issueNumber: 938,
        issueUrl: 'https://example.test/issues/938',
      }),
    }, { allowedProjectRoot: cwd });
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd,
          task: 'Created',
          workflow: 'default',
          autoPr: false,
          issue: { create: true },
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(firstTextContent(result.content))).toEqual({
        issueCreated: true,
        issueNumber: 938,
        issueUrl: 'https://example.test/issues/938',
        taskEnqueued: false,
        stage: 'task_saving',
        error: 'permission denied',
      });
    } finally {
      await client.close();
      await server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects removed tools and invalid nested issue shapes before saving', async () => {
    const saveTaskFile = vi.fn();
    const server = createTaktMcpServer({ saveTaskFile });
    const client = new Client({ name: 'takt-mcp-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const removed = await client.callTool({
        name: 'takt_run_next_task',
        arguments: { cwd: '/repo' },
      });
      expect(removed.isError).toBe(true);
      expect(firstTextContent(removed.content)).toContain('not found');
      const invalid = await client.callTool({
        name: 'takt_enqueue_task',
        arguments: {
          cwd: '/repo',
          task: 'Invalid',
          workflow: 'default',
          autoPr: false,
          issue: { number: 938, create: true },
        },
      });
      expect(invalid.isError).toBe(true);
      expect(saveTaskFile).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
