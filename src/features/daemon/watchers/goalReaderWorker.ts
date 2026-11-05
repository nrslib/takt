import { parentPort } from 'node:worker_threads';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { GoalIdSchema, GoalSchema } from '../../../infra/goals/schema.js';
import type { GoalReadReply, WatchGoal } from './goalReader.js';

const port = parentPort;
if (port === null) throw new Error('Goal reader requires a worker port');
let reading = Promise.resolve();
port.on('message', (request: { id: number; cwd: string; goalId: string }) => {
  reading = reading.then(async () => {
    let reply: GoalReadReply;
    try {
      const file = await open(join(request.cwd, '.takt', 'goals', GoalIdSchema.parse(request.goalId), 'goal.json'),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let text;
      try {
        if (!(await file.stat()).isFile()) throw new Error('Goal file is not regular');
        text = await file.readFile('utf8');
      } finally {
        await file.close();
      }
      const goal = GoalSchema.parse(JSON.parse(text) as unknown);
      if (goal.id !== request.goalId) throw new Error('Goal ID differs from its directory');
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
      reply = { id: request.id, ok: true, goal: value };
    } catch (error) {
      reply = { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    port.postMessage(reply);
  });
});
