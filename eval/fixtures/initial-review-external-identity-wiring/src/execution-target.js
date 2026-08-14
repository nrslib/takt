import { resolveExternalTarget } from './target-lookup.js';

export function executeStep(workflow, step, config) {
  const target = resolveExternalTarget(step, config);
  return {
    target,
    terminal: `${target}:${workflow.name}/${step.name}`,
  };
}
