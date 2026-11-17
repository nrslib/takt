import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { EpicSchema } from './schema.js';
import { epicVerificationRecovery, epicView, finishEpic } from './state.js';

const run = EpicSchema.shape.verificationRuns.element;
export const EpicSnapshotSchema = z.object({
  kind: z.literal('epic'),
  epic: EpicSchema.safeExtend({ currentEvidence: run.optional(), runningVerification: run.optional() }),
  memberProgress: z.array(z.object({ repositoryDirectory: z.string(), goalId: z.uuid(), status: z.string(), executionStatus: z.string() }).strict()),
  recovery: z.array(run),
}).strict().superRefine((item, ctx) => {
  const { currentEvidence, runningVerification, ...stored } = item.epic;
  const view = epicView(stored);
  if (!isDeepStrictEqual(currentEvidence, view.currentEvidence) || !isDeepStrictEqual(runningVerification, view.runningVerification)
    || !isDeepStrictEqual(item.recovery, epicVerificationRecovery(stored))) {
    ctx.addIssue({ code: 'custom', message: 'Epic projection differs from persisted evidence' });
  }
  if (stored.status === 'completed') {
    try { finishEpic(stored); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid completed Epic' }); }
  }
});
export type EpicSnapshot = z.infer<typeof EpicSnapshotSchema>;
