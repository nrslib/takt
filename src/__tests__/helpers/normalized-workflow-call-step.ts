import type {
  WorkflowCallArgValue,
  WorkflowCallOverrides,
  WorkflowCallStep,
  WorkflowRule,
} from '../../core/models/types.js';

export function makeNormalizedWorkflowCallStep(input: {
  name: string;
  call: string;
  description?: string;
  overrides?: WorkflowCallOverrides;
  args?: Record<string, WorkflowCallArgValue>;
  rules?: WorkflowRule[];
}): WorkflowCallStep {
  return {
    name: input.name,
    description: input.description,
    kind: 'workflow_call',
    call: input.call,
    overrides: input.overrides,
    args: input.args,
    personaDisplayName: input.name,
    instruction: '',
    rules: input.rules,
  };
}
