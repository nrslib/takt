import type { AgentFailureCategory } from './agent-failure.js';

export const PROVIDER_TYPES = [
  'claude',
  'claude-sdk',
  'claude-terminal',
  'codex',
  'opencode',
  'cursor',
  'copilot',
  'kiro',
  'mock',
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

const PROVIDER_TYPE_SET: ReadonlySet<string> = new Set(PROVIDER_TYPES);

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && PROVIDER_TYPE_SET.has(value);
}

export interface StreamInitEventData {
  model: string;
  sessionId: string;
}

export interface StreamToolUseEventData {
  tool: string;
  input: Record<string, unknown>;
  id: string;
}

export interface StreamToolResultEventData {
  content: string;
  isError: boolean;
}

export interface StreamToolOutputEventData {
  tool: string;
  output: string;
}

export interface StreamPermissionAskedEventData {
  requestId: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  always: string[];
  reply: string;
}

export interface StreamPermissionSummaryEventData {
  sessionId: string;
  permissionMode?: string;
  allowedTools?: readonly string[];
  networkAccess?: boolean;
  resolvedPermissions: Array<{
    permission: string;
    pattern: string;
    action: string;
  }>;
}

export interface StreamTextEventData {
  text: string;
}

export interface StreamThinkingEventData {
  thinking: string;
}

export interface StreamResultEventData {
  result: string;
  sessionId: string;
  success: boolean;
  error?: string;
  failureCategory?: AgentFailureCategory;
}

export interface StreamErrorEventData {
  message: string;
  raw?: string;
}

export interface StreamAssistantErrorEventData {
  error: string;
  sessionId: string;
}

export interface StreamRateLimitEventData {
  sessionId: string;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  rateLimitType?: string;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageDisabledReason?: string;
  resetsAt?: number;
  overageResetsAt?: number;
  isUsingOverage?: boolean;
}

export type StreamEvent =
  | { type: 'init'; data: StreamInitEventData }
  | { type: 'tool_use'; data: StreamToolUseEventData }
  | { type: 'tool_result'; data: StreamToolResultEventData }
  | { type: 'tool_output'; data: StreamToolOutputEventData }
  | { type: 'permission_asked'; data: StreamPermissionAskedEventData }
  | { type: 'permission_summary'; data: StreamPermissionSummaryEventData }
  | { type: 'text'; data: StreamTextEventData }
  | { type: 'thinking'; data: StreamThinkingEventData }
  | { type: 'result'; data: StreamResultEventData }
  | { type: 'assistant_error'; data: StreamAssistantErrorEventData }
  | { type: 'rate_limit'; data: StreamRateLimitEventData }
  | { type: 'error'; data: StreamErrorEventData };

export type StreamCallback = (event: StreamEvent) => void;
