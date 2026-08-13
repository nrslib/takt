export function resolveExecutionTarget(workflow, step, config) {
  return config.stepTargets[step.name] ?? config.defaultTarget;
}

export function executeStep(workflow, step, config) {
  const target = resolveExecutionTarget(workflow, step, config);
  return {
    target,
    terminal: `${target}:${workflow.name}/${step.name}`,
  };
}
