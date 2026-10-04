function heading(node) {
  return `${node.name} (worker: ${node.worker ?? node.name})`;
}

export function renderPreview(node) {
  const lines = [heading(node)];
  if (node.kind === 'control') {
    lines.push(`child: ${node.child}`);
    return lines.join('\n');
  }
  lines.push('executable: yes');
  return lines.join('\n');
}
