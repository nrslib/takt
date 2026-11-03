import { randomUUID } from 'node:crypto';
import { connectManagerMcp } from '../../features/manager/managerMcp.js';
import { TurnToolScope } from '../../features/daemonTurn/toolScope.js';
import type { ManagerAssignmentIdentity } from '../../features/manager/assignment.js';
import type { McpServerConfig } from '../../core/models/index.js';

export async function connectTestManagerMcp(cwd: string, assignment?: ManagerAssignmentIdentity,
  servers?: Record<string, McpServerConfig>, options?: { enableGoalExecutionTools: boolean }) {
  const scope = new TurnToolScope();
  const controller = new AbortController();
  scope.begin(controller.signal);
  const operationId = randomUUID();
  const connection = await connectManagerMcp(cwd, assignment ?? { kind: 'repository', repositoryDirectory: cwd }, servers, {
    enableGoalExecutionTools: options?.enableGoalExecutionTools ?? true, turnScope: scope,
    conversationTurn: () => ({ operationId: operationId, directorMessage: false }),
  });
  return { ...connection, async dispose() { controller.abort(); await scope.end(); await connection.dispose(); } };
}
