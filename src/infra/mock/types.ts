/**
 * Mock module type definitions
 */

import type { StreamCallback } from '../claude/index.js';

/** Options for mock calls */
export interface MockCallOptions {
  cwd: string;
  sessionId?: string;
  onStream?: StreamCallback;
  /** Fixed response content (optional, defaults to generic mock response) */
  mockResponse?: string;
  /** Fixed status to return (optional, defaults to 'done') */
  mockStatus?: 'done' | 'blocked' | 'error' | 'approved' | 'rejected' | 'improve';
  /** Structured output payload returned as-is */
  structuredOutput?: Record<string, unknown>;
}

/** A single entry in a mock scenario */
export interface ScenarioEntry {
  /** Persona name to match (optional — if omitted, consumed by call order) */
  persona?: string;
  /** Response status */
  status: 'done' | 'blocked' | 'error' | 'approved' | 'rejected' | 'improve';
  /** Response content body */
  content: string;
  /** Optional structured output payload (for outputSchema-driven flows) */
  structuredOutput?: Record<string, unknown>;
}
