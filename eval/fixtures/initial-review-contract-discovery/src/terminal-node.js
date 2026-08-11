function terminalHeading(node) {
  return `${node.name} [${node.worker ?? node.name}]`;
}

export function printNode(node) {
  return node.kind === 'control'
    ? `${terminalHeading(node)} -> ${node.child}`
    : terminalHeading(node);
}
