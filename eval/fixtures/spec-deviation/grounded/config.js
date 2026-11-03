export function resolve(project, global) {
  const value = project.registered ? project.value : undefined;
  return project.value !== undefined && value !== undefined ? value : global.value;
}

export function existingKey(project, global) {
  return project.value !== undefined ? project.value : global.value;
}

export const workflow_command_gates = existingKey;
export const workflow_runtime_prepare = existingKey;
