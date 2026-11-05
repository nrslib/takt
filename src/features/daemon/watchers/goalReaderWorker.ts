import { parentPort } from 'node:worker_threads';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { GoalSchema } from '../../../infra/goals/schema.js';
import type { WatchReadReply, WatchReadRequest, WatchGoal } from './goalReader.js';
import { watchGoalDirectory } from './goalPaths.js';
import { parseRunProgress, type RunProgress } from './runProgress.js';
import { isMissing } from './files.js';

const port = parentPort;
if (port === null) throw new Error('Goal reader requires a worker port');
let reading = Promise.resolve();
port.on('message', (request: WatchReadRequest) => {
  reading = reading.then(async () => {
    let reply: WatchReadReply;
    try {
      reply = request.kind === 'goal'
        ? { id: request.id, ok: true, kind: 'goal', goal: await readGoal(request.cwd, request.goalId) }
        : { id: request.id, ok: true, kind: 'run', progress: await readRunProgress(request.path) };
    } catch (error) {
      reply = { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    port.postMessage(reply);
  });
});

async function readGoal(cwd: string, goalId: string): Promise<WatchGoal> {
  const directory = await watchGoalDirectory(cwd, goalId);
  const file = await open(join(directory, 'goal.json'),
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  let text;
  try {
    if (!(await file.stat()).isFile()) throw new Error('Goal file is not regular');
    text = await file.readFile('utf8');
  } finally {
    await file.close();
  }
  const goal = GoalSchema.parse(JSON.parse(text) as unknown);
  if (goal.id !== goalId) throw new Error('Goal ID differs from its directory');
  let lastUpdatedAt = goal.createdAt;
  for (const date of [
    ...goal.workLog.filter((entry) => entry.kind !== 'patrol').map((entry) => entry.recordedAt),
    ...(goal.questions ?? []).flatMap((question) => [question.createdAt, question.answer?.answeredAt, question.withdrawnAt]),
  ]) {
    if (date !== undefined && (lastUpdatedAt === undefined || Date.parse(date) > Date.parse(lastUpdatedAt))) lastUpdatedAt = date;
  }
  const value: WatchGoal = { id: goal.id, status: goal.status, executionStatus: goal.executionStatus,
    questions: goal.questions, pullRequest: goal.pullRequest, branch: goal.branch, integrationBranch: goal.integrationBranch,
    lastUpdatedAt, blockedNotifications: (goal.notifications ?? []).filter((entry) => entry.kind === 'blocked').map((entry) => entry.id).sort() };
  return value;
}

async function readRunProgress(path: string): Promise<RunProgress | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let text;
    try {
      if (!(await file.stat()).isFile()) throw new Error('Run metadata is not regular');
      text = await file.readFile('utf8');
    } finally { await file.close(); }
    return parseRunProgress(JSON.parse(text) as unknown);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
