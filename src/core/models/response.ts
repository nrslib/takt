/**
 * Agent response and session state types
 */

import type { Status, RuleMatchMethod } from './status.js';

export interface ProviderUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  usageMissing: boolean;
  reason?: string;
}

/** Response from an agent execution */
export interface AgentResponse {
  persona: string;
  status: Status;
  content: string;
  timestamp: Date;
  sessionId?: string;
  /** Error message when the query failed (e.g., API error, rate limit) */
  error?: string;
  /** Matched rule index (0-based) when rules-based detection was used */
  matchedRuleIndex?: number;
  /** How the rule match was detected */
  matchedRuleMethod?: RuleMatchMethod;
  /** Structured output returned by provider SDK (JSON Schema mode) */
  structuredOutput?: Record<string, unknown>;
  /** Provider-native usage payload normalized for TAKT observability */
  providerUsage?: ProviderUsageSnapshot;
}
