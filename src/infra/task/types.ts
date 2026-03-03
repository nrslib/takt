import type { TaskFileData } from './schema.js';
import type { TaskFailure, TaskStatus } from './schema.js';

export interface TaskInfo {
  filePath: string;
  name: string;
  slug?: string;
  content: string;
  taskDir?: string;
  createdAt: string;
  status: TaskStatus;
  worktreePath?: string;
  data: TaskFileData | null;
}

export interface TaskResult {
  task: TaskInfo;
  success: boolean;
  response: string;
  executionLog: string[];
  failureMovement?: string;
  failureLastMessage?: string;
  startedAt: string;
  completedAt: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
}

export interface WorktreeOptions {
  worktree: boolean | string;
  branch?: string;
  baseBranch?: string;
  taskSlug: string;
  issueNumber?: number;
}

export interface WorktreeResult {
  path: string;
  branch: string;
}

export interface BranchInfo {
  branch: string;
  commit: string;
  worktreePath?: string;
}

export interface BranchListItem {
  info: BranchInfo;
  filesChanged: number;
  taskSlug: string;
  originalInstruction: string;
}

export interface SummarizeOptions {
  cwd: string;
  model?: string;
  useLLM?: boolean;
}

export interface TaskListItem {
  kind: 'pending' | 'running' | 'completed' | 'failed' | 'exceeded';
  name: string;
  createdAt: string;
  filePath: string;
  content: string;
  summary?: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  data?: TaskFileData;
  failure?: TaskFailure;
  startedAt?: string;
  completedAt?: string;
  ownerPid?: number;
  issueNumber?: number;
  exceededMaxMovements?: number;
  exceededCurrentIteration?: number;
}
