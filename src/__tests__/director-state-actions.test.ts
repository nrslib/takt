import { beforeEach, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createDirectorMcpServer, type DirectorStateActions } from '../features/director/mcp.js';

const doubles = vi.hoisted(() => ({
  handlers: new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>(),
  resolveSubject: vi.fn(), resolveManager: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class {
  registerTool(name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<CallToolResult>) { doubles.handlers.set(name, handler); }
} }));
vi.mock('../features/director/notificationTarget.js', async (original) => ({
  ...await original<typeof import('../features/director/notificationTarget.js')>(), resolveDirectorNotificationSubject: doubles.resolveSubject,
}));
vi.mock('../features/director/managers.js', () => ({ resolveDirectorManager: doubles.resolveManager, listDirectorManagers: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); doubles.handlers.clear(); });
function fixture() {
  const actions: DirectorStateActions = { tellManager: vi.fn(async () => ({ kind: 'accepted', operationId: 'operation', managerId: 'manager' })),
    notifyHuman: vi.fn(async (message) => ({ id: 'notice', message })) };
  const controller = new AbortController();
  createDirectorMcpServer('/config', actions, controller.signal);
  return { actions, controller };
}
it('sends manager messages through the state action and returns durable acceptance', async () => {
  const f = fixture();
  const result = await doubles.handlers.get('takt_tell_manager')!({ managerId: 'manager', text: 'message' });
  expect(f.actions.tellManager).toHaveBeenCalledExactlyOnceWith('manager', 'message');
  expect(result.isError).toBeUndefined();
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
  expect((await doubles.handlers.get('takt_tell_manager')!({ managerId: 'manager', text: 'message' })).isError).toBe(true);
  expect(f.actions.tellManager).not.toHaveBeenCalled();
});
