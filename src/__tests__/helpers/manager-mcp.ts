import { connectManagerMcp } from '../../features/manager/managerMcp.js';
import { TurnToolScope } from '../../features/daemonTurn/toolScope.js';
import type { ManagerAssignmentIdentity } from '../../features/manager/assignment.js';
import type { McpServerConfig } from '../../core/models/index.js';

export async function connectTestManagerMcp(cwd: string, assignment?: ManagerAssignmentIdentity,
  servers?: Record<string, McpServerConfig>) {
  const scope = new TurnToolScope();
  const controller = new AbortController();
  scope.begin(controller.signal);
  const connection = await connectManagerMcp(cwd, assignment ?? { kind: 'repository', repositoryDirectory: cwd }, servers, { turnScope: scope,
  });
  return { ...connection, async dispose() { controller.abort(); await scope.end(); await connection.dispose(); } };
}
