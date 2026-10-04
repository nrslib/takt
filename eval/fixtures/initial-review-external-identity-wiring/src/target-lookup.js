export function resolveExternalTarget(step, config) {
  return config.stepTargets[step.name] ?? config.defaultTarget;
}
