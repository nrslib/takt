import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { EpicCreateSchema, EpicContextSchema, EpicDefinitionChangeSchema, EpicMemberChangeSchema,
  EpicMemberReplaceSchema, EpicReasonSchema, EpicResultInputSchema } from '../../infra/epics/schema.js';

const paging = {
  cwd: z.string().refine(isAbsolute),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(50).optional(),
  path: z.string().min(1).optional(), textOffset: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().min(1).max(4096).optional(),
};
const reason = EpicReasonSchema.shape.reason;
const owner = { globalConfigDirectory: true, workspaceId: true } as const;
export const epicSchemas = {
  takt_create_epic: EpicCreateSchema.omit(owner).extend(paging),
  takt_get_epic: EpicContextSchema.omit(owner).extend(paging),
  takt_list_epics: z.object(paging).strict(),
  takt_update_epic_definition: EpicDefinitionChangeSchema.omit(owner).extend(paging),
  takt_add_epic_member: EpicMemberChangeSchema.omit(owner).extend(paging),
  takt_remove_epic_member: EpicMemberChangeSchema.omit(owner).extend(paging),
  takt_replace_epic_member: EpicMemberReplaceSchema.omit(owner).extend(paging),
  takt_refresh_epic_targets: EpicReasonSchema.omit(owner).extend(paging),
  takt_start_epic_verification: EpicContextSchema.omit(owner).extend({ ...paging, reason }),
  takt_record_epic_verification_result: EpicResultInputSchema.omit(owner).extend({ ...paging, reason }),
  takt_complete_epic: EpicContextSchema.omit(owner).extend({ ...paging, reason }),
  takt_abort_epic: EpicReasonSchema.omit(owner).extend(paging),
  takt_get_epic_verification_recovery: EpicContextSchema.omit(owner).extend(paging),
};
export type EpicToolName = keyof typeof epicSchemas;
