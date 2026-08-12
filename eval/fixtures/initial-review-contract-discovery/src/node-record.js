export function nodeRecord(node) {
  return {
    kind: node.kind,
    name: node.name,
    worker: node.worker ?? node.name,
    child: node.child,
  };
}
