import type { McpServerConfig, PermissionMode } from '../../core/models/index.js';
import type { ClaudeEffort } from '../../core/models/workflow-types.js';
import type { PermissionHandler, AskUserQuestionHandler, AskUserQuestionInput } from '../../core/workflow/types.js';
import type { StreamCallback } from '../../shared/types/provider.js';

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
  timeoutMs: number;
  pollIntervalMs: number;
  abortSignal?: AbortSignal;
}

export interface WaitForClaudeResponseOptions {
  session: ClaudeSessionRef;
  baseline: ClaudeTranscriptBaseline;
  cwd: string;
  timeoutMs: number;
  pollIntervalMs: number;
  abortSignal?: AbortSignal;
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
  model?: string;
  effort?: ClaudeEffort;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  bypassPermissions?: boolean;
  backend?: ClaudeTerminalBackendName;
  timeoutMs?: number;
  keepSession?: boolean;
  transcriptPollIntervalMs?: number;
  onStream?: StreamCallback;
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
  model?: string;
  effort?: ClaudeEffort;
  allowedTools?: string[];
  mcpConfigPath?: string;
  permissionMode?: PermissionMode;
  bypassPermissions?: boolean;
  sessionId?: string;
  newSessionId?: string;
  systemPrompt?: string;
  outputSchema?: Record<string, unknown>;
}
