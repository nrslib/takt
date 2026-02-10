/**
 * Type definitions for OpenCode SDK integration
 */

import type { StreamCallback } from '../claude/index.js';
import type { PermissionMode } from '../../core/models/index.js';

/** OpenCode permission reply values */
export type OpenCodePermissionReply = 'once' | 'always' | 'reject';

/** Map TAKT PermissionMode to OpenCode permission reply */
export function mapToOpenCodePermissionReply(mode: PermissionMode): OpenCodePermissionReply {
  const mapping: Record<PermissionMode, OpenCodePermissionReply> = {
    readonly: 'reject',
    edit: 'once',
    full: 'always',
  };
  return mapping[mode];
}

/** Options for calling OpenCode */
export interface OpenCodeCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  /** Permission mode for automatic permission handling */
  permissionMode?: PermissionMode;
  /** Enable streaming mode with callback (best-effort) */
  onStream?: StreamCallback;
  /** OpenCode API key */
  opencodeApiKey?: string;
}
