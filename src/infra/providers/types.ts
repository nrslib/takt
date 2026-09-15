import type { AgentResponse, Language, PermissionMode, McpServerConfig, StepProviderOptions } from '../../core/models/index.js';
import type { ProviderType as SharedProviderType } from '../../shared/types/provider.js';
import type {
  InternalAgentIsolation,
  ProviderActivityCallback,
  StreamCallback,
} from '../../shared/types/provider.js';
import type { PermissionHandler, AskUserQuestionHandler } from '../../core/workflow/types.js';
import type { PreparedProviderMcp } from './mcp/types.js';

export interface AgentSetup {
  name: string;
  systemPrompt?: string;
}

export interface ProviderImageAttachment {
  placeholder: string;
  path: string;
}

export interface ProviderCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  internalAgentIsolation?: InternalAgentIsolation;
  model?: string;
  /** Per-call interactive reasoning effort override. */
  effort?: string;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Provider-prepared MCP material (issue #1137). When the resolved MCP server
   * set is non-empty, `AgentRunner` runs `validate` → `prepare` before the
   * provider call and passes the result here so each provider's `toXxxOptions`
   * can merge the provider-specific config (SDK options, CLI args, temp files)
   * into its call. `dispose` is owned by the runner and invoked in a `finally`.
   */
  preparedMcp?: PreparedProviderMcp;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  providerOptions?: StepProviderOptions;
  onStream?: StreamCallback;
  onActivity?: ProviderActivityCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  bypassPermissions?: boolean;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  opencodeApiKey?: string;
  cursorApiKey?: string;
  copilotGithubToken?: string;
  kiroApiKey?: string;
  outputSchema?: Record<string, unknown>;
  language?: Language;
  imageAttachments?: ProviderImageAttachment[];
  /** Directory for full Codex failure text; when omitted, oversized failures are truncated without persistence. */
  failureDir?: string;
  childProcessEnv?: Readonly<Record<string, string>>;
}

export interface ProviderCompactSessionOptions {
  cwd: string;
  sessionId: string;
  model?: string;
  abortSignal?: AbortSignal;
  childProcessEnv?: Readonly<Record<string, string>>;
}

export interface ProviderAgent {
  call(prompt: string, options: ProviderCallOptions): Promise<AgentResponse>;
}

export interface Provider {
  supportsStructuredOutput: boolean;
  /** Whether this provider has a dedicated strict structured execution path. */
  supportsIsolatedStructuredExecution?: boolean;
  /** Whether the regular setup path can guarantee execution with no tools. */
  supportsToolFreeExecution?: boolean;
  supportsNativeImageInput: boolean;
  /**
   * MCP transports this provider implementation actually supports. Replaces
   * the fixed `MCP_SERVER_PROVIDERS` set (issue #1137). An empty/undefined set
   * means MCP is not supported; the engine and adapter use this to fail-fast
   * on unsupported transports instead of silently dropping servers.
   */
  supportedMcpTransports?: ReadonlySet<'stdio' | 'sse' | 'http'>;
  /** Whether runtime MCP mode can suppress ambient MCP configuration. */
  supportsStrictMcpConfig?: boolean;
  getRuntimeInstructions(allowedTools?: string[], permissionMode?: import('../../core/models/index.js').PermissionMode, networkAccess?: boolean): string | null;
  supportsPermissionControls?(): boolean;
  keepsAllowedToolWithoutEdit(tool: string): boolean;
  getDefaultAllowedToolsWithoutEdit?(): readonly string[];
  setup(config: AgentSetup): ProviderAgent;
  setupIsolatedStructured?(config: AgentSetup): ProviderAgent;
  compactSession?(options: ProviderCompactSessionOptions): Promise<void>;
}

export type ProviderType = SharedProviderType;

export function assertOutputSchema(
  schema: Record<string, unknown> | undefined,
  provider: string,
): Record<string, unknown> {
  if (schema === undefined) {
    throw new Error(
      `Provider "${provider}" cannot run isolated structured execution without an output schema`,
    );
  }
  return schema;
}
