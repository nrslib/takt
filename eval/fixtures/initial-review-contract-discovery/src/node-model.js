export function taskNode(name, worker) {
  return { kind: 'task', name, worker };
}

export function controlNode(name, child) {
  return { kind: 'control', name, child };
}
