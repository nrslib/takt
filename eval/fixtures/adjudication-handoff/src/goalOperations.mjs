import { removeWorkspace } from './workspaceRegistry.mjs';
import { closeConnection } from './managerMcpConnection.mjs';

export async function completeGoal(goalId) {
  removeWorkspace(goalId);
  await closeConnection(goalId);
}
