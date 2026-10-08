import { execFileSync } from 'node:child_process';
import { withPrHead } from '../pr/clone.mjs';
import { runWorkflowExecution } from '../../core/workflow.mjs';

export function mergePr({ repository, prNumber, provider }) {
  return withPrHead(repository, prNumber, async (cwd) => {
    execFileSync('npm', ['install', '--ignore-scripts=false'], { cwd });
    return runWorkflowExecution({ cwd, workflow: 'merge-review-fix.yaml', provider });
  });
}
