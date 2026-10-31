import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startManagerMcpConnection } from '../features/manager/managerMcpConnection.js';
import { MANAGER_ASSIGNMENT_HEADER } from '../features/manager/assignment.js';

const doubles = vi.hoisted(() => ({
  request: vi.fn(), uuid: vi.fn(), connect: vi.fn(), serverClose: vi.fn(), transportClose: vi.fn(),
  listenerClose: vi.fn(), destroy: vi.fn(), createMcp: vi.fn(), listen: vi.fn(),
}));
vi.mock('node:crypto', async (original) => ({ ...await original<typeof import('node:crypto')>(), randomUUID: doubles.uuid }));
vi.mock('node:http', () => ({ createServer: (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  doubles.request.mockImplementation(handler);
  return Object.assign(new EventEmitter(), {
    listening: false,
    listen(_port: number, _host: string, ready: () => void) { doubles.listen(); this.listening = true; ready(); },
    address: () => ({ port: 12345 }),
    close(callback: (error?: Error) => void) { this.listening = false; doubles.listenerClose(); callback(); },
    closeAllConnections: doubles.destroy,
  });
} }));
vi.mock('../features/mcp/server.js', () => ({ createTaktMcpServer: (_deps: unknown, options: unknown) => {
  doubles.createMcp(options);
  return { connect: doubles.connect, close: doubles.serverClose };
} }));
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({ StreamableHTTPServerTransport: class {
  sessionId: string | undefined;
  close = doubles.transportClose;
  constructor(private options: { sessionIdGenerator: () => string }) {}
  async handleRequest(_req: IncomingMessage, res: ServerResponse) {
    this.sessionId ??= this.options.sessionIdGenerator();
    res.writeHead(200); res.end();
  }
} }));

describe('owned manager MCP sessions', () => {
  const firstId = '650e8400-e29b-41d4-a716-446655440001';
  const secondId = '650e8400-e29b-41d4-a716-446655440002';
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.uuid.mockReturnValueOnce(firstId).mockReturnValueOnce(secondId);
    doubles.connect.mockResolvedValue(undefined);
    doubles.serverClose.mockResolvedValue(undefined);
    doubles.transportClose.mockResolvedValue(undefined);
  });
  const request = async (headers: Record<string, string>): Promise<number> => new Promise((resolve) => {
    const res = { writeHead: vi.fn(), end: () => resolve(res.writeHead.mock.calls[0]![0]) };
    doubles.request({ method: 'POST', url: '/', headers, resume: vi.fn() }, res);
  });

  it('keeps two sessions and their assignment identities separate', async () => {
    const owner = await startManagerMcpConnection('/repository');
    try {
      expect(await request(owner.config.headers!)).toBe(200);
      const assignment = { kind: 'repository', repositoryDirectory: '/work/担当A' };
      expect(await request({ ...owner.config.headers!, [MANAGER_ASSIGNMENT_HEADER]: Buffer.from(JSON.stringify(assignment)).toString('base64url') })).toBe(200);
      expect(doubles.createMcp.mock.calls.map(([options]) => options.managerAssignment)).toEqual([
        { kind: 'repository', repositoryDirectory: '/repository' }, assignment,
      ]);
      expect(await request({ ...owner.config.headers!, 'mcp-session-id': firstId })).toBe(200);
      expect(await request({ ...owner.config.headers!, 'mcp-session-id': secondId })).toBe(200);
      expect(doubles.createMcp).toHaveBeenCalledTimes(2);
    } finally { await owner.dispose(); }
    expect(doubles.serverClose).toHaveBeenCalledTimes(2);
    expect(doubles.transportClose).toHaveBeenCalledTimes(2);
  });

  it('rejects a duplicate identifier without replacing or closing the existing session', async () => {
    doubles.uuid.mockReset().mockReturnValue(firstId);
    const owner = await startManagerMcpConnection('/repository');
    try {
      expect(await request(owner.config.headers!)).toBe(200);
      expect(await request(owner.config.headers!)).toBe(409);
      expect(doubles.createMcp).toHaveBeenCalledOnce();
      expect(doubles.serverClose).not.toHaveBeenCalled();
      expect(await request({ ...owner.config.headers!, 'mcp-session-id': firstId })).toBe(200);
    } finally { await owner.dispose(); }
  });

  it.each(['missing', 'invalid'] as const)('rejects %s assignment before creating a session', async (failure) => {
    const owner = await startManagerMcpConnection('/repository');
    const headers = { ...owner.config.headers };
    if (failure === 'missing') delete headers[MANAGER_ASSIGNMENT_HEADER];
    else headers[MANAGER_ASSIGNMENT_HEADER] = Buffer.from(JSON.stringify({ kind: 'workspace', workspaceId: 'invalid' })).toString('base64url');
    try {
      expect(await request(headers)).toBe(400);
      expect(doubles.createMcp).not.toHaveBeenCalled();
    } finally { await owner.dispose(); }
  });

  it('closes the server and transport after session connection failure', async () => {
    doubles.connect.mockRejectedValueOnce(new Error('session failed'));
    const owner = await startManagerMcpConnection('/repository');
    try {
      expect(await request(owner.config.headers!)).toBe(500);
      expect(doubles.serverClose).toHaveBeenCalledOnce();
      expect(doubles.transportClose).toHaveBeenCalledOnce();
      expect(await request({ ...owner.config.headers!, 'mcp-session-id': firstId })).toBe(404);
    } finally { await owner.dispose(); }
  });

  it.each(['serverClose', 'transportClose', 'listenerClose'] as const)('invalidates execution and releases all sessions and the listener after %s failure', async (stage) => {
    const owner = await startManagerMcpConnection('/repository');
    await request(owner.config.headers!);
    await request(owner.config.headers!);
    if (stage === 'listenerClose') doubles.listenerClose.mockImplementationOnce(() => { throw new Error('close failed'); });
    else doubles[stage].mockRejectedValueOnce(new Error('close failed'));
    await expect(owner.dispose()).rejects.toThrow();
    await expect(owner.assertConnected()).rejects.toThrow();
    expect(doubles.serverClose).toHaveBeenCalledTimes(2);
    expect(doubles.transportClose).toHaveBeenCalledTimes(2);
    expect(doubles.listenerClose).toHaveBeenCalledOnce();
    expect(doubles.destroy).toHaveBeenCalledOnce();
  });

  it('invalidates and releases resources after listener startup failure', async () => {
    doubles.listen.mockImplementationOnce(() => { throw new Error('listen failed'); });
    await expect(startManagerMcpConnection('/repository')).rejects.toThrow();
    expect(doubles.destroy).toHaveBeenCalledOnce();
    expect(doubles.createMcp).not.toHaveBeenCalled();
  });
});
