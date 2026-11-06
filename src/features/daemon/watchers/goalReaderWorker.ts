import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { GoalSchema, type Goal } from '../../../infra/goals/schema.js';
import { goalPullRequestFailure } from '../../../infra/goals/pull-request-failure.js';
import { writePrivateFile } from '../../../infra/daemon/privateFile.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitive-text.js';
import type { WatchReadReply, WatchReadRequest, WatchGoal } from './goalReader.js';
import { watchGoalDirectory } from './goalPaths.js';

const port = parentPort;
if (port === null) throw new Error('Goal reader requires a worker port');
let reading = Promise.resolve();
port.on('message', (request: WatchReadRequest) => {
  reading = reading.then(async () => {
    let reply: WatchReadReply;
    try {
      switch (request.kind) {
        case 'goal':
          reply = { id: request.id, ok: true, kind: 'goal', goal: await readGoal(request.cwd, request.goalId) };
          break;
        case 'pr-retry-limit':
          reply = { id: request.id, ok: true, kind: 'pr-retry-limit', saved: await savePullRequestRetryLimit(request) };
          break;
      }
    } catch (error) {
      reply = { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    port.postMessage(reply);
  });
});

async function readStoredGoal(cwd: string, goalId: string): Promise<Goal> {
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
  return goal;
}

async function readGoal(cwd: string, goalId: string): Promise<WatchGoal> {
  const goal = await readStoredGoal(cwd, goalId);
  const failure = goalPullRequestFailure(goal);
  const pullRequestRetry = failure === undefined ? undefined : { failure,
    generation: createHash('sha256').update(JSON.stringify([failure.id, failure.goalSha, goal.branch, goal.integrationBranch, goal.completion])).digest('hex') };
  const value: WatchGoal = { id: goal.id, status: goal.status, executionStatus: goal.executionStatus,
    questions: goal.questions, pullRequest: goal.pullRequest, branch: goal.branch, integrationBranch: goal.integrationBranch,
    blockedNotifications: (goal.notifications ?? []).filter((entry) => entry.kind === 'blocked').map((entry) => entry.id).sort(),
    pullRequestRetry };
  return value;
}

async function savePullRequestRetryLimit(request: Extract<WatchReadRequest, { kind: 'pr-retry-limit' }>): Promise<boolean> {
  const { cwd, goalId, failureId, expectedSha, language } = request;
  const goal = await readStoredGoal(cwd, goalId);
  const failure = goalPullRequestFailure(goal);
  // A failure keeps the same notification identity even if saving the watch record is interrupted.
  const hash = createHash('sha256').update(JSON.stringify(['goal-pr-retry-limit', cwd, goalId, failureId])).digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  if (goal.notifications?.some((notice) => notice.id === id)) return true;
  if (failure?.id !== failureId || failure.goalSha !== expectedSha) return false;
  const saved = GoalSchema.parse({ ...goal, notifications: [...(goal.notifications ?? []), {
    id, recordedAt: new Date().toISOString(), kind: 'blocked', severity: 'error',
    body: getLabel('manager.goalPr.retryLimitReached', language, { reason: sanitizeSensitiveText(failure.error).replace(/\s+/gu, ' ').trim() }),
  }] });
  await writePrivateFile(join(await watchGoalDirectory(cwd, goalId), 'goal.json'), JSON.stringify(saved));
  return true;
}
