export function resolvePreviewTarget(workflow, step, config) {
  return config.stepTargets[step.name] ?? config.defaultTarget;
}

export function previewStep(workflow, step, config) {
  const target = resolvePreviewTarget(workflow, step, config);
  return `${workflow.name}/${step.name} -> ${target}`;
}
