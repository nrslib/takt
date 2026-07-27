import type { WorkflowCallStep } from '../../core/models/workflow-types.js';

const workflowCallStep: WorkflowCallStep = {
  name: 'delegate',
  kind: 'workflow_call',
  call: 'child',
  personaDisplayName: 'delegate',
  instruction: '',
  // @ts-expect-error workflow_call steps never receive a previous agent response.
  passPreviousResponse: false,
};

void workflowCallStep;
