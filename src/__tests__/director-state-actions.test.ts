import { beforeEach, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodType } from 'zod/v4';
import { createDirectorMcpServer, type DirectorStateActions } from '../features/director/mcp.js';

const doubles = vi.hoisted(() => ({
  handlers: new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>(),
  schemas: new Map<string, ZodType>(),
  resolveSubject: vi.fn(), resolveManager: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class {
  registerTool(name: string, schema: { inputSchema: ZodType }, handler: (args: Record<string, unknown>) => Promise<CallToolResult>) {
    doubles.handlers.set(name, handler); doubles.schemas.set(name, schema.inputSchema);
  }
} }));
vi.mock('../features/director/notificationTarget.js', async (original) => ({
  ...await original<typeof import('../features/director/notificationTarget.js')>(), resolveDirectorNotificationSubject: doubles.resolveSubject,
}));
vi.mock('../features/director/managers.js', () => ({ resolveDirectorManager: doubles.resolveManager, listDirectorManagers: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); doubles.handlers.clear(); doubles.schemas.clear(); });
function fixture() {
  const actions: DirectorStateActions = { tellManager: vi.fn(async () => ({ kind: 'accepted', operationId: 'operation', managerId: 'manager' })),
    notifyHuman: vi.fn(async (message) => ({ id: 'notice', message })) };
  const controller = new AbortController();
  createDirectorMcpServer('/config', actions, controller.signal);
  return { actions, controller };
}
it.each(['human', 'director'] as const)('sends %s messages through the state action and returns durable acceptance', async (origin) => {
  const f = fixture();
  const result = await doubles.handlers.get('takt_tell_manager')!({ managerId: 'manager', text: 'message', origin });
  expect(f.actions.tellManager).toHaveBeenCalledExactlyOnceWith('manager', 'message', origin);
  expect(result.isError).toBeUndefined();
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
