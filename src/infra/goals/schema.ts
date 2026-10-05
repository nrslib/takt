import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import { isValidLocalBranchName } from '../../shared/utils/gitBranchValidation.js';

const goalText = z.string().max(128 * 1024).refine((value) => value.trim().length > 0);
const goalBranch = z.string().refine(isValidLocalBranchName);
export const GoalIdSchema = z.uuid();

const summaryShape = {
  objective: goalText,
  outOfScope: z.array(goalText),
  acceptanceCriteria: z.array(goalText).min(1),
  creationOrigin: z.enum(['human', 'director']),
};

const confirmationShape = {
  confirmedAt: z.iso.datetime(),
  confirmedBy: goalText,
};

const GoalSummarySchema = z.object({
  ...summaryShape,
  startBranch: goalBranch.optional(),
  integrationBranch: goalBranch.optional(),
}).strict();

const SignedGoalConfirmationSchema = z.object({
  payload: z.string().min(1).max(512 * 1024),
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(128),
}).strict();

export const GoalConfirmationPayloadSchema = GoalSummarySchema.extend({
  id: GoalIdSchema,
  projectRoot: z.string().refine(isAbsolute),
  ...confirmationShape,
});

export const GoalCreateInputSchema = GoalSummarySchema.extend({
  cwd: z.string().refine(isAbsolute),
  confirmation: SignedGoalConfirmationSchema,
});

export const GoalSchema = z.object({
  id: GoalIdSchema,
  ...summaryShape,
  mode: z.literal('local'),
  status: z.literal('created'),
  branch: goalBranch,
  startBranch: goalBranch,
  integrationBranch: goalBranch,
  confirmation: z.object(confirmationShape).strict(),
}).strict();

export type Goal = z.infer<typeof GoalSchema>;
export type GoalCreateInput = z.infer<typeof GoalCreateInputSchema>;
