const activeConnections = new Set();

export function connect(goalId) {
  activeConnections.add(goalId);
}

export async function closeConnection(goalId) {
  if (goalId === 'temporarily-unavailable') {
    throw new Error('Connection close failed');
  }
  activeConnections.delete(goalId);
}

export function hasConnection(goalId) {
  return activeConnections.has(goalId);
}
