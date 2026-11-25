import { beforeEach, expect, it, vi } from 'vitest';
import type { CallToolResult, JSONRPCRequest, RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { ZodType } from 'zod/v4';
import { createDirectorMcpServer, DIRECTOR_TOOL_ALLOWLIST } from '../features/director/mcp.js';
import { firstTextContent } from './helpers/mcp-content.js';

const doubles = vi.hoisted(() => ({
  handlers: new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>(),
  schemas: new Map<string, ZodType>(),
  requests: new Map<RequestId, JSONRPCRequest>(),
  resolveSubject: vi.fn(), resolveManager: vi.fn(), git: vi.fn(), acquire: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class {
  registerTool(name: string, schema: { inputSchema: ZodType }, handler: (args: Record<string, unknown>) => Promise<CallToolResult>) {
    doubles.handlers.set(name, (args) => {
      const requestId = doubles.requests.size + 1;
      doubles.requests.set(requestId, { jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } });
      return (handler as (args: Record<string, unknown>, extra: { requestId: RequestId }) => Promise<CallToolResult>)(args, { requestId });
    }); doubles.schemas.set(name, schema.inputSchema);
  }
} }));
vi.mock('../features/director/notificationTarget.js', async (original) => ({
  ...await original<typeof import('../features/director/notificationTarget.js')>(), resolveDirectorNotificationSubject: doubles.resolveSubject,
}));
vi.mock('../features/director/managers.js', () => ({ resolveDirectorManager: doubles.resolveManager, listDirectorManagers: vi.fn() }));
vi.mock('../infra/task/gitRepositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: doubles.git }));
vi.mock('../infra/conversations/assignmentLock.js', () => ({ acquireRepositoryAssignmentLocks: doubles.acquire }));
beforeEach(() => { vi.resetAllMocks(); doubles.handlers.clear(); doubles.schemas.clear(); doubles.requests.clear();
  doubles.git.mockImplementation(async (path: string) => path); doubles.acquire.mockResolvedValue(vi.fn(async () => {})); });
function fixture() {
  const actions = { setQuestionRoute: vi.fn(async () => ({})), authorizeAddManager: vi.fn<(repositoryDirectory: string) => void>(), tellManager: vi.fn(async () => ({ kind: 'accepted', operationId: 'operation', managerId: 'manager' })),
    addManager: vi.fn(async (_repositoryDirectory: string) => ({ managerId: `manager-${'a'.repeat(64)}` })),
    fireManager: vi.fn(async (managerId: string) => ({ managerId })),
    notifyHuman: vi.fn(async (message: string) => ({ id: 'notice', message })) };
  const controller = new AbortController();
  const retained: Array<() => Promise<void>> = [];
  createDirectorMcpServer('/config', actions, controller.signal, {
    bind: (_server, signal, prepare) => ({ run: async (id, action) => {
      signal.throwIfAborted(); await prepare([doubles.requests.get(id)!], signal, async (_key, acquire) => { retained.push(await acquire()); });
      signal.throwIfAborted(); return action(signal);
    } }),
  });
  return { actions, controller, retained };
}
it.each(['human', 'director'] as const)('sends %s messages through the state action and returns durable acceptance', async (origin) => {
  const f = fixture();
  const result = await doubles.handlers.get('takt_tell_manager')!({ managerId: 'manager', text: 'message', origin });
  expect(f.actions.tellManager).toHaveBeenCalledExactlyOnceWith('manager', 'message', origin);
  expect(result.isError).toBeUndefined();
});

it('exposes manager lifecycle tools through the director allowlist', () => {
  fixture();
  for (const name of ['takt_add_manager', 'takt_fire_manager']) {
    expect(doubles.handlers.has(name)).toBe(true);
    expect(DIRECTOR_TOOL_ALLOWLIST).toContain(`mcp__takt_director__${name}`);
  }
});

it('delegates the supplied repository to the daemon action and returns its manager identity', async () => {
  const f = fixture();
  const handler = doubles.handlers.get('takt_add_manager');
  expect(handler).toBeTypeOf('function');
  const result = await handler!({ repositoryDirectory: '/work/blog' });
  expect(f.actions.authorizeAddManager).toHaveBeenCalledExactlyOnceWith('/work/blog');
  expect(f.actions.addManager).toHaveBeenCalledExactlyOnceWith('/work/blog', f.controller.signal);
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(firstTextContent(result.content))).toEqual({ managerId: `manager-${'a'.repeat(64)}` });
  const release = await doubles.acquire.mock.results[0]!.value;
  expect(f.retained).toContain(release); expect(release).not.toHaveBeenCalled();
});

it('delegates fire for the selected manager identity', async () => {
  const f = fixture();
  const handler = doubles.handlers.get('takt_fire_manager');
  expect(handler).toBeTypeOf('function');
  const managerId = `manager-${'b'.repeat(64)}`;
  const result = await handler!({ managerId });
  expect(f.actions.fireManager).toHaveBeenCalledExactlyOnceWith(managerId, f.controller.signal);
  expect(result.isError).toBeUndefined();
});

