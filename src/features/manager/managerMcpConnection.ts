import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpHttpServerConfig } from '../../core/models/workflow-provider-options.js';
import { createTaktMcpServer } from '../mcp/server.js';
import { MANAGER_ASSIGNMENT_HEADER, managerAssignmentSchema, type ManagerAssignmentIdentity } from './assignment.js';

export interface ManagerMcpConnection {
  assertConnected(): Promise<void>;
}

interface ManagerMcpSession {
  server: ReturnType<typeof createTaktMcpServer>;
  transport: StreamableHTTPServerTransport;
}

export async function startManagerMcpConnection(cwd: string, assignment?: ManagerAssignmentIdentity) {
  const authorization = `Bearer ${randomBytes(32).toString('hex')}`;
  const expected = Buffer.from(authorization);
  const sessions = new Map<string, ManagerMcpSession>();
  let active = true;
  const invalidate = (): void => { active = false; };
  const connection: ManagerMcpConnection = {
    async assertConnected() {
      if (!active || !listener.listening) throw new Error('Manager MCP connection is closed');
    },
  };
  const closeSession = async (session: ManagerMcpSession): Promise<void> => {
    try { await session.server.close(); }
    finally { await session.transport.close(); }
  };
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (!active || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      req.resume(); res.writeHead(403); res.end(); return;
    }
    if (req.url !== '/') { req.resume(); res.writeHead(404); res.end(); return; }
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId !== undefined) {
      const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (session === undefined) { req.resume(); res.writeHead(404); res.end(); return; }
      await session.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') { req.resume(); res.writeHead(400); res.end(); return; }
    const rawAssignment = req.headers[MANAGER_ASSIGNMENT_HEADER];
    let managerAssignment: ManagerAssignmentIdentity;
    try {
      if (typeof rawAssignment !== 'string') throw new Error('Missing assignment');
      managerAssignment = managerAssignmentSchema.parse(JSON.parse(Buffer.from(rawAssignment, 'base64url').toString('utf8')));
    } catch {
      req.resume(); res.writeHead(400); res.end(); return;
    }
    const id = randomUUID();
    if (sessions.has(id)) { req.resume(); res.writeHead(409); res.end(); return; }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableJsonResponse: true,
      onsessionclosed: () => { sessions.delete(id); },
    });
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd, managerAssignment, goalExecutionConnection: connection });
    const session = { server, transport };
    sessions.set(id, session);
    let connected = false;
    try {
      await server.connect(transport);
      await connection.assertConnected();
      await transport.handleRequest(req, res);
      connected = transport.sessionId !== undefined;
    } finally {
      if (!connected || !active) {
        sessions.delete(id);
        await closeSession(session);
      }
    }
  };
  const listener = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      // SDK や通信例外に含まれ得る認証情報を応答へ渡さない。
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const dispose = async (): Promise<void> => {
    invalidate();
    const results = await Promise.allSettled([...sessions.values()].map(closeSession));
    sessions.clear();
    listener.closeAllConnections();
    const closed = await Promise.allSettled([new Promise<void>((resolve, reject) => {
      if (!listener.listening) { resolve(); return; }
      listener.close((error) => error ? reject(error) : resolve());
    })]);
    const failures = [...results, ...closed].filter((result) => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'Manager MCP cleanup failed');
  };
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => { listener.removeListener('error', reject); resolve(); });
    });
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('Manager MCP endpoint has no TCP address');
    const config: McpHttpServerConfig = {
      type: 'http', url: `http://127.0.0.1:${address.port}/`,
      headers: {
        authorization,
        [MANAGER_ASSIGNMENT_HEADER]: Buffer.from(JSON.stringify(assignment ?? { kind: 'repository', repositoryDirectory: cwd }), 'utf8').toString('base64url'),
      },
    };
    return { ...connection, config, invalidate, dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Manager MCP startup and cleanup failed'); }
    throw error;
  }
}
