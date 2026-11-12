import { parentPort } from 'node:worker_threads';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { GoalSchema, type Goal } from '../../../infra/goals/schema.js';
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
  const value: WatchGoal = { id: goal.id, status: goal.status, executionStatus: goal.executionStatus,
    questions: goal.questions, pullRequest: goal.pullRequest, branch: goal.branch, integrationBranch: goal.integrationBranch,
    blockedNotifications: (goal.notifications ?? []).filter((entry) => entry.kind === 'blocked').map((entry) => entry.id).sort() };

  return value;
}
