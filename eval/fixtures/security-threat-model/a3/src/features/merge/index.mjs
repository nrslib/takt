import { withPrHead } from '../pr/clone.mjs';
import { runWorkflowExecution } from '../../core/workflow.mjs';

export function mergePr({ repository, prNumber, provider, writeToken }) {
  return withPrHead(repository, prNumber, (cwd) =>
    runWorkflowExecution({
      cwd,
      workflow: 'merge-review-fix.yaml',
      provider,
      env: { ...process.env, GH_TOKEN: writeToken },
    }));
}
