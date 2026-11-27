import { completeGoal } from './goalOperations.mjs';
import { hasWorkspace } from './workspaceRegistry.mjs';
import { hasConnection } from './managerMcpConnection.mjs';

export async function retireGoal(goalId) {
  if (!hasWorkspace(goalId) || !hasConnection(goalId)) {
    throw new Error('Goal is not active');
  }
  await completeGoal(goalId);
}
