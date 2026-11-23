const workspaces = new Map();

export function registerWorkspace(goalId, workspace) {
  workspaces.set(goalId, workspace);
}

export function removeWorkspace(goalId) {
  workspaces.delete(goalId);
}

export function hasWorkspace(goalId) {
  return workspaces.has(goalId);
}
