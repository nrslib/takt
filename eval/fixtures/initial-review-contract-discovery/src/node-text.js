function heading(node) {
  return `${node.name} [${node.worker ?? node.name}]`;
}

export function printNode(node) {
  return node.kind === 'control'
    ? `${heading(node)} -> ${node.child}`
    : heading(node);
}
