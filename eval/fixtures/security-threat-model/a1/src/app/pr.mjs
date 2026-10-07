import { withPrHead } from '../features/pr/clone.mjs';
import { runWorkflowExecution } from '../core/workflow.mjs';

export function reviewPr({ repository, prNumber, provider }) {
  return withPrHead(repository, prNumber, (cwd) =>
    runWorkflowExecution({ cwd, workflow: 'review.yaml', provider }));
}
