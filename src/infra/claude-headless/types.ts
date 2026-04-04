import type { PermissionMode } from '../../core/models/index.js';
import type { MovementProviderOptions } from '../../core/models/piece-types.js';
import type { StreamCallback } from '../../shared/types/provider.js';

export interface ClaudeHeadlessCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  allowedTools?: string[];
  permissionMode?: PermissionMode;
  bypassPermissions?: boolean;
  providerOptions?: MovementProviderOptions;
  onStream?: StreamCallback;
  claudeCliPath?: string;
  systemPrompt?: string;
}
