import type { McpServerConfig, PermissionMode } from '../../core/models/index.js';
import type { PermissionHandler, AskUserQuestionHandler, AskUserQuestionInput } from '../../core/workflow/types.js';
import type {
  InternalAgentIsolation,
  ProviderActivityCallback,
  StreamCallback,
} from '../../shared/types/provider.js';

export type ClaudeTerminalBackendName = 'tmux';

export interface ClaudeTerminalCommand {
  executable: string;
  args: string[];
}

export interface TerminalSession {
  id: string;
  name: string;
}

export interface TerminalStartOptions {
  cwd: string;
  backend: ClaudeTerminalBackendName;
  command: ClaudeTerminalCommand;
  childProcessEnv?: Readonly<Record<string, string>>;
}

export interface TerminalBackend {
  start(options: TerminalStartOptions): Promise<TerminalSession>;
  pasteText(session: TerminalSession, text: string): Promise<void>;
  stop(session: TerminalSession): Promise<void>;
}

export type ClaudeTerminalEvent =
  | {
      type: 'tool_use';
      id: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'permission_request';
      tool: string;
      input: Record<string, unknown>;
    }
	  | {
	      type: 'ask_user_question';
	      questions: AskUserQuestionInput['questions'];
	    };

export interface ClaudeTerminalTranscript {
  sessionId: string;
  assistantText: string;
  events: ClaudeTerminalEvent[];
}

export interface ClaudeTranscriptBaseline {
  byteOffset: number;
  lineNumberOffset: number;
}

export interface ClaudeSessionRef {
  sessionId: string;
}

export interface FindClaudeSessionOptions {
  cwd: string;
  sessionId: string;
  /** 互換用。timeoutMs がない直接利用時だけ使う絶対期限。 */
  deadlineAt?: number;
  /** transcript に変化がない時間の上限。変化するたびに更新する。 */
  timeoutMs?: number;
  pollIntervalMs: number;
  abortSignal?: AbortSignal;
  onActivity?: ProviderActivityCallback;
}

export interface WaitForClaudeResponseOptions {
  session: ClaudeSessionRef;
  baseline: ClaudeTranscriptBaseline;
  cwd: string;
  /** 互換用。timeoutMs がない直接利用時だけ使う絶対期限。 */
  deadlineAt?: number;
  /** transcript に変化がない時間の上限。変化するたびに更新する。 */
  timeoutMs?: number;
  pollIntervalMs: number;
  abortSignal?: AbortSignal;
  onActivity?: ProviderActivityCallback;
}

export interface ClaudeTranscriptReader {
  readBaseline(options: Pick<FindClaudeSessionOptions, 'cwd' | 'sessionId'>): Promise<ClaudeTranscriptBaseline>;
  findSession(options: FindClaudeSessionOptions): Promise<ClaudeSessionRef>;
  waitForAssistantResponse(options: WaitForClaudeResponseOptions): Promise<ClaudeTerminalTranscript>;
}

export interface ClaudeTerminalCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  internalAgentIsolation?: InternalAgentIsolation;
  model?: string;
  effort?: string;
  skillsEnabled?: boolean;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  /** Provider-prepared MCP material (issue #1137). */
  preparedMcp?: import('../providers/mcp/types.js').PreparedProviderMcp;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  bypassPermissions?: boolean;
  backend?: ClaudeTerminalBackendName;
  callTimeoutMs?: number;
  /** 互換用。callTimeoutMs が未指定の場合だけ使う。 */
  timeoutMs?: number;
  keepSession?: boolean;
  transcriptPollIntervalMs?: number;
  onStream?: StreamCallback;
  onActivity?: ProviderActivityCallback;
  onPermissionRequest?: PermissionHandler;
  onAskUserQuestion?: AskUserQuestionHandler;
  outputSchema?: Record<string, unknown>;
  systemPrompt?: string;
  pathToClaudeCodeExecutable?: string;
  terminalBackend?: TerminalBackend;
  transcriptReader?: ClaudeTranscriptReader;
  childProcessEnv?: Readonly<Record<string, string>>;
}

export interface BuildClaudeTerminalCommandOptions {
  pathToClaudeCodeExecutable?: string;
  internalAgentIsolation?: InternalAgentIsolation;
  model?: string;
  effort?: string;
  skillsEnabled?: boolean;
  allowedTools?: string[];
  mcpConfigPath?: string;
  permissionMode?: PermissionMode;
  bypassPermissions?: boolean;
  sessionId?: string;
  newSessionId?: string;
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
  /** Provider-prepared MCP args (`--strict-mcp-config`/`--mcp-config`, issue #1137). */
  preparedMcpArgs?: string[];
}
