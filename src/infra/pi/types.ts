import type { PermissionMode } from '../../core/models/index.js';
import type { PiProviderOptions } from '../../core/models/workflow-provider-options.js';
import type { ProviderImageAttachment } from '../providers/types.js';
import type { StreamCallback } from '../../shared/types/provider.js';

/** Options for one Pi SDK session. */
export interface PiCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  imageAttachments?: ProviderImageAttachment[];
  providerOptions?: PiProviderOptions;
  onStream?: StreamCallback;
  childProcessEnv?: Readonly<Record<string, string>>;
}
