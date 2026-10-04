export function catalogRow(node) {
  return {
    label: node.name,
    worker: node.worker ?? node.name,
  };
}
