import type { StreamCallContext } from '../types/provider.js';

export type ToolActivityStatus = 'running' | 'success' | 'failure';

export interface ToolActivityEntry {
  key: string;
  context?: StreamCallContext;
  toolId?: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  result?: string;
  status: ToolActivityStatus;
  association: 'matched' | 'unmatched';
  startedAt?: number;
  completedAt?: number;
  startSequence?: number;
  completionSequence?: number;
}

export interface ToolActivityPage {
  text: string;
  nextOffset: number;
  hasMore: boolean;
  truncated: boolean;
}

export interface ToolActivityProjection {
  key: string;
  tool: string;
  action: string;
  input: string;
  status: ToolActivityStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  result: ToolActivityPage;
}

export interface ToolActivityGroup {
  summary: string;
  entries: ToolActivityProjection[];
}

export type ToolActivityDisplayMode = 'compact' | 'expanded' | 'silent';
