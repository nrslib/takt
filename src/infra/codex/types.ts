/**
 * Type definitions for Codex SDK integration
 */

import type { PermissionMode } from '../../core/models/index.js';
import type { CodexReasoningEffort } from '../../core/models/workflow-types.js';
import type { ProviderImageAttachment } from '../providers/types.js';
import type { ProviderActivityCallback, StreamCallback } from '../../shared/types/provider.js';

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
  reasoningEffort?: CodexReasoningEffort;
  systemPrompt?: string;
  /** Permission mode for sandbox configuration */
  permissionMode?: PermissionMode;
  /** Enable network access for workspace-write sandbox */
  networkAccess?: boolean;
  /** Enable streaming mode with callback (best-effort) */
  onStream?: StreamCallback;
  /** Notify the workflow inactivity deadline immediately before each provider attempt. */
  onActivity?: ProviderActivityCallback;
  /** OpenAI API key (bypasses CLI auth) */
  openaiApiKey?: string;
  /** OpenAI-compatible API base URL */
  baseUrl?: string;
  /** Ambient Codex Skill scopes inherited by this call */
  skills?: {
    repo: boolean;
    user: boolean;
  };
  /** Override path to external Codex CLI binary (bypasses SDK vendored binary) */
  codexPathOverride?: string;
  /** JSON Schema for structured output */
  outputSchema?: Record<string, unknown>;
  imageAttachments?: ProviderImageAttachment[];
  /** Directory for full oversized failure text, written as private 0600 files; omission disables persistence. */
  failureDir?: string;
  childProcessEnv?: Readonly<Record<string, string>>;
}
