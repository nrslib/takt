import { withPrHead } from '../pr/clone.mjs';
import { runWorkflowExecution } from '../../core/workflow.mjs';

export function reviewCacciaPr({ repository, prNumber, provider }) {
  return withPrHead(repository, prNumber, (cwd) =>
    runWorkflowExecution({ cwd, workflow: 'caccia-review.yaml', provider }));
}
