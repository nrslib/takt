/**
 * Mock module type definitions
 */

import type { Status } from '../../core/models/status.js';
import type { AgentFailureCategory } from '../../shared/types/agent-failure.js';
import type { StreamCallback } from '../../shared/types/provider.js';

/** Options for mock calls */
export interface MockCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  onStream?: StreamCallback;
  allowedTools?: string[];
  /** Fixed response content (optional, defaults to generic mock response) */
  mockResponse?: string;
  /** Fixed status to return (optional, defaults to 'done') */
  mockStatus?: Status;
  /** Structured output payload returned as-is */
  structuredOutput?: Record<string, unknown>;
  /** Error message returned with an error response */
  error?: string;
  /** Machine-readable failure category returned with an error response */
  failureCategory?: AgentFailureCategory;
}

/** A single entry in a mock scenario */
export interface ScenarioEntry {
  /** Persona name to match (optional — if omitted, consumed by call order) */
  persona?: string;
  /** Response status */
  status: Status;
  /** Response content body */
  content: string;
  /** Optional structured output payload (for outputSchema-driven flows) */
  structuredOutput?: Record<string, unknown>;
  /** Optional error message */
  error?: string;
  /** Optional machine-readable failure category */
  failureCategory?: AgentFailureCategory;
  /** Artificial delay in ms before returning (respects abortSignal) */
  delayMs?: number;
}
