export function summarizeNode(node) {
  if (node.kind === 'control') return { kind: 'control', name: node.name, child: node.child };
  return { kind: 'task', name: node.name, worker: node.worker };
}
