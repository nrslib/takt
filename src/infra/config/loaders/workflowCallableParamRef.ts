interface WorkflowParamReference {
  $param: string;
}

export type { WorkflowParamReference };

export function isWorkflowParamReference(value: unknown): value is WorkflowParamReference {
  return typeof value === 'object'
    && value !== null
    && '$param' in value
    && typeof (value as Record<string, unknown>).$param === 'string';
}
