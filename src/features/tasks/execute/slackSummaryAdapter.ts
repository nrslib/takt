/**
 * Adapts TaskListItem to SlackTaskDetail for Slack run summary notifications.
 */

import type { TaskListItem } from '../../../infra/task/index.js';
import type { SlackTaskDetail } from '../../../shared/utils/index.js';
import { DEFAULT_PIECE_NAME } from '../../../shared/constants.js';

export function generateRunId(): string {
  const now = new Date();
  const pad = (n: number, len: number): string => String(n).padStart(len, '0');
  return `run-${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}-${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
}

function computeTaskDurationSec(item: TaskListItem): number {
  if (!item.startedAt || !item.completedAt) {
    return 0;
  }
  return Math.round((new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime()) / 1000);
}

export function toSlackTaskDetail(item: TaskListItem): SlackTaskDetail {
  return {
    name: item.name,
    success: item.kind === 'completed',
    piece: item.data?.piece ?? DEFAULT_PIECE_NAME,
    issueNumber: item.data?.issue,
    durationSec: computeTaskDurationSec(item),
    branch: item.branch,
    worktreePath: item.worktreePath,
    prUrl: item.prUrl,
    failureMovement: item.failure?.movement,
    failureError: item.failure?.error,
    failureLastMessage: item.failure?.last_message,
  };
}
