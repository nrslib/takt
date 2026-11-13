import { z } from 'zod/v4';

export const EpicEventSchema = z.object({
  kind: z.enum(['epic_verification_result', 'epic_completed']),
  workspaceId: z.uuid(), epicId: z.uuid(), revision: z.number().int().positive(), runId: z.uuid(),
  operation: z.object({ reason: z.string().trim().min(1) }).strict().optional(),
}).strict();
export type EpicEvent = z.infer<typeof EpicEventSchema>;

export const PatrolEventSchema = z.object({
  kind: z.literal('patrol'), repositoryDirectory: z.string().min(1).optional(), goalIds: z.array(z.uuid()),
  workspaceId: z.uuid().optional(), epicIds: z.array(z.uuid()).min(1).optional(),
}).strict().refine((event) => (event.repositoryDirectory !== undefined && event.goalIds.length > 0
  || event.workspaceId !== undefined && event.epicIds !== undefined) && (event.goalIds.length === 0 || event.repositoryDirectory !== undefined));
