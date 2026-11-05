import { z } from 'zod/v4';
import { runStepIdentity, RunStepExecutionsSchema, type RunStepExecution } from '../../../core/workflow/run/step-executions.js';
import { isMissing, readSmallJson } from './files.js';

const frame = z.object({ workflow: z.string().min(1), workflow_ref: z.string().min(1), step: z.string().min(1),
  occurrence: z.number().int().positive(), step_iterations: z.record(z.string().min(1), z.number().int().positive()).optional() });
const metadata = z.object({ runSlug: z.string().min(1), status: z.enum(['running', 'completed', 'failed', 'aborted']),
  startTime: z.iso.datetime(), stepExecutions: RunStepExecutionsSchema.optional(),
  resume_point: z.object({ stack: z.array(frame).min(1) }).optional() });

export interface RunProgress {
  runSlug: string;
  running: boolean;
  startedAt: string;
  steps: RunStepExecution[];
}

/** meta.json は上限付きで読み、全体の反復数ではなく各エンジンの段階別の回数を使う。 */
export async function readRunProgress(path: string): Promise<RunProgress | undefined> {
  let value;
  try { value = await readSmallJson(path); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  const meta = metadata.parse(value);
  if (meta.stepExecutions !== undefined) {
    return { runSlug: meta.runSlug, running: meta.status === 'running', startedAt: meta.startTime, steps: meta.stepExecutions };
  }
  // 旧 run には累積回数がないため、保存済みの各フレームの回数だけを証拠にする。
  const stack = meta.resume_point?.stack ?? [];
  const steps: RunProgress['steps'] = [];
  for (const [index, entry] of stack.entries()) {
    for (const [step, count] of Object.entries(entry.step_iterations ?? { [entry.step]: entry.occurrence })) {
      steps.push({ ...runStepIdentity(stack.slice(0, index + 1), entry.workflow, step), count });
    }
  }
  return { runSlug: meta.runSlug, running: meta.status === 'running', startedAt: meta.startTime, steps };
}
