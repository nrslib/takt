import {
  createWorkflowRunLifecycle,
  type WorkflowRunLifecycleCompositionInput,
} from '../../features/tasks/execute/workflowRunLifecycle.js';
import {
  createWorkflowRunLifecycleCompositionTestDouble,
} from '../helpers/run-lifecycle.js';

declare const input: WorkflowRunLifecycleCompositionInput;

createWorkflowRunLifecycle(input);
createWorkflowRunLifecycleCompositionTestDouble(
  createWorkflowRunLifecycle,
  input,
  {
    sessionId: 'test-session',
    startedAt: '2026-08-01T00:00:00.000Z',
    projectTerminalArtifacts: false,
  },
);

// @ts-expect-error Workflow run composition no longer accepts a backend.
createWorkflowRunLifecycle('file', input);
