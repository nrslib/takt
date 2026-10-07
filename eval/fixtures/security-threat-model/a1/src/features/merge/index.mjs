import { withPrHead } from '../pr/clone.mjs';
import { runWorkflowExecution } from '../../core/workflow.mjs';

export function mergePr({ repository, prNumber, provider, mode }) {
  const workflow = mode === 'review' ? 'merge-review.yaml' : 'merge-review-fix.yaml';
  return withPrHead(repository, prNumber, (cwd) =>
    runWorkflowExecution({ cwd, workflow, provider }));
}
