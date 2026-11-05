import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { WorkflowResumePointEntry } from '../../models/types.js';

export const RunStepExecutionsSchema = z.array(z.object({ identity: z.string().regex(/^[a-f0-9]{64}$/),
  workflow: z.string().min(1), step: z.string().min(1), count: z.number().int().positive() }).strict());
export type RunStepExecution = z.infer<typeof RunStepExecutionsSchema>[number];

/** 呼出箇所は区別し、同じ箇所からの子の再実行は同じ段階へ集計する。 */
export function runStepIdentity(stack: readonly Pick<WorkflowResumePointEntry, 'workflow' | 'workflow_ref' | 'step'>[],
  workflow: string, step: string): Omit<RunStepExecution, 'count'> {
  const leaf = stack.at(-1);
  const parents = stack.slice(0, -1).map((entry) => ({ workflow: entry.workflow_ref, step: entry.step }));
  const identity = createHash('sha256').update(JSON.stringify([parents, leaf?.workflow_ref ?? workflow, step])).digest('hex');
  return { identity, workflow: leaf?.workflow ?? workflow, step };
}
