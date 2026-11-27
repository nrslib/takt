import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createTaktMcpServer, type TaktMcpServerOptions } from '../features/mcp/server.js';
import { TaskRunner } from '../infra/task/runner.js';
import * as deletion from '../features/tasks/list/taskDeleteActions.js';
import * as taskActions from '../features/tasks/list/taskActions.js';
import * as response from '../features/mcp/response.js';
import { firstTextContent } from './helpers/mcp-content.js';

const statuses = ['pending', 'completed', 'failed', 'exceeded', 'pr_failed'] as const;
const goalId = '550e8400-e29b-41d4-a716-446655440000';
let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'takt-mcp-cleanup-'));
  mkdirSync(join(project, '.takt'));
  writeFileSync(join(project, '.takt', 'tasks.yaml'), stringify({
    tasks: [...statuses, 'running'].map((status) => ({
      name: status, status, content: status, branch: 'feature/shared', goal_id: goalId,
      created_at: '2026-02-09T00:00:00Z',
      started_at: status === 'pending' ? null : '2026-02-09T00:01:00Z',
      completed_at: status === 'pending' || status === 'running' ? null : '2026-02-09T00:02:00Z',
      ...(status === 'failed' ? { failure: { error: 'failed' } } : {}),
    })),
  }));
  vi.spyOn(taskActions, 'deleteBranch').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(project, { recursive: true, force: true });
});

async function withClient<T>(
  toolSet: TaktMcpServerOptions['toolSet'],
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createTaktMcpServer({}, { toolSet, allowedProjectRoot: project });
  const client = new Client({ name: 'cleanup-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function callCleanup(input: Record<string, unknown>): Promise<CallToolResult> {
  return withClient('all', async (client) => await client.callTool({
    name: 'takt_cleanup_tasks', arguments: { cwd: project, reason: 'Finished work', ...input },
  }) as CallToolResult);
}

describe('MCP task cleanup', () => {
  it.each([undefined, 'all', 'manager', 'read-only'] as const)('registers cleanup only in all, tool set=%s', async (toolSet) => {
    await withClient(toolSet, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === 'takt_cleanup_tasks')).toBe(toolSet === 'all');
    });
  });

  it.each([undefined, false])('previews stopped tasks without deleting when confirm=%s', async (confirm) => {
    const original = readFileSync(join(project, '.takt', 'tasks.yaml'), 'utf8');
    const remove = vi.spyOn(deletion, 'deleteTaskResources');
    const json = vi.spyOn(response, 'jsonResult');

    const result = await callCleanup({ statuses: [...statuses], ...(confirm === undefined ? {} : { confirm }) });
    const payload = JSON.parse(firstTextContent(result.content)) as { tasks: Array<{ name: string; goal_id: string }> };

    expect(result.isError).not.toBe(true);
    expect(payload.tasks.map((task) => task.name)).toEqual([...statuses]);
    expect(payload.tasks.every((task) => task.goal_id === goalId)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalled();
    expect(readFileSync(join(project, '.takt', 'tasks.yaml'), 'utf8')).toBe(original);
  });

  it('deletes the five stopped states through the shared function and preserves running', async () => {
    const remove = vi.spyOn(deletion, 'deleteTaskResources');
    const json = vi.spyOn(response, 'jsonResult');

    const result = await callCleanup({ statuses: [...statuses], confirm: true });
    const payload = JSON.parse(firstTextContent(result.content)) as { results: Array<{ success: boolean }> };

    expect(result.isError).not.toBe(true);
    expect(payload.results).toHaveLength(5);
    expect(payload.results.every((item) => item.success)).toBe(true);
    expect(remove.mock.calls.map(([task, options]) => [task.kind, options])).toEqual(
      statuses.map((status) => [status, { quiet: true }]),
    );
    expect(json).toHaveBeenCalled();
    expect(new TaskRunner(project).listAllTaskItems().map((task) => task.kind)).toEqual(['running']);
  });

  it('combines goal, statuses and branch while keeping branch-only selection completed-only', async () => {
    const preview = async (input: Record<string, unknown>) => {
      const result = await callCleanup(input);
      return (JSON.parse(firstTextContent(result.content)) as { tasks: Array<{ name: string }> }).tasks.map((task) => task.name);
    };
    expect(await preview({ branch: 'feature/shared' })).toEqual(['completed']);
    expect(await preview({ branch: 'feature/shared', statuses: ['failed'], goalId })).toEqual(['failed']);
    expect(await preview({ goalId: '550e8400-e29b-41d4-a716-446655440001' })).toEqual([]);
  });

  it.each([undefined, false, true])('rejects missing filters without deleting, confirm=%s', async (confirm) => {
    const remove = vi.spyOn(deletion, 'deleteTaskResources');
    const json = vi.spyOn(response, 'jsonResult');
    const result = await callCleanup(confirm === undefined ? {} : { confirm });
    expect(result.isError).toBe(true);
    expect(json).toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(new TaskRunner(project).listAllTaskItems()).toHaveLength(6);
  });

  it.each([
    { statuses: ['running'] }, { statuses: ['completed', 'running'] }, { statuses: [] },
    { reason: undefined }, { reason: '' }, { reason: '   ' },
  ])('rejects invalid input %j before deletion', async (input) => {
    const remove = vi.spyOn(deletion, 'deleteTaskResources');
    const result = await callCleanup({ statuses: ['completed'], confirm: true, ...input });
    expect(result.isError).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(new TaskRunner(project).listAllTaskItems()).toHaveLength(6);
  });

  it.each(['false', 'throw'] as const)('returns JSON errors and preserves the record after cleanup %s', async (failure) => {
    if (failure === 'false') vi.mocked(taskActions.deleteBranch).mockReturnValue(false);
    else vi.mocked(taskActions.deleteBranch).mockImplementation(() => { throw new Error('cleanup failed'); });
    const json = vi.spyOn(response, 'jsonResult');
    const result = await callCleanup({ statuses: ['completed'], confirm: true });
    const payload = JSON.parse(firstTextContent(result.content)) as { results: Array<{ success: boolean }> };
    expect(result.isError).toBe(true);
    expect(payload.results).toEqual([expect.objectContaining({ success: false })]);
    expect(json).toHaveBeenCalled();
    expect(new TaskRunner(project).listAllTaskItems().map((task) => task.name)).toContain('completed');
  });
});
