/**
 * Task module type definitions
 */

import type { TaskFileData } from './schema.js';
import type { TaskFailure, TaskStatus } from './schema.js';

/** タスク情報 */
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

/** タスク実行結果 */
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
}

export interface WorktreeOptions {
  /** worktree setting: true = auto path, string = custom path */
  worktree: boolean | string;
  /** Branch name (optional, auto-generated if omitted) */
  branch?: string;
  /** Task slug for auto-generated paths/branches */
  taskSlug: string;
  /** GitHub Issue number (optional, for formatting branch/path) */
  issueNumber?: number;
}

export interface WorktreeResult {
  /** Absolute path to the clone */
  path: string;
  /** Branch name used */
  branch: string;
}

/** Branch info from `git branch --list` */
export interface BranchInfo {
  branch: string;
  commit: string;
  worktreePath?: string; // Path to worktree directory (for worktree-sessions branches)
}

/** Branch with list metadata */
export interface BranchListItem {
  info: BranchInfo;
  filesChanged: number;
  taskSlug: string;
  /** Original task instruction extracted from first commit message */
  originalInstruction: string;
}

export interface SummarizeOptions {
  /** Working directory for Claude execution */
  cwd: string;
  /** Model to use (optional, defaults to config or haiku) */
  model?: string;
  /** Use LLM for summarization. Defaults to config.branchNameStrategy === 'ai'. If false, uses romanization. */
  useLLM?: boolean;
}

/** pending/failedタスクのリストアイテム */
export interface TaskListItem {
  kind: 'pending' | 'running' | 'completed' | 'failed';
  name: string;
  createdAt: string;
  filePath: string;
  content: string;
  summary?: string;
  branch?: string;
  worktreePath?: string;
  data?: TaskFileData;
  failure?: TaskFailure;
  startedAt?: string;
  completedAt?: string;
  ownerPid?: number;
}
