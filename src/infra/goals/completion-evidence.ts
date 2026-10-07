import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import { hostProjectStateDirectory } from '../config/host-state.js';
import { TaskStore } from '../task/store.js';
import type { TaskRecord } from '../task/schema.js';
import { readPrivateFileState, writePrivateFile } from '../../shared/utils/private-file.js';
import { runPrivateFileExclusive } from '../../shared/utils/private-file-lock.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { recordManagerRunFailure } from '../task/manager-run-state.js';
import { GoalIdSchema, GoalTaskResultSchema, type Goal } from './schema.js';

const CompletionSchema = z.object({ taskName: z.string().min(1), runSlug: z.string().min(1), result: GoalTaskResultSchema }).strict();
const EvidenceSchema = CompletionSchema.extend({
  projectRoot: z.string(), goalId: GoalIdSchema, processed: z.boolean(), summary: z.string().optional(),
  session: z.object({ provider: z.string(), sessionId: z.string().min(1) }).strict().optional(),
}).strict();
type GoalCompletion = z.infer<typeof CompletionSchema>;
type Evidence = z.infer<typeof EvidenceSchema>;
type GoalEvent = NonNullable<Goal['events']>[number];

function normalizedResult(result: GoalCompletion['result']): GoalCompletion['result'] {
  return GoalTaskResultSchema.parse(JSON.parse(JSON.stringify(result)) as unknown);
}

function evidencePath(cwd: string, id: string, completion: Pick<GoalCompletion, 'taskName' | 'runSlug'>): string {
  const key = createHash('sha256').update(JSON.stringify([GoalIdSchema.parse(id), completion.taskName, completion.runSlug])).digest('hex');
  return join(hostProjectStateDirectory(cwd, 'goal-completions'), `${key}.json`);
}

function readEvidence(cwd: string, id: string, completion: Pick<GoalCompletion, 'taskName' | 'runSlug'>): Evidence {
  const saved = readPrivateFileState(evidencePath(cwd, id, completion));
  if (!('content' in saved)) throw new Error(`Goal completion evidence is missing: ${completion.taskName} / ${completion.runSlug}`);
  const evidence = EvidenceSchema.parse(JSON.parse(saved.content.toString('utf8')) as unknown);
  if (evidence.projectRoot !== realpathSync(cwd) || evidence.goalId !== id
    || evidence.taskName !== completion.taskName || evidence.runSlug !== completion.runSlug) {
    throw new Error(`Goal completion differs from the saved result: ${completion.taskName} / ${completion.runSlug}`);
  }
  return evidence;
}

function assertCompletionResult(evidence: Evidence, completion: GoalCompletion): void {
  if (!isDeepStrictEqual(evidence.result, normalizedResult(completion.result))) {
    throw new Error(`Goal completion differs from the saved result: ${completion.taskName} / ${completion.runSlug}`);
  }
}

// Only the result writer calls this, using the record it has just persisted.
export function saveGoalCompletionEvidence(cwd: string, task: TaskRecord): void {
  if (task.goal_id === undefined || task.completion === undefined) return;
  if (task.run_slug === undefined) throw new Error(`Completed goal task has no run identifier: ${task.name}`);
  const completion = CompletionSchema.parse({ taskName: task.name, runSlug: task.run_slug, result: normalizedResult(task.completion) });
  const path = evidencePath(cwd, task.goal_id, completion);
  runPrivateFileExclusive(`${path}.lock`, () => {
    if ('content' in readPrivateFileState(path)) {
      assertCompletionResult(readEvidence(cwd, task.goal_id!, completion), completion);
      return;
    }
    writePrivateFile(path, JSON.stringify(EvidenceSchema.parse({
      ...completion, projectRoot: realpathSync(cwd), goalId: task.goal_id, processed: false,
    })));
  });
}

function verifyGoalCompletion(cwd: string, id: string, completion: Pick<GoalCompletion, 'taskName' | 'runSlug'>): Evidence {
  const evidence = readEvidence(cwd, id, completion);
  const task = new TaskStore(cwd).read().tasks.find((task) => task.name === completion.taskName && task.goal_id === id);
  if (task === undefined) throw new Error(`Goal completion has no corresponding task: ${completion.taskName}`);
  // Retries clear or replace the current result; the host record retains the previous run.
  if (task.run_slug === completion.runSlug
    && (task.completion === undefined || !isDeepStrictEqual(normalizedResult(task.completion), evidence.result))) {
    throw new Error(`Task result differs from its completion evidence: ${completion.taskName}`);
  }
  return evidence;
}

function evidenceEvent(evidence: Evidence): GoalEvent {
  return {
    taskName: evidence.taskName, runSlug: evidence.runSlug, result: evidence.result,
    processed: evidence.processed, ...(evidence.summary === undefined ? {} : { summary: evidence.summary }),
  };
}

export function verifiedGoalCompletionContext(cwd: string, goal: Goal): Goal {
  const events: GoalEvent[] = [];
  const sessions: NonNullable<Goal['sessions']> = [];
  for (const event of goal.events ?? []) {
    if (events.some((saved) => saved.taskName === event.taskName && saved.runSlug === event.runSlug)) continue;
    try {
      const evidence = verifyGoalCompletion(cwd, goal.id, event);
      events.push(evidenceEvent(evidence));
      if (evidence.session !== undefined) {
        const index = sessions.findIndex((session) => session.provider === evidence.session!.provider);
        if (index === -1) sessions.push(evidence.session);
        else sessions[index] = evidence.session;
      }
    } catch (error) {
      recordManagerRunFailure(cwd, new Error(`Cannot verify goal completion ${goal.id}: ${getErrorMessage(error)}`));
    }
  }
  return {
    ...goal,
    ...(goal.events === undefined && events.length === 0 ? {} : { events }),
    sessions,
  };
}

export function markGoalCompletionProcessed(cwd: string, id: string, completion: GoalCompletion, summary: string, session: Evidence['session']): void {
  const path = evidencePath(cwd, id, completion);
  runPrivateFileExclusive(`${path}.lock`, () => {
    const evidence = verifyGoalCompletion(cwd, id, completion);
    assertCompletionResult(evidence, completion);
    writePrivateFile(path, JSON.stringify(EvidenceSchema.parse({ ...evidence, processed: true, summary, session })));
  });
}

export function goalCompletionEvent(cwd: string, id: string, completion: GoalCompletion): GoalEvent {
  const evidence = verifyGoalCompletion(cwd, id, completion);
  assertCompletionResult(evidence, completion);
  return evidenceEvent(evidence);
}
