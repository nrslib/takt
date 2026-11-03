import { createTaktMcpServer } from '../mcp/server.js';
import { startLocalMcpConnection, type LocalMcpConnection } from '../mcp/localConnection.js';
import { MANAGER_ASSIGNMENT_HEADER, managerAssignmentSchema, type ManagerAssignmentIdentity } from './assignment.js';
import type { McpHttpServerConfig } from '../../core/models/workflow-provider-options.js';

export type ManagerMcpConnection = LocalMcpConnection;

export async function startManagerMcpConnection(cwd: string, assignment?: ManagerAssignmentIdentity) {
  const connection = await startLocalMcpConnection((request, goalExecutionConnection) => {
    const raw = request.headers[MANAGER_ASSIGNMENT_HEADER];
    if (typeof raw !== 'string') throw new Error('Missing assignment');
    const managerAssignment = managerAssignmentSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd, managerAssignment, goalExecutionConnection });
  });
  const config: McpHttpServerConfig = { ...connection.config, headers: { ...connection.config.headers,
    [MANAGER_ASSIGNMENT_HEADER]: Buffer.from(JSON.stringify(assignment ?? { kind: 'repository', repositoryDirectory: cwd }), 'utf8').toString('base64url'),
  } };
  return { ...connection, config };
}
