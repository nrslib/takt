/**
 * Task module type definitions
 */

import type { TaskFileData } from './schema.js';

/** タスク情報 */
export interface TaskInfo {
  filePath: string;
  name: string;
  content: string;
  createdAt: string;
  /** Structured data from YAML files (null for .md files) */
  data: TaskFileData | null;
}

/** タスク実行結果 */
export interface TaskResult {
  task: TaskInfo;
  success: boolean;
  response: string;
  executionLog: string[];
  startedAt: string;
  completedAt: string;
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
  /** Use LLM for summarization (default: true). If false, uses romanization. */
  useLLM?: boolean;
}

/** pending/failedタスクのリストアイテム */
export interface TaskListItem {
  kind: 'pending' | 'failed';
  name: string;
  createdAt: string;
  filePath: string;
  content: string;
}
