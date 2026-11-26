import type { AgentResponse, Language, PermissionMode, McpServerConfig, StepProviderOptions } from '../../core/models/index.js';
import type { AgentErrorKind, ProviderUsageSnapshot, RateLimitInfo } from '../../core/models/response.js';
import type { AgentFailureCategory } from '../../shared/types/agent-failure.js';
import type { ProviderType as SharedProviderType } from '../../shared/types/provider.js';
import type {
  InternalAgentIsolation,
  ProviderActivityCallback,
  StreamCallback,
} from '../../shared/types/provider.js';
import type { PermissionHandler, SkillPermissionHandler, AskUserQuestionHandler } from '../../core/workflow/types.js';
import type { PreparedProviderMcp } from './mcp/types.js';
import type { ContextWindowLimits } from './context-window.js';

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
  /** Effective native override selected for this call. */
  contextWindow?: number;
  /** TAKT-owned external context directories OpenCode may read for this run. */
  openCodeExternalDirectories?: readonly string[];
  /** The caller owns session recovery; provider retries must not replay a turn. */
  callerManagedSession?: true;
  /** Keep supplied prepared MCP alive until the caller finishes all attempts. */
  callerManagedMcp?: true;
  /** Exact tool exposure, with ambient tools, skills and hooks disabled. */
  strictToolAllowlist?: readonly string[];
  /** No direct writes/network; side effects only through these exact local MCP tools. Read is allowed. */
  mcpOnlySideEffects?: readonly string[];
  abortSignal?: AbortSignal;
  sessionId?: string;
  internalAgentIsolation?: InternalAgentIsolation;
  executionPhase?: 1 | 2 | 3;
  /** Current TAKT assignment for a Phase 1 compaction handoff. */
  compactionAssignment?: string;
  /** TAKT-owned private directory for this Phase 1 call's immutable recovery input. */
  compactionHandoffDirectory?: string;
  /** Expose only the built-in Read tool for a strict read-only call. */
  allowReadonlyFileRead?: boolean;
  /** Exact files that the /verify interpretation call may read. */
  readonlyFileReadPaths?: readonly string[];
  model?: string;
  /** Internal workflow capability for resolving an OpenCode runtime default. */
  allowDefaultModel?: boolean;
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
  /** Delegate permission decisions to the provider's AI reviewer, when supported. */
  aiReviewPermissions?: boolean;
  edit?: boolean;
  providerOptions?: StepProviderOptions;
  onStream?: StreamCallback;
  onActivity?: ProviderActivityCallback;
  onPermissionRequest?: PermissionHandler;
  onSkillPermissionRequest?: SkillPermissionHandler;
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
  /** TAKT-owned external context directories OpenCode may read for this run. */
  openCodeExternalDirectories?: readonly string[];
  model?: string;
  /** Internal workflow capability for resolving an OpenCode runtime default. */
  allowDefaultModel?: boolean;
  abortSignal?: AbortSignal;
  childProcessEnv?: Readonly<Record<string, string>>;
  providerOptions?: StepProviderOptions;
}

export interface ProviderAgent {
  call(prompt: string, options: ProviderCallOptions): Promise<AgentResponse>;
  /** Resume the same provider session after a Phase 1 context_compacted event. */
  recoverFromCompaction?(prompt: string, options: ProviderCallOptions): Promise<AgentResponse>;
  /** Codex-only semantic check for a completed Phase 1 response after compaction. */
  assessCompactedResponse?(
    instruction: string,
    response: AgentResponse,
    options: ProviderCallOptions,
  ): Promise<{
    decision: 'complete' | 'needs_recovery' | 'error';
    error?: string;
    failureCategory?: AgentFailureCategory;
    /** Set with rateLimitInfo when the assessment call itself was rate limited. */
    errorKind?: AgentErrorKind;
    rateLimitInfo?: RateLimitInfo;
    usage?: ProviderUsageSnapshot;
  }>;
}

export interface Provider {
  supportsStructuredOutput: boolean;
  /** Exact Read + explicitly named local MCP tools, without shell/edit/web access. */
  supportsStrictToolAllowlist?: boolean;
  /** Enforces mcpOnlySideEffects via tool restrictions or a readonly, offline sandbox. */
  supportsMcpOnlySideEffects?: boolean;
  /** Whether this provider has a dedicated strict structured execution path. */
  supportsIsolatedStructuredExecution?: boolean;
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
  getRuntimeInstructions(allowedTools?: string[], permissionMode?: import('../../core/models/index.js').PermissionMode, networkAccess?: boolean, callOptions?: ProviderCallOptions): string | null;
  supportsPermissionControls?(): boolean;
  keepsAllowedToolWithoutEdit(tool: string): boolean;
  getDefaultAllowedToolsWithoutEdit?(): readonly string[];
  /** Verify runtime requirements before opening a session; omission means no startup checks are needed. */
  preflight?(options: ProviderCallOptions): Promise<void>;
  getContextWindowLimits?(options: ProviderCallOptions): Promise<ContextWindowLimits | undefined>;
  setup(config: AgentSetup): ProviderAgent;
  setupIsolatedStructured?(config: AgentSetup): ProviderAgent;
  /** Resolves only when the session is safe to reuse; rejects on failure or unknown state. */
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
