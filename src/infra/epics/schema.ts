import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const EpicIdSchema = z.uuid();
const text = z.string().trim().min(1);
const revision = z.number().int().safe().positive();
const directory = z.string().min(1).refine(isAbsolute);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/u);

const EpicMemberSchema = z.object({ repositoryDirectory: directory, goalId: z.uuid() }).strict();
const EpicTargetSchema = EpicMemberSchema.extend({ targetSha: sha });
export type EpicMember = z.infer<typeof EpicMemberSchema>;
export type EpicTarget = z.infer<typeof EpicTargetSchema>;

const criterionSchema = z.object({ id: text, description: text }).strict();
const criteriaSchema = z.array(criterionSchema).min(1).refine(
  (criteria) => new Set(criteria.map(({ id }) => id)).size === criteria.length,
  'Acceptance criterion IDs must be unique',
);
export const EpicDefinitionSchema = z.object({
  objective: text,
  acceptanceCriteria: criteriaSchema,
  verificationProcedure: z.object({
    version: revision,
    steps: z.array(text).min(1),
    terraform: z.object({ requiresApply: z.boolean() }).strict().optional(),
  }).strict(),
}).strict();
export type EpicDefinition = z.infer<typeof EpicDefinitionSchema>;

export const EpicVerificationResultSchema = z.object({
  runId: EpicIdSchema,
  revision,
  targets: z.array(EpicTargetSchema).min(1),
  procedureVersion: revision,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  outcome: z.enum(['succeeded', 'failed']),
  environment: z.object({ name: text, description: text }).strict(),
  artifacts: z.array(z.object({ reference: text, sources: z.array(EpicTargetSchema).min(1) }).strict()).min(1),
  workspace: z.object({ directory, artifactReferences: z.array(text).min(1) }).strict(),
  acceptanceResults: z.array(z.object({ criterionId: text, outcome: z.enum(['passed', 'failed']) }).strict()),
  logReferences: z.array(text).optional(),
  terraform: z.object({
    phase: z.enum(['plan', 'post_apply']),
    applyStatus: z.enum(['not_applied', 'applied', 'failed']),
    artifactReferences: z.array(text).min(1),
  }).strict().optional(),
}).strict().superRefine((result, ctx) => {
  if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
    ctx.addIssue({ code: 'custom', path: ['completedAt'], message: 'Verification cannot finish before it starts' });
  }
});
export type EpicVerificationResult = z.infer<typeof EpicVerificationResultSchema>;

const EpicVerificationRunSchema = z.object({
  id: EpicIdSchema,
  revision,
  targets: z.array(EpicTargetSchema).min(1),
  definition: EpicDefinitionSchema,
  procedureVersion: revision,
  startedAt: z.iso.datetime(),
  status: z.enum(['running', 'succeeded', 'failed', 'superseded', 'stale']),
  invalidationReason: text.optional(),
  result: EpicVerificationResultSchema.optional(),
}).strict().superRefine((run, ctx) => {
  if (run.definition.verificationProcedure.terraform !== undefined
    && run.result !== undefined && run.result.terraform === undefined) {
    ctx.addIssue({ code: 'custom', path: ['result', 'terraform'], message: 'Terraform verification requires a Terraform record' });
  }
});
export type EpicVerificationRun = z.infer<typeof EpicVerificationRunSchema>;

const EpicChangeSchema = z.object({
  kind: z.enum(['created', 'definition', 'member_added', 'member_removed', 'member_replaced', 'targets', 'aborted']),
  reason: text,
  recordedAt: z.iso.datetime(),
  member: EpicMemberSchema.optional(),
  replacement: EpicMemberSchema.optional(),
  definition: EpicDefinitionSchema.optional(),
  targets: z.array(EpicTargetSchema).optional(),
}).strict();
export type EpicChange = z.infer<typeof EpicChangeSchema>;

export const EpicSchema = EpicDefinitionSchema.extend({
  id: EpicIdSchema,
  workspaceId: EpicIdSchema,
  revision,
  status: z.enum(['active', 'completed', 'aborted']),
  members: z.array(EpicMemberSchema),
  targets: z.array(EpicTargetSchema),
  verificationRuns: z.array(EpicVerificationRunSchema),
  changes: z.array(EpicChangeSchema).min(1),
}).strict().superRefine((epic, ctx) => {
  const memberKeys = epic.members.map((member) => JSON.stringify([member.repositoryDirectory, member.goalId]));
  if (new Set(memberKeys).size !== memberKeys.length) {
    ctx.addIssue({ code: 'custom', path: ['members'], message: 'Epic members must be unique' });
  }
  if (new Set(epic.verificationRuns.map(({ id }) => id)).size !== epic.verificationRuns.length) {
    ctx.addIssue({ code: 'custom', path: ['verificationRuns'], message: 'Verification run IDs must be unique' });
  }
});
export type Epic = z.infer<typeof EpicSchema>;
export type EpicView = Epic & { currentEvidence?: EpicVerificationRun; runningVerification?: EpicVerificationRun };

export const EpicOwnerSchema = z.object({ globalConfigDirectory: directory, workspaceId: EpicIdSchema }).strict();
export const EpicContextSchema = EpicOwnerSchema.extend({ epicId: EpicIdSchema });
export type EpicOwner = z.infer<typeof EpicOwnerSchema>;
export type EpicContext = z.infer<typeof EpicContextSchema>;
export const EpicCreateSchema = EpicOwnerSchema.extend({ ...EpicDefinitionSchema.shape, reason: text });
export const EpicMemberChangeSchema = EpicContextSchema.extend({ member: EpicMemberSchema, reason: text });
export const EpicMemberReplaceSchema = EpicMemberChangeSchema.extend({ replacement: EpicMemberSchema });
export const EpicDefinitionChangeSchema = EpicContextSchema.extend({ changes: EpicDefinitionSchema.partial(), reason: text });
export const EpicReasonSchema = EpicContextSchema.extend({ reason: text });
export const EpicResultInputSchema = EpicContextSchema.extend({ result: EpicVerificationResultSchema });
