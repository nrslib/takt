import type { WorkflowEffect, WorkflowState, WorkflowStep } from '../../models/types.js';

export interface SystemStepTaskContext {
  readonly issueNumber?: number;
  readonly runSlug?: string;
}

export interface SystemStepRuntimeState {
  readonly cache: Map<string, unknown>;
  readonly cleanupHandlers: Set<() => void>;
}

export type SystemStepCliStatus =
  | { available: true }
  | { available: false; error: string };

export interface SystemStepIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: Array<{ author: string; body: string }>;
}

export interface SystemStepExistingPr {
  number: number;
  url: string;
}

export interface SystemStepIssueListItem {
  number: number;
  title: string;
  labels: string[];
  updated_at: string;
}

export interface SystemStepPrListItem {
  number: number;
  author: string;
  base_branch: string;
  head_branch: string;
  managed_by_takt: boolean;
  labels: string[];
  same_repository: boolean;
  draft: boolean;
  updated_at: string;
}

export interface SystemStepCreateIssueOptions {
  title: string;
  body: string;
  labels?: string[];
}

export type SystemStepCreateIssueResult =
  | { success: true; issueNumber: number; url?: string }
  | { success: false; error: string };

export type SystemStepCloseIssueResult =
  | { success: true; commentCreated?: boolean }
  | { success: false; error: string; commentCreated?: boolean };

export interface SystemStepCommentResult {
  success: boolean;
  error?: string;
}

export interface SystemStepMergeResult {
  success: boolean;
  error?: string;
}

export interface SystemStepPrReviewComment {
  author: string;
  body: string;
  path?: string;
  line?: number;
  url?: string;
  threadState?: 'active' | 'outdated-unresolved' | 'resolved';
  resolvedBy?: string;
  isOutdated?: boolean;
}

export interface SystemStepPrReviewData {
  number: number;
  title: string;
  body: string;
  url: string;
  headRefName: string;
  baseRefName?: string;
  comments: SystemStepPrReviewComment[];
  reviews: SystemStepPrReviewComment[];
  files: string[];
}

export interface SystemStepGitProvider {
  checkCliStatus(cwd?: string): SystemStepCliStatus;
  fetchIssue(issueNumber: number, cwd?: string): SystemStepIssue;
  createIssue(options: SystemStepCreateIssueOptions, cwd?: string): SystemStepCreateIssueResult;
  closeIssue(issueNumber: number, comment: string, cwd?: string): SystemStepCloseIssueResult;
  fetchPrReviewComments(prNumber: number, cwd?: string): SystemStepPrReviewData;
  listOpenIssues(cwd?: string): SystemStepIssueListItem[];
  listOpenPrs(cwd?: string): SystemStepPrListItem[];
  findExistingPr(branch: string, cwd?: string): SystemStepExistingPr | undefined;
  commentOnPr(prNumber: number, body: string, cwd?: string): SystemStepCommentResult;
  closePr(prNumber: number, cwd?: string): SystemStepMergeResult;
  mergePr(prNumber: number, cwd?: string): SystemStepMergeResult;
}

export interface SystemStepServicesOptions {
  readonly cwd: string;
  readonly projectCwd: string;
  readonly task: string;
  readonly taskContext?: SystemStepTaskContext;
  readonly runtimeState?: SystemStepRuntimeState;
  readonly gitProvider?: SystemStepGitProvider;
}

export interface SystemStepInputResolutionContext {
  readonly cache: Map<string, unknown>;
  readonly resolvedBindings: Map<string, unknown>;
}

export interface SystemStepServices {
  resolveSystemInput(
    input: NonNullable<WorkflowStep['systemInputs']>[number],
    state?: WorkflowState,
    stepName?: string,
    resolutionContext?: SystemStepInputResolutionContext,
  ): unknown;
  executeEffect(
    effect: WorkflowEffect,
    payload: Record<string, unknown>,
    state: WorkflowState,
  ): Promise<Record<string, unknown>>;
}

export type SystemStepServicesFactory = (options: SystemStepServicesOptions) => SystemStepServices;
