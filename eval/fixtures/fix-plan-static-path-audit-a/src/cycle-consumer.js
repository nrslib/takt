export function findWorkflowCycle(config, entry) {
  const path = [];
  const visiting = new Set();

  function visit(name) {
    if (visiting.has(name)) {
      const start = path.indexOf(name);
      return path.slice(start).concat(name);
    }

    const children = config.workflow.calls[name];
    if (!Array.isArray(children)) {
      throw new Error(`Unknown workflow node: ${name}`);
    }
    visiting.add(name);
    path.push(name);
    for (const child of children) {
      const cycle = visit(child);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    visiting.delete(name);
    return undefined;
  }

  const cycle = visit(entry);
  return {
    entry,
    cycle: cycle ?? [],
    terminal: cycle === undefined ? 'no cycle' : 'cycle path',
  };
}