it('rejects a disallowed add before Git resolution', async () => {
  const f = fixture();
  f.actions.authorizeAddManager.mockImplementationOnce(() => { throw new Error('not authorized'); });
  expect((await doubles.handlers.get('takt_add_manager')!({ repositoryDirectory: '/work/blog' })).isError).toBe(true);
  expect(doubles.git).not.toHaveBeenCalled(); expect(doubles.acquire).not.toHaveBeenCalled();
  expect(f.actions.addManager).not.toHaveBeenCalled();
});

it('keeps the supplied path separate from the canonical lock path', async () => {
  const f = fixture();
  doubles.git.mockResolvedValueOnce('/canonical/blog');
  expect((await doubles.handlers.get('takt_add_manager')!({ repositoryDirectory: '/work/blog' })).isError).not.toBe(true);
  expect(f.actions.authorizeAddManager).toHaveBeenCalledExactlyOnceWith('/work/blog');
  expect(doubles.acquire).toHaveBeenCalledWith('/config', ['/canonical/blog'], f.controller.signal);
  expect(f.actions.addManager).toHaveBeenCalledWith('/work/blog', f.controller.signal);
});

it('does not start preparation when assignment lock acquisition is cancelled', async () => {
  const f = fixture();
  doubles.acquire.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
  expect((await doubles.handlers.get('takt_add_manager')!({ repositoryDirectory: '/work/blog' })).isError).toBe(true);
  expect(f.actions.addManager).not.toHaveBeenCalled();
  expect(doubles.acquire).toHaveBeenCalledOnce();
});

it.each([
  { name: 'takt_add_manager', valid: { repositoryDirectory: '/work/blog' }, invalid: [{}, { repositoryDirectory: 1 }, { repositoryDirectory: '/work/blog', search: true }] },
  { name: 'takt_fire_manager', valid: { managerId: `manager-${'a'.repeat(64)}` }, invalid: [{}, { managerId: 'unknown' }, { managerId: `manager-${'a'.repeat(64)}`, force: true }] },
])('validates the strict input of $name', ({ name, valid, invalid }) => {
  fixture();
  const schema = doubles.schemas.get(name);
  expect(schema).toBeDefined();
  expect(schema!.safeParse(valid).success).toBe(true);
  for (const value of invalid) expect(schema!.safeParse(value).success).toBe(false);
});

it.each(['takt_add_manager', 'takt_fire_manager'])('does not invoke %s after interruption', async (name) => {
  const f = fixture();
  f.controller.abort();
  const handler = doubles.handlers.get(name);
  expect(handler).toBeTypeOf('function');
  expect((await handler!({ repositoryDirectory: '/work/blog', managerId: `manager-${'a'.repeat(64)}` })).isError).toBe(true);
  expect(f.actions.addManager).not.toHaveBeenCalled();
  expect(f.actions.fireManager).not.toHaveBeenCalled();
});

it('returns the reason for refusing to fire a manager', async () => {
  const f = fixture();
  f.actions.fireManager.mockRejectedValueOnce(new Error('Manager has an unfinished goal'));
  const handler = doubles.handlers.get('takt_fire_manager');
  expect(handler).toBeTypeOf('function');
  const result = await handler!({ managerId: `manager-${'a'.repeat(64)}` });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('unfinished goal') })]));
});
it('requires explicit human or director authorship on the MCP input', () => {
  fixture();
  const schema = doubles.schemas.get('takt_tell_manager')!;
  const message = { managerId: `manager-${'a'.repeat(64)}`, text: 'A human says stop.' };
  for (const origin of [undefined, 'unknown', 'manager']) expect(schema.safeParse({ ...message, origin }).success).toBe(false);
  for (const origin of ['human', 'director']) expect(schema.safeParse({ ...message, origin }).success).toBe(true);
});
it('validates notification subjects in the child and delegates persistence to the daemon action', async () => {
  const f = fixture(); const target = { managerId: 'manager', inquiryId: 'inquiry' };
  const subject = { key: 'target', state: 'pending' }; doubles.resolveSubject.mockResolvedValue(subject);
  const result = await doubles.handlers.get('takt_notify_human')!({ message: 'notice', target });
  expect(doubles.resolveSubject).toHaveBeenCalledExactlyOnceWith('/config', target);
  expect(f.actions.notifyHuman).toHaveBeenCalledWith(expect.any(String), subject);
  expect(result.isError).toBeUndefined();
});
it('does not save an invalid subject or invoke actions after interruption', async () => {
  const f = fixture(); doubles.resolveSubject.mockRejectedValue(new Error('invalid subject'));
  expect((await doubles.handlers.get('takt_notify_human')!({ message: 'notice', target: { managerId: 'manager', inquiryId: 'inquiry' } })).isError).toBe(true);
  expect(f.actions.notifyHuman).not.toHaveBeenCalled();
  f.controller.abort();
  expect((await doubles.handlers.get('takt_tell_manager')!({ managerId: 'manager', text: 'message', origin: 'human' })).isError).toBe(true);
  expect(f.actions.tellManager).not.toHaveBeenCalled();
});
