import type {
  WorkflowCallArgValue,
  WorkflowCallStep,
  WorkflowRule,
} from '../../core/models/types.js';

export function makeNormalizedWorkflowCallStep(input: {
  name: string;
  call: string;
  description?: string;
  args?: Record<string, WorkflowCallArgValue>;
  rules?: WorkflowRule[];
}): WorkflowCallStep {
  return {
    name: input.name,
    description: input.description,
    kind: 'workflow_call',
    call: input.call,
    args: input.args,
    personaDisplayName: input.name,
    instruction: '',
    rules: input.rules,
  };
}
