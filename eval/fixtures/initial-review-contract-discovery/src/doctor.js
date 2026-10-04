export function diagnoseNode(node) {
  const details = {
    name: node.name,
    worker: node.worker ?? node.name,
  };
  if (node.kind === 'control') details.child = node.child;
  return details;
}
