import type { WorkflowTemplateReference } from '../../core/models/index.js';

const nestedReferences: WorkflowTemplateReference[] = [
  '{structured:plan.payload.action}',
  '{effect:comment_on_pr.comment_pr.result.id}',
];

void nestedReferences;
