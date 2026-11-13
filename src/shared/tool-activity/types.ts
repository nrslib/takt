import type { StreamCallContext, StreamEvent } from '../types/provider.js';

export type ToolActivityEvent = Extract<StreamEvent, { type: 'tool_use' | 'tool_result' | 'tool_output' }>;

export interface ToolActivityHistoryState {
  entries: ToolActivityEntry[];
  sequence: number;
}

export interface ToolActivityTurnState {
  operationId: string;
  generation: number;
  finished: boolean;
  history: ToolActivityHistoryState;
}

/**
 * 1 件のツールイベントで変わった entry。previousSequence の状態に適用すると sequence の状態になる。
 * entries を置き換えた後、output があればその entry の出力へ text を追記する。
 */
export interface ToolActivityTurnUpdate {
  operationId: string;
  generation: number;
  previousSequence: number;
  sequence: number;
  entries: ToolActivityEntry[];
  /** 実行中の entry の出力に追記する、秘密値をマスク済みの確定したテキスト。 */
  output?: { key: string; text: string };
}

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
  startSequence?: number;
  completionSequence?: number;
  durationMs?: number;
  result: ToolActivityPage;
}

export interface ToolActivityGroup {
  summary: string;
  entries: ToolActivityProjection[];
}

export type ToolActivityDisplayMode = 'compact' | 'expanded' | 'silent';
