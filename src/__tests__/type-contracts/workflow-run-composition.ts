import {
  createWorkflowRunComposition,
  type WorkflowRunStorageCompositionInput,
} from '../../features/tasks/execute/workflowRunStorage.js';
import {
  createWorkflowRunStorageCompositionTestDouble,
} from '../helpers/run-storage.js';

declare const input: WorkflowRunStorageCompositionInput;

createWorkflowRunComposition(input);
createWorkflowRunStorageCompositionTestDouble(
  createWorkflowRunComposition,
  input,
  {
    sessionId: 'test-session',
    startedAt: '2026-08-01T00:00:00.000Z',
    projectTerminalArtifacts: false,
  },
);

// @ts-expect-error Workflow run composition no longer accepts a backend.
createWorkflowRunComposition('file', input);
