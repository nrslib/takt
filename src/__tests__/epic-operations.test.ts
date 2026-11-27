import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerEpicTools, EPIC_TOOL_NAMES } from '../features/mcp/epicOperations.js';
import { epicRecord } from './helpers/epic-fixtures.js';
import { verificationRunId, verificationStartedAt, secondGoalId, verificationResultFor } from './helpers/epic-fixtures.js';
import { beginEpicVerification, applyEpicVerificationResult, finishEpic, epicView } from '../infra/epics/state.js';

const doubles = vi.hoisted(() => ({ create: vi.fn(), start: vi.fn(), complete: vi.fn(), list: vi.fn(), resolve: vi.fn() }));
vi.mock('../infra/epics/index.js', async (original) => ({ ...await original<typeof import('../infra/epics/index.js')>(), createEpic: doubles.create,
  startEpicVerification: doubles.start, completeEpic: doubles.complete, listEpics: doubles.list }));
vi.mock('../features/manager/assignment.js', async (original) => ({ ...await original<typeof import('../features/manager/assignment.js')>(), resolveAssignedProjectRoot: doubles.resolve }));

describe('Epic manager tool registration', () => {
  it('requests storage pages and resolves list fields against the global index', async () => {
    const callbacks = new Map<string, (input: unknown, extra: { signal: AbortSignal }) => Promise<CallToolResult>>();
    const server = { registerTool: (name: string, _config: unknown, handler: (input: unknown, extra: { signal: AbortSignal }) => Promise<CallToolResult>) => callbacks.set(name, handler) } as unknown as McpServer;
    const epic = epicRecord();
    registerEpicTools(server, { globalConfigDirectory: '/config', currentAssignment: async () => ({ kind: 'workspace', workspaceId: epic.workspaceId, name: 'workspace', repositoryDirectories: [] }),
      withTurn: (action) => action(), turnSignal: (signal) => signal });
    const records = [epic, { ...epic, id: secondGoalId, objective: 'Second Epic' }, { ...epic, id: verificationRunId }];
    doubles.list.mockImplementation(async (_owner: unknown, page: { offset: number; limit: number }) => ({
      epics: records.slice(page.offset, page.offset + page.limit), totalCount: records.length, offset: page.offset,
    }));
    const call = async (input: Record<string, unknown>) => {
      const result = await callbacks.get('takt_list_epics')!({ cwd: '/workspace', ...input }, { signal: new AbortController().signal });
      if (result.isError) return { isError: true };
      if (result.content[0]?.type !== 'text') throw new Error('Expected text');
      return { ...JSON.parse(result.content[0].text), isError: result.isError };
    };
    expect(await call({ offset: 1, limit: 1 })).toMatchObject({ epics: [records[1]], totalCount: 3, offset: 1, nextOffset: 2 });
    expect(doubles.list).toHaveBeenLastCalledWith({ globalConfigDirectory: '/config', workspaceId: epic.workspaceId }, { offset: 1, limit: 1 });
    expect(await call({ offset: 0, limit: 1, path: '1.objective' })).toMatchObject({ path: '1.objective', content: 'Second Epic' });
    expect(doubles.list).toHaveBeenLastCalledWith(expect.anything(), { offset: 1, limit: 1 });
    expect(await call({ path: 'length' })).toMatchObject({ path: 'length', content: '3' });
    expect(doubles.list).toHaveBeenLastCalledWith(expect.anything(), { offset: 0, limit: 0 });
    expect(await call({ path: '__proto__' })).toMatchObject({ isError: true });
    expect(await call({ offset: 3, limit: 1 })).toMatchObject({ epics: [], totalCount: 3, nextOffset: null });
    doubles.list.mockResolvedValueOnce({ epics: [], totalCount: 0, offset: 0 });
    expect(await call({})).toMatchObject({ epics: [], totalCount: 0, returnedCount: 0, nextOffset: null });
    doubles.list.mockRejectedValueOnce(new AggregateError([new Error('Invalid later record')]));
    expect(await call({ limit: 1 })).toMatchObject({ isError: true });
  });
  it('registers every public operation and forwards the server-owned workspace and reason', async () => {
    const callbacks = new Map<string, (input: unknown, extra: { signal: AbortSignal }) => Promise<CallToolResult>>();
    const server = { registerTool: (name: string, _config: unknown, handler: (input: unknown, extra: { signal: AbortSignal }) => Promise<CallToolResult>) => callbacks.set(name, handler) } as unknown as McpServer;
    const epic = epicRecord();
    doubles.create.mockResolvedValue(epic);
    doubles.resolve.mockResolvedValue('/repo');
    const changed = vi.fn();
    registerEpicTools(server, { globalConfigDirectory: '/config', currentAssignment: async () => ({ kind: 'workspace', workspaceId: epic.workspaceId, name: 'workspace', repositoryDirectories: ['/repo'] }),
      withTurn: (action) => action(), turnSignal: (signal) => signal, changed });
    expect([...callbacks.keys()]).toEqual(EPIC_TOOL_NAMES);
    const input = { cwd: '/repo', objective: epic.objective, acceptanceCriteria: epic.acceptanceCriteria, verificationProcedure: epic.verificationProcedure, reason: 'requested' };
    const response = await callbacks.get('takt_create_epic')!(input, { signal: new AbortController().signal });
    expect(doubles.create).toHaveBeenCalledWith({ ...input, cwd: undefined, globalConfigDirectory: '/config', workspaceId: epic.workspaceId });
    expect(response.isError).not.toBe(true);
    if (response.content[0]?.type !== 'text') throw new Error('Expected text');
    expect(JSON.parse(response.content[0].text)).toMatchObject({ operation: { tool: 'takt_create_epic', reason: 'requested' } });
    doubles.create.mockClear();
    const invalidPath = await callbacks.get('takt_create_epic')!({ ...input, path: 'missing.field' }, { signal: new AbortController().signal });
    expect(invalidPath.isError).not.toBe(true);
    if (invalidPath.content[0]?.type !== 'text') throw new Error('Expected text');
    expect(JSON.parse(invalidPath.content[0].text)).toMatchObject({
      epic: { epicId: epic.id, requestedPath: 'missing.field', responseSelectionError: 'Unknown Epic field' },
      operation: { tool: 'takt_create_epic', reason: 'requested' },
    });
    expect(doubles.create).toHaveBeenCalledOnce();
    const member = { repositoryDirectory: '/repo', goalId: secondGoalId };
    const started = beginEpicVerification({ ...epic, members: [member], targets: [{ ...member, targetSha: 'b'.repeat(40) }] }, verificationRunId, verificationStartedAt);
    doubles.complete.mockResolvedValue(epicView(finishEpic(applyEpicVerificationResult(started.epic, verificationResultFor(started.run)))));
    await callbacks.get('takt_complete_epic')!({ cwd: '/repo', epicId: epic.id, reason: 'confirmed' }, { signal: new AbortController().signal });
    expect(doubles.complete).toHaveBeenCalledWith({ globalConfigDirectory: '/config', workspaceId: epic.workspaceId, epicId: epic.id });
    expect(changed).toHaveBeenCalledWith(epic.workspaceId, epic.id, 'confirmed');
    const run = { id: verificationRunId, revision: epic.revision, status: 'running' };
    doubles.start.mockResolvedValue(run);
    changed.mockRejectedValueOnce(new Error('Daemon event publication unavailable'));
    const startResponse = await callbacks.get('takt_start_epic_verification')!({ cwd: '/repo', epicId: epic.id, reason: 'start verification' },
      { signal: new AbortController().signal });
    expect(startResponse.isError).not.toBe(true);
    if (startResponse.content[0]?.type !== 'text') throw new Error('Expected text');
    expect(JSON.parse(startResponse.content[0].text)).toMatchObject({ epic: run,
      operation: { tool: 'takt_start_epic_verification', reason: 'start verification', eventPublicationPending: true } });
    const controller = new AbortController(); controller.abort();
    expect((await callbacks.get('takt_create_epic')!(input, { signal: controller.signal })).isError).toBe(true);
    expect(doubles.create).toHaveBeenCalledOnce();
  });

  it('rejects an ended turn before invoking domain operations', async () => {
    let callback: ((input: unknown, extra: { signal: AbortSignal }) => Promise<CallToolResult>) | undefined;
    const server = { registerTool: (_name: string, _config: unknown, handler: typeof callback) => { callback = handler; } } as unknown as McpServer;
    const currentAssignment = vi.fn();
    registerEpicTools(server, { globalConfigDirectory: '/config', currentAssignment,
      withTurn: async () => { throw new Error('Turn ended'); }, turnSignal: (signal) => signal });
    expect((await callback!({ cwd: '/repo' }, { signal: new AbortController().signal })).isError).toBe(true);
    expect(currentAssignment).not.toHaveBeenCalled();
  });
});
