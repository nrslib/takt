import type {
  WorkflowCallStep,
  WorkflowSubworkflowParamConfig,
} from '../../core/models/workflow-types.js';

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

const facetParamWithCompanionDefault: WorkflowSubworkflowParamConfig = {
  type: 'facet_ref',
  facetKind: 'instruction',
  // @ts-expect-error facet defaults cannot contain companion selections.
  default: { fixed: ['reviewer'], pool: [], moderator: 'moderator' },
};

void facetParamWithCompanionDefault;
