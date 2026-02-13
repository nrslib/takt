/**
 * Type definitions for Codex SDK integration
 */

import type { StreamCallback } from '../claude/index.js';
import type { PermissionMode } from '../../core/models/index.js';

/** Codex sandbox mode values */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Map TAKT PermissionMode to Codex sandbox mode */
export function mapToCodexSandboxMode(mode: PermissionMode): CodexSandboxMode {
  const mapping: Record<PermissionMode, CodexSandboxMode> = {
    readonly: 'read-only',
    edit: 'workspace-write',
    full: 'danger-full-access',
  };
  return mapping[mode];
}

/** Options for calling Codex */
export interface CodexCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  /** Permission mode for sandbox configuration */
  permissionMode?: PermissionMode;
  /** Enable network access for workspace-write sandbox */
  networkAccess?: boolean;
  /** Enable streaming mode with callback (best-effort) */
  onStream?: StreamCallback;
  /** OpenAI API key (bypasses CLI auth) */
  openaiApiKey?: string;
  /** JSON Schema for structured output */
  outputSchema?: Record<string, unknown>;
}
