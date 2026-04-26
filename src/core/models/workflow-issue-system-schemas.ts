import { z } from 'zod/v4';

const SystemInputBindingSchema = z.object({
  as: z.string().min(1),
});

export const IssueListSystemInputRawSchema = SystemInputBindingSchema.extend({
  type: z.literal('issue_list'),
  source: z.literal('current_project'),
  exclude_selected_from: z.string().min(1).optional(),
}).strict();

export const IssueSelectionSystemInputRawSchema = SystemInputBindingSchema.extend({
  type: z.literal('issue_selection'),
  source: z.literal('current_project'),
}).strict();
