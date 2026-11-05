import { z } from 'zod/v4';
import { runStepIdentity, RunStepExecutionsSchema, type RunStepExecution } from '../../../core/workflow/run/step-executions.js';

const frame = z.object({ workflow: z.string().min(1), workflow_ref: z.string().min(1), step: z.string().min(1),
  occurrence: z.number().int().positive(), step_iterations: z.record(z.string().min(1), z.number().int().positive()).optional() });
const resumePoint = z.object({ stack: z.array(frame).min(1) });
const metadata = z.object({ runSlug: z.string().min(1), status: z.enum(['running', 'completed', 'failed', 'aborted']),
  startTime: z.iso.datetime(), stepExecutions: RunStepExecutionsSchema.optional(),
  resume_point: resumePoint.optional(), resumePoint: resumePoint.optional(),
  resume_mode: z.string().min(1).optional(), source_run_slug: z.string().min(1).optional(),
  resumeMode: z.string().min(1).optional(), sourceRunSlug: z.string().min(1).optional() });

export interface RunProgress {
  runSlug: string;
  running: boolean;
  startedAt: string;
  steps: RunStepExecution[];
}

export function parseRunProgress(value: unknown): RunProgress {
  const meta = metadata.parse(value);
  if (meta.stepExecutions !== undefined) {
    return { runSlug: meta.runSlug, running: meta.status === 'running', startedAt: meta.startTime, steps: meta.stepExecutions };
  }
  // 再開した旧 run の frame は前の run の回数を含み、この run の実行回数を復元できない。
  const inherited = meta.resume_mode !== undefined || meta.source_run_slug !== undefined
    || meta.resumeMode !== undefined || meta.sourceRunSlug !== undefined;
  const stack = inherited ? [] : (meta.resumePoint ?? meta.resume_point)?.stack ?? [];
  const steps: RunProgress['steps'] = [];
  for (const [index, entry] of stack.entries()) {
    for (const [step, count] of Object.entries(entry.step_iterations ?? { [entry.step]: entry.occurrence })) {
      steps.push({ ...runStepIdentity(stack.slice(0, index + 1), entry.workflow, step), count });
    }
  }
  return { runSlug: meta.runSlug, running: meta.status === 'running', startedAt: meta.startTime, steps };
}
