export function findCycle(workflow) {
  const visited = [];
  let current = workflow.entry;
  while (!visited.includes(current)) {
    visited.push(current);
    const next = workflow.calls[current]?.[0];
    if (next === undefined) return [];
    current = next;
  }
  return [...visited.slice(visited.indexOf(current)), current];
}
