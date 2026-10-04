import { resolveExternalTarget } from './target-lookup.js';

export function previewStep(workflow, step, config) {
  const target = resolveExternalTarget(step, config);
  return `${workflow.name}/${step.name} -> ${target}`;
}
